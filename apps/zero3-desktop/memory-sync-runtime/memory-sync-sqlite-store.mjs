import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function now() { return new Date().toISOString() }
function nonEmpty(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}
function parsePayload(text) { return JSON.parse(text) }

export function createSqliteMemorySyncStore(databasePath) {
  const file = path.resolve(nonEmpty(databasePath, 'memory sync database path'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pending_memory_events (
      event_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      server_sequence INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_memory_state
      ON pending_memory_events(state, created_at);
    CREATE TABLE IF NOT EXISTS memory_sync_state (
      client_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server_memory_events (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `)

  const getCursorStmt = db.prepare(
    'SELECT client_id, device_id, last_sequence, updated_at FROM memory_sync_state WHERE client_id = ?'
  )
  const setCursorStmt = db.prepare(`
    INSERT INTO memory_sync_state (client_id, device_id, last_sequence, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET
      device_id = excluded.device_id,
      last_sequence = MAX(memory_sync_state.last_sequence, excluded.last_sequence),
      updated_at = excluded.updated_at
  `)
  const cacheStmt = db.prepare(`
    INSERT OR IGNORE INTO server_memory_events
      (sequence, event_id, payload_json, received_at)
    VALUES (?, ?, ?, ?)
  `)
  const enqueueStmt = db.prepare(`
    INSERT OR IGNORE INTO pending_memory_events
      (event_id, payload_json, state, retry_count, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?)
  `)
  const nextStmt = db.prepare(`
    SELECT event_id, payload_json, state, retry_count, last_error, server_sequence,
           created_at, updated_at
    FROM pending_memory_events
    WHERE state = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `)
  const markSendingStmt = db.prepare(`
    UPDATE pending_memory_events
    SET state='sending', retry_count=retry_count+1, updated_at=?
    WHERE event_id=? AND state='pending'
  `)
  const markAckedStmt = db.prepare(`
    UPDATE pending_memory_events
    SET state='acked', server_sequence=?, last_error=NULL, updated_at=?
    WHERE event_id=?
  `)
  const markTerminalStmt = db.prepare(`
    UPDATE pending_memory_events
    SET state=?, last_error=?, updated_at=?
    WHERE event_id=?
  `)
  const resetInflightStmt = db.prepare(`
    UPDATE pending_memory_events
    SET state='pending', updated_at=?
    WHERE state='sending'
  `)
  const unsettledStmt = db.prepare(`
    SELECT event_id, payload_json, state, retry_count, last_error, server_sequence,
           created_at, updated_at
    FROM pending_memory_events
    WHERE state IN ('pending','sending')
    ORDER BY created_at ASC
    LIMIT ?
  `)
  const replacePendingStmt = db.prepare(`
    UPDATE pending_memory_events SET payload_json=?, updated_at=?
    WHERE event_id=? AND state='pending'
  `)

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = action()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  return {
    async enqueue(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('memory event must be an object')
      const eventId = nonEmpty(event.event_id, 'event.event_id')
      const at = now()
      return enqueueStmt.run(eventId, JSON.stringify(event), at, at).changes > 0
    },
    async getCursor(clientId) {
      return getCursorStmt.get(nonEmpty(clientId, 'clientId')) ?? null
    },
    async setCursor(clientId, deviceId, sequence) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('sequence must be a non-negative integer')
      setCursorStmt.run(nonEmpty(clientId, 'clientId'), nonEmpty(deviceId, 'deviceId'), sequence, now())
    },
    async cacheServerEvent(sequence, eventId, event) {
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('sequence must be positive')
      return cacheStmt.run(sequence, nonEmpty(eventId, 'eventId'), JSON.stringify(event), now()).changes > 0
    },
    async nextBatch(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) return []
      return nextStmt.all(limit).map(row => ({
        event_id: row.event_id,
        payload: parsePayload(row.payload_json),
        state: row.state,
        retry_count: row.retry_count,
        last_error: row.last_error,
        server_sequence: row.server_sequence,
        created_at: row.created_at,
        updated_at: row.updated_at
      }))
    },
    async unsettled(limit = 500) {
      if (!Number.isSafeInteger(limit) || limit < 1) return []
      return unsettledStmt.all(limit).map(row => ({
        event_id: row.event_id,
        payload: parsePayload(row.payload_json),
        state: row.state,
        retry_count: row.retry_count,
        last_error: row.last_error,
        server_sequence: row.server_sequence,
        created_at: row.created_at,
        updated_at: row.updated_at
      }))
    },
    async replacePending(eventId, event) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('memory event must be an object')
      return replacePendingStmt.run(JSON.stringify(event), now(), nonEmpty(eventId, 'eventId')).changes > 0
    },
    async markSending(ids) {
      const list = Array.isArray(ids) ? ids : []
      return transaction(() => {
        let changed = 0
        const at = now()
        for (const id of list) changed += Number(markSendingStmt.run(at, nonEmpty(id, 'eventId')).changes)
        return changed
      })
    },
    async markAcked(eventId, sequence) {
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('sequence must be positive')
      return markAckedStmt.run(sequence, now(), nonEmpty(eventId, 'eventId')).changes > 0
    },
    async markConflict(eventId, error) {
      return markTerminalStmt.run('conflict', String(error ?? 'memory_conflict'), now(), nonEmpty(eventId, 'eventId')).changes > 0
    },
    async markRejected(eventId, error) {
      return markTerminalStmt.run('rejected', String(error ?? 'memory_event_rejected'), now(), nonEmpty(eventId, 'eventId')).changes > 0
    },
    async resetInflight() {
      return Number(resetInflightStmt.run(now()).changes)
    },
    async pendingCount() {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM pending_memory_events WHERE state IN ('pending','sending')").get().n)
    },
    close() { db.close() }
  }
}

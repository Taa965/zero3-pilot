import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Implements the MemorySyncClient port with the same queue/cursor schema as
// zero3-memory's Rust SqliteSyncQueue. Use a dedicated database per subscription.
export class SqliteMemorySyncStore {
  #db
  #owner = randomUUID()
  constructor(filename) {
    if (filename !== ':memory:') {
      if (!path.isAbsolute(filename)) throw new Error('memory database path must be absolute')
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
      fs.closeSync(fs.openSync(filename, 'a', 0o600))
    }
    this.#db = new DatabaseSync(filename)
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS pending_memory_events (
        event_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, state TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, server_sequence INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_sync_state (
        client_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, last_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS server_memory_events (
        sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_context_cache (project_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);`)
    if (!this.#db.prepare('PRAGMA table_info(pending_memory_events)').all().some(column => column.name === 'sender')) {
      this.#db.exec('ALTER TABLE pending_memory_events ADD COLUMN sender TEXT')
    }
  }
  close() { this.#db.close() }
  enqueue(event) {
    if (!event?.event_id) throw new Error('event_id is required')
    const current = this.#db.prepare('SELECT payload_json FROM pending_memory_events WHERE event_id=?').get(event.event_id)
    const payload = JSON.stringify(event)
    if (current && current.payload_json !== payload) throw new Error('event_id already belongs to a different payload')
    const now = new Date().toISOString()
    return this.#db.prepare("INSERT OR IGNORE INTO pending_memory_events (event_id,payload_json,state,created_at,updated_at) VALUES (?,?,'pending',?,?)").run(event.event_id, payload, now, now).changes > 0
  }
  nextBatch(limit) {
    const batch = []
    let bytes = 0
    for (const { payload_json, ...row } of this.#db.prepare("SELECT * FROM pending_memory_events WHERE state='pending' ORDER BY rowid LIMIT ?").all(limit)) {
      bytes += Buffer.byteLength(payload_json) + 1
      if (batch.length && bytes > 1536 * 1024) break
      batch.push({ ...row, payload: JSON.parse(payload_json) })
    }
    return batch
  }
  markSending(ids) {
    const stmt = this.#db.prepare("UPDATE pending_memory_events SET state='sending',sender=?,retry_count=retry_count+1,updated_at=? WHERE event_id=? AND state='pending'")
    for (const id of ids) stmt.run(this.#owner, new Date().toISOString(), id)
  }
  claimBatch(limit) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare("UPDATE pending_memory_events SET state='pending',sender=NULL WHERE state='sending' AND updated_at < ?")
        .run(new Date(Date.now() - 60000).toISOString())
      const batch = this.nextBatch(limit)
      this.markSending(batch.map(row => row.event_id))
      this.#db.exec('COMMIT')
      return batch
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  markAcked(id, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid server sequence')
    this.#db.prepare("UPDATE pending_memory_events SET state='acked',server_sequence=?,last_error=NULL,updated_at=? WHERE event_id=?").run(sequence, new Date().toISOString(), id)
  }
  #terminal(id, state, error) {
    this.#db.prepare("UPDATE pending_memory_events SET state=?,last_error=?,updated_at=? WHERE event_id=? AND state!='acked'").run(state, error, new Date().toISOString(), id)
  }
  markConflict(id, error) { this.#terminal(id, 'conflict', error) }
  markRejected(id, error) { this.#terminal(id, 'rejected', error) }
  resetInflight() {
    this.#db.prepare("UPDATE pending_memory_events SET state='pending',sender=NULL WHERE state='sending' AND (sender=? OR updated_at < ?)")
      .run(this.#owner, new Date(Date.now() - 60000).toISOString())
  }
  getCursor(clientId) { return this.#db.prepare('SELECT * FROM memory_sync_state WHERE client_id=?').get(clientId) ?? null }
  setCursor(clientId, deviceId, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid cursor')
    this.#db.prepare(`INSERT INTO memory_sync_state VALUES (?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET
      device_id=excluded.device_id,last_sequence=MAX(last_sequence,excluded.last_sequence),updated_at=excluded.updated_at`)
      .run(clientId, deviceId, sequence, new Date().toISOString())
  }
  cacheServerEvent(sequence, eventId, event) {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !eventId) throw new Error('invalid committed event')
    const existing = this.#db.prepare('SELECT sequence,event_id,payload_json FROM server_memory_events WHERE sequence=? OR event_id=?').get(sequence, eventId)
    if (existing && (existing.sequence !== sequence || existing.event_id !== eventId)) throw new Error('server event identity conflict')
    if (existing && existing.payload_json !== JSON.stringify(event)) throw new Error('server event payload conflict')
    this.#db.prepare('INSERT OR IGNORE INTO server_memory_events VALUES (?,?,?,?)').run(sequence, eventId, JSON.stringify(event), new Date().toISOString())
  }
  cachedEvents() { return this.#db.prepare('SELECT sequence,payload_json FROM server_memory_events ORDER BY sequence').all().map(row => ({ sequence: row.sequence, event: JSON.parse(row.payload_json) })) }
  cacheContext(context) { this.#db.prepare('INSERT INTO memory_context_cache VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET payload_json=excluded.payload_json').run(context.projectId, JSON.stringify(context)) }
  getContext(projectId) { const row = this.#db.prepare('SELECT payload_json FROM memory_context_cache WHERE project_id=?').get(projectId); return row ? JSON.parse(row.payload_json) : null }
  status(eventId) { return this.#db.prepare('SELECT event_id,state,retry_count,last_error,server_sequence FROM pending_memory_events WHERE event_id=?').get(eventId) ?? null }
  counts() { return Object.fromEntries(this.#db.prepare('SELECT state,COUNT(*) AS count FROM pending_memory_events GROUP BY state').all().map(row => [row.state, row.count])) }
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const STORE_SCHEMA = 'zero3.native-session-state.v2'
const MAX_STATE_BYTES = 8 * 1024 * 1024

function sessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('logicalSessionId is required')
  return value.trim()
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('session revision must be a non-negative integer')
  return value
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function fileName(logicalSessionId) {
  return createHash('sha256').update(logicalSessionId).digest('hex') + '.json'
}
function validateEnvelope(value, logicalSessionId) {
  const envelope = record(value)
  if (!envelope || envelope.schema !== STORE_SCHEMA || envelope.logicalSessionId !== logicalSessionId) throw new Error('invalid persisted Zero3 session envelope')
  const state = record(envelope.state)
  if (!state || state.schemaVersion !== 2 || !Number.isSafeInteger(state.migrationVersion) || state.migrationVersion < 1) throw new Error('invalid persisted Zero3 session schema')
  if (revision(envelope.revision) !== revision(state.revision)) throw new Error('persisted Zero3 session revision mismatch')
  return envelope
}

export class Zero3SessionStateStore {
  constructor({ rootDir }) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new Error('session store rootDir is required')
    this.rootDir = path.resolve(rootDir)
    this.writeChains = new Map()
  }

  file(logicalSessionId) {
    return path.join(this.rootDir, fileName(sessionId(logicalSessionId)))
  }

  async read(logicalSessionIdValue) {
    const logicalSessionId = sessionId(logicalSessionIdValue)
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(logicalSessionId), 'utf8'))
      return validateEnvelope(parsed, logicalSessionId)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  async write(input) {
    const logicalSessionId = sessionId(input?.logicalSessionId)
    const incomingRevision = revision(input?.revision)
    const state = record(input?.state)
    if (!state || state.schemaVersion !== 2 || state.migrationVersion !== 1 || state.revision !== incomingRevision) throw new Error('invalid Zero3 session state payload')
    const serializedState = JSON.stringify(state)
    if (Buffer.byteLength(serializedState, 'utf8') > MAX_STATE_BYTES) throw new Error('Zero3 session state exceeds 8 MiB')
    const previous = this.writeChains.get(logicalSessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      const current = await this.read(logicalSessionId)
      if (current && current.revision > incomingRevision) return current
      if (current && current.revision === incomingRevision) {
        if (JSON.stringify(current.state) !== serializedState) throw new Error('Zero3 session revision conflict')
        return current
      }
      const envelope = { schema: STORE_SCHEMA, schemaVersion: 2, migrationVersion: 1, logicalSessionId, revision: incomingRevision, updatedAt: new Date().toISOString(), state }
      const serialized = JSON.stringify(envelope, null, 2) + '\n'
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
      const target = this.file(logicalSessionId)
      const temporary = target + '.tmp-' + process.pid + '-' + randomUUID()
      await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, target)
      return envelope
    })
    this.writeChains.set(logicalSessionId, next)
    try { return await next }
    finally { if (this.writeChains.get(logicalSessionId) === next) this.writeChains.delete(logicalSessionId) }
  }

  async close() {
    await Promise.allSettled([...this.writeChains.values()])
  }
}

export const zero3SessionStateStoreSchema = STORE_SCHEMA

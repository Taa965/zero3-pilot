import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
const MAX_BATCH_SIZE = 100
const MAX_JSON_BYTES = 256 * 1024
const DEFAULT_LEASE_SECONDS = 30 * 60

function iso(value = new Date()) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString() }
function assertId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value.trim())) throw new Error(`${label} is invalid`)
  return value.trim()
}
function assertText(value, label, max = 4096, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const text = value.trim()
  if ((required && !text) || text.length > max) throw new Error(`${label} is invalid`)
  return text
}
function assertInt(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return value
}
function jsonText(value, label, maxBytes = MAX_JSON_BYTES) {
  const text = JSON.stringify(value ?? null)
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  return text
}
function parseJson(value, fallback = null) { return value == null ? fallback : JSON.parse(value) }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
function requestHash(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex') }
function plusSeconds(timestamp, seconds) { return new Date(new Date(timestamp).getTime() + seconds * 1000).toISOString() }
function normalizeCapability(value) { return assertId(value, 'capability') }
function uniqueStrings(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  const normalized = values.map(value => assertId(value, `${label} item`))
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`)
  return normalized
}
function uniqueTexts(values, label, max = 2048) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  const normalized = values.map(value => assertText(value, `${label} item`, max, true))
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`)
  return normalized
}

function openDatabase(filename) {
  if (filename !== ':memory:') {
    if (!path.isAbsolute(filename)) throw new Error('worker database path must be absolute')
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    fs.closeSync(fs.openSync(filename, 'a', 0o600))
  }
  const db = new DatabaseSync(filename)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS worker_stages (
      task_id TEXT NOT NULL, step_id TEXT NOT NULL, assignment_id TEXT NOT NULL UNIQUE,
      required_capability TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'READY', metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id, step_id));
    CREATE TABLE IF NOT EXISTS work_units (
      task_id TEXT NOT NULL, step_id TEXT NOT NULL, unit_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      title TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'AVAILABLE', claim_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, last_error TEXT,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(task_id, step_id, unit_id));
    CREATE INDEX IF NOT EXISTS idx_work_units_available ON work_units(task_id, step_id, status, ordinal, unit_id);
    CREATE TABLE IF NOT EXISTS workers (
      worker_id TEXT PRIMARY KEY, worker_type TEXT NOT NULL, capabilities_json TEXT NOT NULL,
      max_batch_size INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_sessions (
      session_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, task_id TEXT NOT NULL, step_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL, logical_session_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ACTIVE',
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_worker_sessions_assignment ON worker_sessions(assignment_id, state);
    CREATE TABLE IF NOT EXISTS claims (
      claim_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, lease_until TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_claims_active ON claims(task_id, step_id, status, lease_until);
    CREATE TABLE IF NOT EXISTS claim_units (
      claim_id TEXT NOT NULL, task_id TEXT NOT NULL, step_id TEXT NOT NULL, unit_id TEXT NOT NULL,
      PRIMARY KEY(claim_id, unit_id));
    CREATE TABLE IF NOT EXISTS worker_idempotency (
      scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key, idempotency_key));
    CREATE TABLE IF NOT EXISTS worker_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
      step_id TEXT NOT NULL, assignment_id TEXT, worker_id TEXT, session_id TEXT, claim_id TEXT,
      type TEXT NOT NULL, payload_json TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_worker_events_task ON worker_events(task_id, step_id, sequence);`)
  return db
}

export class Zero3WorkerProtocol {
  #db
  #clock
  #defaultLeaseSeconds

  constructor(filename, options = {}) {
    this.#db = openDatabase(filename)
    this.#clock = typeof options.clock === 'function' ? options.clock : () => new Date()
    this.#defaultLeaseSeconds = options.defaultLeaseSeconds == null
      ? DEFAULT_LEASE_SECONDS
      : assertInt(options.defaultLeaseSeconds, 'defaultLeaseSeconds', 1, 86_400)
  }

  close() { this.#db.close() }
  #now() { return iso(this.#clock()) }
  #transaction(run) {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.#db.exec('COMMIT'); return result }
    catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  #event(input) {
    this.#db.prepare(`INSERT INTO worker_events
      (event_id,task_id,step_id,assignment_id,worker_id,session_id,claim_id,type,payload_json,at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      `wevt-${randomUUID()}`, input.taskId, input.stepId, input.assignmentId ?? null,
      input.workerId ?? null, input.sessionId ?? null, input.claimId ?? null, input.type,
      jsonText(input.payload ?? {}, 'worker event payload'), input.at ?? this.#now())
  }
  #idempotent(scopeKey, idempotencyKey, operation, input, run) {
    const key = assertId(idempotencyKey, 'idempotencyKey')
    const hash = requestHash(input)
    const existing = this.#db.prepare('SELECT operation,request_hash,response_json FROM worker_idempotency WHERE scope_key=? AND idempotency_key=?').get(scopeKey, key)
    if (existing) {
      if (existing.operation !== operation || existing.request_hash !== hash) throw new Error('idempotency key was reused with a different request')
      return parseJson(existing.response_json)
    }
    const result = run()
    this.#db.prepare('INSERT INTO worker_idempotency (scope_key,idempotency_key,operation,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(scopeKey, key, operation, hash, jsonText(result, 'idempotency response'), this.#now())
    return result
  }

  ensureStage(input) {
    const taskId = assertId(input.taskId, 'taskId')
    const stepId = assertId(input.stepId, 'stepId')
    const assignmentId = assertId(input.assignmentId, 'assignmentId')
    const requiredCapability = normalizeCapability(input.requiredCapability)
    const metadata = input.metadata ?? {}
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT * FROM worker_stages WHERE task_id=? AND step_id=?').get(taskId, stepId)
      if (existing) {
        if (existing.assignment_id !== assignmentId || existing.required_capability !== requiredCapability) throw new Error('worker stage identity conflicts with existing stage')
        return this.#stageView(taskId, stepId)
      }
      const at = this.#now()
      this.#db.prepare(`INSERT INTO worker_stages
        (task_id,step_id,assignment_id,required_capability,status,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?, 'READY', ?,?,?)`).run(taskId, stepId, assignmentId, requiredCapability, jsonText(metadata, 'stage metadata'), at, at)
      this.#event({ taskId, stepId, assignmentId, type: 'stage.created', payload: { requiredCapability }, at })
      return this.#stageView(taskId, stepId)
    })
  }

  addWorkUnits(input) {
    const taskId = assertId(input.taskId, 'taskId')
    const stepId = assertId(input.stepId, 'stepId')
    if (!Array.isArray(input.units) || input.units.length === 0 || input.units.length > 100_000) throw new Error('units must contain 1..100000 items')
    return this.#transaction(() => {
      const stage = this.#requireStage(taskId, stepId)
      const maxRow = this.#db.prepare('SELECT COALESCE(MAX(ordinal),0) AS value FROM work_units WHERE task_id=? AND step_id=?').get(taskId, stepId)
      let nextOrdinal = Number(maxRow.value) + 1
      let added = 0
      for (const raw of input.units) {
        const unitId = assertId(raw.unitId, 'unitId')
        const ordinal = raw.ordinal == null ? nextOrdinal++ : assertInt(raw.ordinal, 'ordinal', 1, 2_147_483_647)
        const title = assertText(raw.title ?? unitId, 'unit title', 1024, true)
        const payload = raw.payload ?? {}
        const maxAttempts = raw.maxAttempts == null ? 3 : assertInt(raw.maxAttempts, 'maxAttempts', 1, 100)
        const current = this.#db.prepare('SELECT ordinal,title,payload_json,max_attempts FROM work_units WHERE task_id=? AND step_id=? AND unit_id=?').get(taskId, stepId, unitId)
        if (current) {
          if (Number(current.ordinal) !== ordinal || current.title !== title || current.payload_json !== jsonText(payload, 'unit payload') || Number(current.max_attempts) !== maxAttempts) {
            throw new Error(`work unit ${unitId} conflicts with existing definition`)
          }
          continue
        }
        const at = this.#now()
        this.#db.prepare(`INSERT INTO work_units
          (task_id,step_id,unit_id,ordinal,title,payload_json,status,max_attempts,created_at,updated_at)
          VALUES (?,?,?,?,?,?, 'AVAILABLE', ?,?,?)`).run(taskId, stepId, unitId, ordinal, title, jsonText(payload, 'unit payload'), maxAttempts, at, at)
        added += 1
      }
      if (added > 0 && stage.status === 'WORK_COMPLETE') {
        this.#db.prepare("UPDATE worker_stages SET status='READY',updated_at=? WHERE task_id=? AND step_id=?").run(this.#now(), taskId, stepId)
      }
      this.#event({ taskId, stepId, assignmentId: stage.assignment_id, type: 'work_units.added', payload: { added, totalRequested: input.units.length } })
      return { added, ...this.#counts(taskId, stepId) }
    })
  }

  registerWorker(input) {
    const taskId = assertId(input.taskId, 'taskId')
    const stepId = assertId(input.stepId, 'stepId')
    const assignmentId = assertId(input.assignmentId, 'assignmentId')
    const workerType = assertId(input.workerType, 'workerType')
    const capabilities = uniqueStrings(input.capabilities, 'capabilities')
    const maxBatchSize = assertInt(input.maxBatchSize, 'maxBatchSize', 1, MAX_BATCH_SIZE)
    const logicalSessionId = assertText(input.logicalSessionId ?? `logical-${randomUUID()}`, 'logicalSessionId', 512, true)
    const clean = { taskId, stepId, assignmentId, workerType, capabilities, maxBatchSize, logicalSessionId, metadata: input.metadata ?? {} }
    return this.#transaction(() => this.#idempotent(`assignment:${assignmentId}`, input.idempotencyKey, 'register_worker', clean, () => {
      const stage = this.#requireStage(taskId, stepId)
      if (stage.assignment_id !== assignmentId) throw new Error('assignment does not own this worker stage')
      if (!capabilities.includes(stage.required_capability)) throw new Error(`worker lacks required capability ${stage.required_capability}`)
      const workerId = `wrk-${randomUUID()}`
      const sessionId = `ws-${randomUUID()}`
      const at = this.#now()
      this.#db.prepare('INSERT INTO workers (worker_id,worker_type,capabilities_json,max_batch_size,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(workerId, workerType, jsonText(capabilities, 'worker capabilities'), maxBatchSize, at, at)
      this.#db.prepare(`INSERT INTO worker_sessions
        (session_id,worker_id,task_id,step_id,assignment_id,logical_session_id,state,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?, 'ACTIVE', ?,?,?)`).run(sessionId, workerId, taskId, stepId, assignmentId, logicalSessionId, jsonText(input.metadata ?? {}, 'worker metadata'), at, at)
      this.#event({ taskId, stepId, assignmentId, workerId, sessionId, type: 'worker.registered', payload: { workerType, capabilities, maxBatchSize, logicalSessionId }, at })
      return { workerId, sessionId, taskId, stepId, assignmentId, requiredCapability: stage.required_capability, maxBatchSize, status: 'READY' }
    }))
  }

  claimWork(input) {
    const ids = this.#workerIds(input)
    const clean = { ...ids, maxItems: input.maxItems ?? null, leaseSeconds: input.leaseSeconds ?? null }
    return this.#transaction(() => this.#idempotent(`session:${ids.sessionId}`, input.idempotencyKey, 'claim_work', clean, () => {
      const at = this.#now()
      this.#expireLeasesTx(at, ids.taskId, ids.stepId)
      const { worker } = this.#requireSession(ids)
      const maxItems = Math.min(worker.max_batch_size, input.maxItems == null ? worker.max_batch_size : assertInt(input.maxItems, 'maxItems', 1, MAX_BATCH_SIZE))
      const leaseSeconds = input.leaseSeconds == null ? this.#defaultLeaseSeconds : assertInt(input.leaseSeconds, 'leaseSeconds', 1, 86_400)
      const existing = this.#db.prepare("SELECT claim_id FROM claims WHERE session_id=? AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1").get(ids.sessionId)
      if (existing) return { state: 'CLAIMED', resumed: true, claim: this.#claimView(existing.claim_id), progress: this.#counts(ids.taskId, ids.stepId) }
      const claim = this.#createClaimTx(ids, maxItems, leaseSeconds, at)
      if (claim) return { state: 'CLAIMED', resumed: false, claim, progress: this.#counts(ids.taskId, ids.stepId) }
      return this.#noClaimResult(ids.taskId, ids.stepId)
    }))
  }

  reportProgress(input) {
    const ids = this.#workerIds(input)
    const claimId = assertId(input.claimId, 'claimId')
    const progress = Number(input.progress)
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('progress must be between 0 and 1')
    const currentActivity = assertText(input.currentActivity ?? null, 'currentActivity', 2048)
    const runningUnitIds = input.runningUnitIds == null ? [] : uniqueStrings(input.runningUnitIds, 'runningUnitIds')
    const clean = { ...ids, claimId, progress, currentActivity, runningUnitIds, leaseSeconds: input.leaseSeconds ?? null }
    return this.#transaction(() => this.#idempotent(`claim:${claimId}`, input.idempotencyKey, 'report_progress', clean, () => {
      const at = this.#now()
      this.#expireLeasesTx(at, ids.taskId, ids.stepId)
      const claim = this.#requireActiveClaim(ids, claimId)
      const claimedIds = new Set(this.#claimUnitIds(claimId))
      for (const unitId of runningUnitIds) if (!claimedIds.has(unitId)) throw new Error(`unit ${unitId} is not part of claim ${claimId}`)
      for (const unitId of runningUnitIds) {
        this.#db.prepare("UPDATE work_units SET status='RUNNING',updated_at=? WHERE task_id=? AND step_id=? AND unit_id=? AND claim_id=? AND status IN ('CLAIMED','RUNNING')")
          .run(at, ids.taskId, ids.stepId, unitId, claimId)
      }
      const leaseSeconds = input.leaseSeconds == null ? this.#defaultLeaseSeconds : assertInt(input.leaseSeconds, 'leaseSeconds', 1, 86_400)
      const leaseUntil = plusSeconds(at, leaseSeconds)
      this.#db.prepare('UPDATE claims SET lease_until=?,updated_at=? WHERE claim_id=?').run(leaseUntil, at, claimId)
      this.#event({ ...ids, claimId, type: 'claim.progress', payload: { progress, currentActivity, runningUnitIds, leaseUntil }, at })
      return { state: 'RUNNING', claimId, progress, currentActivity, leaseUntil, stageProgress: this.#counts(ids.taskId, ids.stepId) }
    }))
  }

  completeAndClaimNext(input) {
    const ids = this.#workerIds(input)
    const claimId = assertId(input.claimId, 'claimId')
    const completedUnits = this.#normalizeCompleted(input.completedUnits ?? [])
    const failedUnits = this.#normalizeFailed(input.failedUnits ?? [])
    const clean = { ...ids, claimId, completedUnits, failedUnits, maxItems: input.maxItems ?? null, leaseSeconds: input.leaseSeconds ?? null }
    return this.#transaction(() => this.#idempotent(`claim:${claimId}`, input.idempotencyKey, 'complete_and_claim_next', clean, () => {
      const at = this.#now()
      this.#expireLeasesTx(at, ids.taskId, ids.stepId)
      this.#requireActiveClaim(ids, claimId)
      const claimUnitIds = this.#claimUnitIds(claimId)
      const reported = [...completedUnits.map(unit => unit.unitId), ...failedUnits.map(unit => unit.unitId)]
      if (new Set(reported).size !== reported.length) throw new Error('completedUnits and failedUnits overlap or contain duplicates')
      if (reported.length !== claimUnitIds.length || reported.some(unitId => !claimUnitIds.includes(unitId))) throw new Error('every claimed unit must be reported exactly once')
      for (const unit of completedUnits) {
        this.#db.prepare(`UPDATE work_units SET status='COMPLETED',claim_id=NULL,last_error=NULL,artifact_refs_json=?,updated_at=?
          WHERE task_id=? AND step_id=? AND unit_id=? AND claim_id=?`).run(jsonText(unit.artifactRefs, 'artifactRefs', 64 * 1024), at, ids.taskId, ids.stepId, unit.unitId, claimId)
      }
      for (const unit of failedUnits) {
        const row = this.#db.prepare('SELECT attempts,max_attempts FROM work_units WHERE task_id=? AND step_id=? AND unit_id=? AND claim_id=?').get(ids.taskId, ids.stepId, unit.unitId, claimId)
        if (!row) throw new Error(`claimed unit ${unit.unitId} disappeared`)
        const retry = unit.retryable && Number(row.attempts) < Number(row.max_attempts)
        this.#db.prepare('UPDATE work_units SET status=?,claim_id=NULL,last_error=?,updated_at=? WHERE task_id=? AND step_id=? AND unit_id=?')
          .run(retry ? 'AVAILABLE' : 'FAILED', unit.reason, at, ids.taskId, ids.stepId, unit.unitId)
      }
      const claimStatus = failedUnits.length === 0 ? 'COMPLETED' : completedUnits.length > 0 ? 'PARTIAL' : 'FAILED'
      this.#db.prepare('UPDATE claims SET status=?,updated_at=?,completed_at=? WHERE claim_id=?').run(claimStatus, at, at, claimId)
      this.#event({ ...ids, claimId, type: 'claim.completed', payload: { claimStatus, completedUnitIds: completedUnits.map(unit => unit.unitId), failedUnits }, at })
      const { worker } = this.#requireSession(ids)
      const maxItems = Math.min(worker.max_batch_size, input.maxItems == null ? worker.max_batch_size : assertInt(input.maxItems, 'maxItems', 1, MAX_BATCH_SIZE))
      const leaseSeconds = input.leaseSeconds == null ? this.#defaultLeaseSeconds : assertInt(input.leaseSeconds, 'leaseSeconds', 1, 86_400)
      const nextClaim = this.#createClaimTx(ids, maxItems, leaseSeconds, at)
      if (nextClaim) return { state: 'CLAIMED', previousClaim: { claimId, status: claimStatus }, nextClaim, progress: this.#counts(ids.taskId, ids.stepId) }
      const result = this.#noClaimResult(ids.taskId, ids.stepId)
      return { ...result, previousClaim: { claimId, status: claimStatus } }
    }))
  }

  reportFailure(input) {
    const ids = this.#workerIds(input)
    const claimId = assertId(input.claimId, 'claimId')
    const reason = assertText(input.reason, 'reason', 4096, true)
    const retryable = input.retryable !== false
    const clean = { ...ids, claimId, reason, retryable }
    return this.#transaction(() => this.#idempotent(`claim:${claimId}`, input.idempotencyKey, 'report_failure', clean, () => {
      const at = this.#now()
      this.#expireLeasesTx(at, ids.taskId, ids.stepId)
      this.#requireActiveClaim(ids, claimId)
      for (const unitId of this.#claimUnitIds(claimId)) {
        const row = this.#db.prepare('SELECT attempts,max_attempts FROM work_units WHERE task_id=? AND step_id=? AND unit_id=?').get(ids.taskId, ids.stepId, unitId)
        const retry = retryable && Number(row.attempts) < Number(row.max_attempts)
        this.#db.prepare('UPDATE work_units SET status=?,claim_id=NULL,last_error=?,updated_at=? WHERE task_id=? AND step_id=? AND unit_id=?')
          .run(retry ? 'AVAILABLE' : 'FAILED', reason, at, ids.taskId, ids.stepId, unitId)
      }
      this.#db.prepare("UPDATE claims SET status='FAILED',updated_at=?,completed_at=? WHERE claim_id=?").run(at, at, claimId)
      this.#event({ ...ids, claimId, type: 'claim.failed', payload: { reason, retryable }, at })
      const outcome = this.#noClaimResult(ids.taskId, ids.stepId)
      return { state: 'FAILED_RECORDED', claimId, retryable, progress: outcome.progress }
    }))
  }

  getTaskContext(input) {
    const ids = this.#workerIds(input)
    this.#requireSession(ids)
    const stage = this.#stageView(ids.taskId, ids.stepId)
    const active = this.#db.prepare("SELECT claim_id FROM claims WHERE session_id=? AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1").get(ids.sessionId)
    return { taskId: ids.taskId, stepId: ids.stepId, assignmentId: ids.assignmentId, workerId: ids.workerId, sessionId: ids.sessionId,
      stage, activeClaim: active ? this.#claimView(active.claim_id) : null, progress: this.#counts(ids.taskId, ids.stepId) }
  }

  expireLeases(input = {}) {
    const at = input.at == null ? this.#now() : iso(input.at)
    const taskId = input.taskId == null ? null : assertId(input.taskId, 'taskId')
    const stepId = input.stepId == null ? null : assertId(input.stepId, 'stepId')
    return this.#transaction(() => ({ expiredClaimIds: this.#expireLeasesTx(at, taskId, stepId), at }))
  }

  stageSnapshot(taskIdValue, stepIdValue) {
    const taskId = assertId(taskIdValue, 'taskId')
    const stepId = assertId(stepIdValue, 'stepId')
    const stage = this.#stageView(taskId, stepId)
    const units = this.#db.prepare('SELECT * FROM work_units WHERE task_id=? AND step_id=? ORDER BY ordinal,unit_id').all(taskId, stepId).map(row => this.#unitView(row))
    const claims = this.#db.prepare('SELECT claim_id FROM claims WHERE task_id=? AND step_id=? ORDER BY created_at,claim_id').all(taskId, stepId).map(row => this.#claimView(row.claim_id))
    const events = this.#db.prepare('SELECT sequence,event_id,type,payload_json,at,worker_id,session_id,claim_id FROM worker_events WHERE task_id=? AND step_id=? ORDER BY sequence').all(taskId, stepId)
      .map(row => ({ ...row, payload: parseJson(row.payload_json, {}), payload_json: undefined }))
    return { stage, progress: this.#counts(taskId, stepId), units, claims, events }
  }

  #requireStage(taskId, stepId) {
    const row = this.#db.prepare('SELECT * FROM worker_stages WHERE task_id=? AND step_id=?').get(taskId, stepId)
    if (!row) throw new Error(`worker stage not found: ${taskId}/${stepId}`)
    return row
  }
  #stageView(taskId, stepId) {
    const row = this.#requireStage(taskId, stepId)
    return { taskId: row.task_id, stepId: row.step_id, assignmentId: row.assignment_id, requiredCapability: row.required_capability,
      status: row.status, metadata: parseJson(row.metadata_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }
  }
  #workerIds(input) {
    return { taskId: assertId(input.taskId, 'taskId'), stepId: assertId(input.stepId, 'stepId'), assignmentId: assertId(input.assignmentId, 'assignmentId'),
      workerId: assertId(input.workerId, 'workerId'), sessionId: assertId(input.sessionId, 'sessionId') }
  }
  #requireSession(ids) {
    const session = this.#db.prepare('SELECT * FROM worker_sessions WHERE session_id=?').get(ids.sessionId)
    if (!session || session.state !== 'ACTIVE') throw new Error('worker session is not active')
    if (session.worker_id !== ids.workerId || session.task_id !== ids.taskId || session.step_id !== ids.stepId || session.assignment_id !== ids.assignmentId) throw new Error('worker session scope mismatch')
    const worker = this.#db.prepare('SELECT * FROM workers WHERE worker_id=?').get(ids.workerId)
    if (!worker) throw new Error('worker registration is missing')
    return { session, worker }
  }
  #requireActiveClaim(ids, claimId) {
    this.#requireSession(ids)
    const claim = this.#db.prepare('SELECT * FROM claims WHERE claim_id=?').get(claimId)
    if (!claim || claim.status !== 'ACTIVE') throw new Error(`claim ${claimId} is not active`)
    if (claim.task_id !== ids.taskId || claim.step_id !== ids.stepId || claim.assignment_id !== ids.assignmentId || claim.worker_id !== ids.workerId || claim.session_id !== ids.sessionId) throw new Error('claim scope mismatch')
    return claim
  }
  #claimUnitIds(claimId) { return this.#db.prepare('SELECT unit_id FROM claim_units WHERE claim_id=? ORDER BY rowid').all(claimId).map(row => row.unit_id) }
  #unitView(row) {
    return { unitId: row.unit_id, ordinal: Number(row.ordinal), title: row.title, payload: parseJson(row.payload_json, {}), status: row.status,
      attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts), lastError: row.last_error, artifactRefs: parseJson(row.artifact_refs_json, []), claimId: row.claim_id }
  }
  #claimView(claimId) {
    const row = this.#db.prepare('SELECT * FROM claims WHERE claim_id=?').get(claimId)
    if (!row) throw new Error(`claim not found: ${claimId}`)
    const units = this.#db.prepare(`SELECT u.* FROM claim_units cu JOIN work_units u ON u.task_id=cu.task_id AND u.step_id=cu.step_id AND u.unit_id=cu.unit_id
      WHERE cu.claim_id=? ORDER BY u.ordinal,u.unit_id`).all(claimId).map(unit => this.#unitView(unit))
    return { claimId: row.claim_id, taskId: row.task_id, stepId: row.step_id, assignmentId: row.assignment_id, workerId: row.worker_id,
      sessionId: row.session_id, status: row.status, leaseUntil: row.lease_until, createdAt: row.created_at, updatedAt: row.updated_at, units }
  }
  #counts(taskId, stepId) {
    const rows = this.#db.prepare('SELECT status,COUNT(*) AS count FROM work_units WHERE task_id=? AND step_id=? GROUP BY status').all(taskId, stepId)
    const byStatus = Object.fromEntries(rows.map(row => [row.status, Number(row.count)]))
    const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0)
    const completed = byStatus.COMPLETED ?? 0
    const active = (byStatus.CLAIMED ?? 0) + (byStatus.RUNNING ?? 0)
    const available = byStatus.AVAILABLE ?? 0
    const failed = byStatus.FAILED ?? 0
    return { total, completed, active, available, failed, percent: total === 0 ? 0 : Math.round((completed / total) * 10_000) / 100, byStatus }
  }
  #createClaimTx(ids, maxItems, leaseSeconds, at) {
    const stage = this.#requireStage(ids.taskId, ids.stepId)
    if (stage.assignment_id !== ids.assignmentId) throw new Error('assignment does not own this worker stage')
    const rows = this.#db.prepare("SELECT unit_id FROM work_units WHERE task_id=? AND step_id=? AND status='AVAILABLE' ORDER BY ordinal,unit_id LIMIT ?")
      .all(ids.taskId, ids.stepId, maxItems)
    if (rows.length === 0) return null
    const claimId = `clm-${randomUUID()}`
    const leaseUntil = plusSeconds(at, leaseSeconds)
    this.#db.prepare(`INSERT INTO claims
      (claim_id,task_id,step_id,assignment_id,worker_id,session_id,status,lease_until,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)`).run(claimId, ids.taskId, ids.stepId, ids.assignmentId, ids.workerId, ids.sessionId, leaseUntil, at, at)
    const bind = this.#db.prepare('INSERT INTO claim_units (claim_id,task_id,step_id,unit_id) VALUES (?,?,?,?)')
    const update = this.#db.prepare("UPDATE work_units SET status='CLAIMED',claim_id=?,attempts=attempts+1,updated_at=? WHERE task_id=? AND step_id=? AND unit_id=? AND status='AVAILABLE'")
    for (const row of rows) {
      if (Number(update.run(claimId, at, ids.taskId, ids.stepId, row.unit_id).changes) !== 1) throw new Error(`work unit ${row.unit_id} changed while claiming`)
      bind.run(claimId, ids.taskId, ids.stepId, row.unit_id)
    }
    this.#db.prepare("UPDATE worker_stages SET status='RUNNING',updated_at=? WHERE task_id=? AND step_id=? AND status IN ('READY','RUNNING')").run(at, ids.taskId, ids.stepId)
    this.#event({ ...ids, claimId, type: 'claim.created', payload: { unitIds: rows.map(row => row.unit_id), leaseUntil }, at })
    return this.#claimView(claimId)
  }
  #expireLeasesTx(at, taskId = null, stepId = null) {
    let sql = "SELECT * FROM claims WHERE status='ACTIVE' AND lease_until<=?"
    const args = [at]
    if (taskId) { sql += ' AND task_id=?'; args.push(taskId) }
    if (stepId) { sql += ' AND step_id=?'; args.push(stepId) }
    const claims = this.#db.prepare(sql).all(...args)
    for (const claim of claims) {
      this.#db.prepare("UPDATE claims SET status='EXPIRED',updated_at=?,completed_at=? WHERE claim_id=? AND status='ACTIVE'").run(at, at, claim.claim_id)
      this.#db.prepare("UPDATE work_units SET status='AVAILABLE',claim_id=NULL,updated_at=? WHERE task_id=? AND step_id=? AND claim_id=? AND status IN ('CLAIMED','RUNNING')")
        .run(at, claim.task_id, claim.step_id, claim.claim_id)
      this.#event({ taskId: claim.task_id, stepId: claim.step_id, assignmentId: claim.assignment_id, workerId: claim.worker_id, sessionId: claim.session_id,
        claimId: claim.claim_id, type: 'claim.expired', payload: { leaseUntil: claim.lease_until }, at })
    }
    return claims.map(claim => claim.claim_id)
  }
  #noClaimResult(taskId, stepId) {
    const progress = this.#counts(taskId, stepId)
    const stage = this.#requireStage(taskId, stepId)
    if (progress.total > 0 && progress.completed === progress.total) {
      if (stage.status !== 'WORK_COMPLETE') {
        const at = this.#now()
        this.#db.prepare("UPDATE worker_stages SET status='WORK_COMPLETE',updated_at=? WHERE task_id=? AND step_id=?").run(at, taskId, stepId)
        this.#event({ taskId, stepId, assignmentId: stage.assignment_id, type: 'completion.requested', payload: { completed: progress.completed, total: progress.total }, at })
      }
      return { state: 'STAGE_WORK_COMPLETE', progress }
    }
    if (progress.active > 0) return { state: 'WAITING_FOR_OTHER_WORKERS', progress }
    if (progress.failed > 0 && progress.available === 0) {
      if (stage.status !== 'BLOCKED') {
        const at = this.#now()
        this.#db.prepare("UPDATE worker_stages SET status='BLOCKED',updated_at=? WHERE task_id=? AND step_id=?").run(at, taskId, stepId)
        this.#event({ taskId, stepId, assignmentId: stage.assignment_id, type: 'stage.blocked', payload: { failed: progress.failed }, at })
      }
      return { state: 'STAGE_BLOCKED', progress }
    }
    return { state: 'NO_WORK_AVAILABLE', progress }
  }
  #normalizeCompleted(values) {
    if (!Array.isArray(values) || values.length > MAX_BATCH_SIZE) throw new Error('completedUnits must be an array with at most 100 items')
    return values.map(value => {
      if (typeof value === 'string') return { unitId: assertId(value, 'completed unitId'), artifactRefs: [] }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('completed unit must be an object or unit id')
      const artifactRefs = value.artifactRefs == null ? [] : uniqueTexts(value.artifactRefs, 'artifactRefs', 2048)
      return { unitId: assertId(value.unitId, 'completed unitId'), artifactRefs }
    })
  }
  #normalizeFailed(values) {
    if (!Array.isArray(values) || values.length > MAX_BATCH_SIZE) throw new Error('failedUnits must be an array with at most 100 items')
    return values.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('failed unit must be an object')
      return { unitId: assertId(value.unitId, 'failed unitId'), reason: assertText(value.reason, 'failure reason', 4096, true), retryable: value.retryable !== false }
    })
  }
}

export const ZERO3_WORKER_PROTOCOL_LIMITS = Object.freeze({ maxBatchSize: MAX_BATCH_SIZE, defaultLeaseSeconds: DEFAULT_LEASE_SECONDS })

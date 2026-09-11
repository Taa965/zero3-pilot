import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  AgentLifecycleClaim,
  AgentLifecycleSession,
  AutonomousTaskDispatchRecord,
  AutonomousTaskIntakeRecord,
  ContextChange,
  LifecycleAgentType,
  LifecycleClaimMode,
  LifecycleClaimState,
  LifecycleImportance,
  LifecycleSessionState,
  LifecycleWorklogEntry
} from './lifecycle-contracts.ts'

const MAX_JSON_BYTES = 1024 * 1024
const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}
function json(value: unknown, label: string): string {
  const text = JSON.stringify(value ?? null)
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error(`${label} exceeds 1 MiB`)
  return text
}
function parse(value: unknown): any { return typeof value === 'string' ? JSON.parse(value) : null }

function requestHash(value: unknown): string {
  const stable = (input: any): any => Array.isArray(input)
    ? input.map(stable)
    : input && typeof input === 'object'
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]))
      : input
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    if (!path.isAbsolute(filename)) throw new Error('agent lifecycle database path must be absolute')
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    fs.closeSync(fs.openSync(filename, 'a', 0o600))
  }
  const db = new DatabaseSync(filename)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS agent_lifecycle_sessions (
      session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_type TEXT NOT NULL,
      project_id TEXT NOT NULL, task_id TEXT NOT NULL, step_id TEXT, assignment_id TEXT, binding_id TEXT,
      state TEXT NOT NULL, started_at TEXT NOT NULL, last_activity_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_task ON agent_lifecycle_sessions(task_id,state,last_activity_at);
    CREATE TABLE IF NOT EXISTS agent_lifecycle_claims (
      claim_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      mode TEXT NOT NULL, state TEXT NOT NULL, step_id TEXT, assignment_id TEXT, binding_id TEXT,
      started_at TEXT NOT NULL, last_activity_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_agent_claims_task ON agent_lifecycle_claims(task_id,state,started_at);`)
  db.exec(`CREATE TABLE IF NOT EXISTS agent_worklog (
      worklog_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_type TEXT NOT NULL,
      project_id TEXT NOT NULL, task_id TEXT NOT NULL, event_type TEXT NOT NULL, importance TEXT NOT NULL,
      content_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_agent_worklog_task ON agent_worklog(task_id,created_at,worklog_id);
    CREATE TABLE IF NOT EXISTS task_context_versions (
      task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, memory_version INTEGER NOT NULL DEFAULT 0,
      execution_sequence INTEGER NOT NULL DEFAULT 0, artifact_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_context_changes (
      task_id TEXT NOT NULL, version INTEGER NOT NULL, change_type TEXT NOT NULL, ref_id TEXT,
      summary TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(task_id,version));
    CREATE TABLE IF NOT EXISTS lifecycle_idempotency (
      scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key,idempotency_key));
    CREATE TABLE IF NOT EXISTS lifecycle_memory_outbox (
      event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, payload_json TEXT NOT NULL,
      state TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomous_task_intake (
      source_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      source_task_id TEXT, source_version INTEGER NOT NULL, fingerprint TEXT NOT NULL, task_id TEXT,
      detail_json TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_autonomous_intake_project ON autonomous_task_intake(project_id,last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_autonomous_intake_task ON autonomous_task_intake(task_id);
    CREATE INDEX IF NOT EXISTS idx_autonomous_intake_fingerprint ON autonomous_task_intake(project_id,entity_type,fingerprint);
    CREATE TABLE IF NOT EXISTS autonomous_task_dispatch (
      dispatch_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, state TEXT NOT NULL, session_id TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_autonomous_dispatch_task ON autonomous_task_dispatch(task_id,step_id,state);`)
  return db
}

export class Zero3AgentLifecycleStore {
  readonly db: DatabaseSync
  constructor(filename: string) { this.db = openDatabase(filename) }
  close(): void { this.db.close() }

  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  upsertSession(input: {
    sessionId: string; agentId: string; agentType: LifecycleAgentType; projectId: string; taskId: string;
    state?: LifecycleSessionState; at: string
  }): AgentLifecycleSession {
    const sessionId = id(input.sessionId, 'sessionId')
    const existing = this.getSession(sessionId)
    if (existing) {
      if (existing.agentId !== input.agentId || existing.agentType !== input.agentType || existing.projectId !== input.projectId || existing.taskId !== input.taskId) {
        throw new Error('session identity conflicts with existing lifecycle session')
      }
      this.db.prepare('UPDATE agent_lifecycle_sessions SET state=?,last_activity_at=? WHERE session_id=?')
        .run(input.state ?? existing.state, input.at, sessionId)
      return this.getSession(sessionId)!
    }
    this.db.prepare(`INSERT INTO agent_lifecycle_sessions
      (session_id,agent_id,agent_type,project_id,task_id,state,started_at,last_activity_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      sessionId, id(input.agentId, 'agentId'), input.agentType, id(input.projectId, 'projectId'), id(input.taskId, 'taskId'),
      input.state ?? 'ACTIVE', input.at, input.at)
    return this.getSession(sessionId)!
  }

  getSession(sessionIdValue: unknown): AgentLifecycleSession | null {
    const row = this.db.prepare('SELECT * FROM agent_lifecycle_sessions WHERE session_id=?').get(id(sessionIdValue, 'sessionId')) as any
    return row ? this.sessionRow(row) : null
  }

  updateSessionBinding(sessionIdValue: unknown, input: { stepId?: string | null; assignmentId?: string | null; bindingId?: string | null; state?: LifecycleSessionState; at: string }): AgentLifecycleSession {
    const sessionId = id(sessionIdValue, 'sessionId')
    if (!this.getSession(sessionId)) throw new Error('lifecycle session not found')
    const stepId = input.stepId == null ? null : id(input.stepId, 'stepId')
    const assignmentId = input.assignmentId == null ? null : id(input.assignmentId, 'assignmentId')
    const bindingId = input.bindingId == null ? null : id(input.bindingId, 'bindingId')
    this.db.prepare(`UPDATE agent_lifecycle_sessions SET step_id=?,assignment_id=?,binding_id=?,state=COALESCE(?,state),last_activity_at=? WHERE session_id=?`)
      .run(stepId, assignmentId, bindingId, input.state ?? null, input.at, sessionId)
    return this.getSession(sessionId)!
  }

  touchSession(sessionIdValue: unknown, at: string, state?: LifecycleSessionState): AgentLifecycleSession {
    const sessionId = id(sessionIdValue, 'sessionId')
    if (!this.getSession(sessionId)) throw new Error('lifecycle session not found')
    this.db.prepare('UPDATE agent_lifecycle_sessions SET state=COALESCE(?,state),last_activity_at=? WHERE session_id=?')
      .run(state ?? null, at, sessionId)
    return this.getSession(sessionId)!
  }

  activeClaims(taskIdValue: unknown): AgentLifecycleClaim[] {
    const rows = this.db.prepare("SELECT * FROM agent_lifecycle_claims WHERE task_id=? AND state='ACTIVE' ORDER BY started_at,claim_id")
      .all(id(taskIdValue, 'taskId')) as any[]
    return rows.map(row => this.claimRow(row))
  }

  activeClaimForSession(sessionIdValue: unknown): AgentLifecycleClaim | null {
    const row = this.db.prepare("SELECT * FROM agent_lifecycle_claims WHERE session_id=? AND state='ACTIVE' ORDER BY started_at DESC LIMIT 1")
      .get(id(sessionIdValue, 'sessionId')) as any
    return row ? this.claimRow(row) : null
  }

  createClaim(input: {
    taskId: string; sessionId: string; agentId: string; mode: LifecycleClaimMode;
    stepId?: string | null; assignmentId?: string | null; bindingId?: string | null; at: string
  }): AgentLifecycleClaim {
    const existing = this.activeClaimForSession(input.sessionId)
    if (existing) return existing
    const claimId = `agent-claim-${randomUUID()}`
    this.db.prepare(`INSERT INTO agent_lifecycle_claims
      (claim_id,task_id,session_id,agent_id,mode,state,step_id,assignment_id,binding_id,started_at,last_activity_at)
      VALUES (?,?,?,?,?,'ACTIVE',?,?,?,?,?)`).run(
      claimId, id(input.taskId, 'taskId'), id(input.sessionId, 'sessionId'), id(input.agentId, 'agentId'), input.mode,
      input.stepId == null ? null : id(input.stepId, 'stepId'),
      input.assignmentId == null ? null : id(input.assignmentId, 'assignmentId'),
      input.bindingId == null ? null : id(input.bindingId, 'bindingId'), input.at, input.at)
    return this.activeClaimForSession(input.sessionId)!
  }

  updateClaimBinding(claimIdValue: unknown, input: { stepId?: string | null; assignmentId?: string | null; bindingId?: string | null; at: string }): AgentLifecycleClaim {
    const claimId = id(claimIdValue, 'claimId')
    this.db.prepare(`UPDATE agent_lifecycle_claims SET step_id=?,assignment_id=?,binding_id=?,last_activity_at=? WHERE claim_id=? AND state='ACTIVE'`)
      .run(input.stepId ?? null, input.assignmentId ?? null, input.bindingId ?? null, input.at, claimId)
    const row = this.db.prepare('SELECT * FROM agent_lifecycle_claims WHERE claim_id=?').get(claimId) as any
    if (!row) throw new Error('lifecycle claim not found')
    return this.claimRow(row)
  }

  releaseClaim(sessionIdValue: unknown, state: Exclude<LifecycleClaimState, 'ACTIVE'>, at: string): AgentLifecycleClaim | null {
    const current = this.activeClaimForSession(sessionIdValue)
    if (!current) return null
    this.db.prepare('UPDATE agent_lifecycle_claims SET state=?,last_activity_at=? WHERE claim_id=?').run(state, at, current.claimId)
    return { ...current, state, lastActivityAt: at }
  }

  recordWorklog(input: {
    session: AgentLifecycleSession; eventType: string; importance: LifecycleImportance;
    content: Record<string, unknown>; at: string; worklogId?: string
  }): LifecycleWorklogEntry {
    const worklogId = input.worklogId == null ? `worklog-${randomUUID()}` : id(input.worklogId, 'worklogId')
    const existing = this.db.prepare('SELECT * FROM agent_worklog WHERE worklog_id=?').get(worklogId) as any
    if (existing) return this.worklogRow(existing)
    this.db.prepare(`INSERT INTO agent_worklog
      (worklog_id,session_id,agent_id,agent_type,project_id,task_id,event_type,importance,content_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      worklogId, input.session.sessionId, input.session.agentId, input.session.agentType,
      input.session.projectId, input.session.taskId, input.eventType, input.importance,
      json(input.content, 'worklog content'), input.at)
    return this.worklogRow(this.db.prepare('SELECT * FROM agent_worklog WHERE worklog_id=?').get(worklogId) as any)
  }

  listWorklog(taskIdValue: unknown, limit = 100): LifecycleWorklogEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('worklog limit is invalid')
    const rows = this.db.prepare('SELECT * FROM agent_worklog WHERE task_id=? ORDER BY created_at DESC,worklog_id DESC LIMIT ?')
      .all(id(taskIdValue, 'taskId'), limit) as any[]
    return rows.map(row => this.worklogRow(row)).reverse()
  }

  currentContextVersion(taskIdValue: unknown): number {
    const row = this.db.prepare('SELECT version FROM task_context_versions WHERE task_id=?').get(id(taskIdValue, 'taskId')) as any
    return row ? Number(row.version) : 0
  }

  bumpContext(input: { taskId: string; projectId: string; type: string; refId?: string | null; summary: string; at: string }): number {
    const taskId = id(input.taskId, 'taskId')
    const projectId = id(input.projectId, 'projectId')
    const summary = input.summary.trim().slice(0, 4096)
    if (!summary) throw new Error('context change summary is required')
    return this.transaction(() => {
      const current = this.currentContextVersion(taskId)
      const next = current + 1
      this.db.prepare(`INSERT INTO task_context_versions (task_id,project_id,version,updated_at)
        VALUES (?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET project_id=excluded.project_id,version=excluded.version,updated_at=excluded.updated_at`)
        .run(taskId, projectId, next, input.at)
      this.db.prepare('INSERT INTO task_context_changes (task_id,version,change_type,ref_id,summary,at) VALUES (?,?,?,?,?,?)')
        .run(taskId, next, input.type, input.refId ?? null, summary, input.at)
      return next
    })
  }

  reconcileExternalSources(input: {
    taskId: string; projectId: string; memoryVersion: number; executionSequence: number; artifactCount: number; at: string
  }): number {
    const taskId = id(input.taskId, 'taskId')
    const row = this.db.prepare('SELECT * FROM task_context_versions WHERE task_id=?').get(taskId) as any
    const currentVersion = row ? Number(row.version) : 0
    const changed: string[] = []
    if (!row || Number(row.memory_version) !== input.memoryVersion) changed.push('memory')
    if (!row || Number(row.execution_sequence) !== input.executionSequence) changed.push('task_state')
    if (!row || Number(row.artifact_count) !== input.artifactCount) changed.push('artifact')
    if (changed.length === 0) return currentVersion
    const next = currentVersion + 1
    this.transaction(() => {
      this.db.prepare(`INSERT INTO task_context_versions
        (task_id,project_id,version,memory_version,execution_sequence,artifact_count,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
        project_id=excluded.project_id,version=excluded.version,memory_version=excluded.memory_version,
        execution_sequence=excluded.execution_sequence,artifact_count=excluded.artifact_count,updated_at=excluded.updated_at`)
        .run(taskId, id(input.projectId, 'projectId'), next, input.memoryVersion, input.executionSequence, input.artifactCount, input.at)
      this.db.prepare('INSERT INTO task_context_changes (task_id,version,change_type,ref_id,summary,at) VALUES (?,?,?,?,?,?)')
        .run(taskId, next, 'external_reconcile', null, `Changed: ${changed.join(', ')}`, input.at)
    })
    return next
  }

  changesSince(taskIdValue: unknown, version: number): ContextChange[] {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('context version is invalid')
    const rows = this.db.prepare('SELECT * FROM task_context_changes WHERE task_id=? AND version>? ORDER BY version')
      .all(id(taskIdValue, 'taskId'), version) as any[]
    return rows.map(row => ({
      version: Number(row.version), type: row.change_type, refId: row.ref_id ?? null,
      summary: row.summary, at: row.at
    }))
  }

  getIdempotent(scopeKey: string, idempotencyKeyValue: unknown, operation: string, request: unknown): unknown | null {
    const key = id(idempotencyKeyValue, 'idempotencyKey')
    const row = this.db.prepare('SELECT operation,request_hash,response_json FROM lifecycle_idempotency WHERE scope_key=? AND idempotency_key=?')
      .get(scopeKey, key) as any
    if (!row) return null
    if (row.operation !== operation || row.request_hash !== requestHash(request)) {
      throw new Error('lifecycle idempotency key was reused with different content')
    }
    return parse(row.response_json)
  }

  putIdempotent(scopeKey: string, idempotencyKeyValue: unknown, operation: string, request: unknown, response: unknown, at: string): void {
    const key = id(idempotencyKeyValue, 'idempotencyKey')
    this.db.prepare('INSERT INTO lifecycle_idempotency (scope_key,idempotency_key,operation,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(scopeKey, key, operation, requestHash(request), json(response, 'idempotency response'), at)
  }

  enqueueMemory(event: Record<string, unknown>, projectIdValue: unknown, taskIdValue: unknown | null, at: string): string {
    const eventId = id(event.event_id, 'memory event id')
    const projectId = id(projectIdValue, 'projectId')
    const taskId = taskIdValue == null ? null : id(taskIdValue, 'taskId')
    const payload = json(event, 'memory event')
    const existing = this.db.prepare('SELECT payload_json FROM lifecycle_memory_outbox WHERE event_id=?').get(eventId) as any
    if (existing) {
      if (existing.payload_json !== payload) throw new Error('memory event id belongs to different payload')
      return eventId
    }
    this.db.prepare("INSERT INTO lifecycle_memory_outbox (event_id,project_id,task_id,payload_json,state,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?)")
      .run(eventId, projectId, taskId, payload, at, at)
    return eventId
  }

  memoryOutboxPending(taskIdValue?: unknown): Array<{ eventId: string; event: Record<string, unknown>; state: string; lastError: string | null }> {
    const rows = taskIdValue == null
      ? this.db.prepare("SELECT * FROM lifecycle_memory_outbox WHERE state='pending' ORDER BY created_at,event_id").all() as any[]
      : this.db.prepare("SELECT * FROM lifecycle_memory_outbox WHERE task_id=? AND state='pending' ORDER BY created_at,event_id").all(id(taskIdValue, 'taskId')) as any[]
    return rows.map(row => ({ eventId: row.event_id, event: parse(row.payload_json), state: row.state, lastError: row.last_error ?? null }))
  }

  markMemory(eventIdValue: unknown, state: 'acked' | 'pending', error: string | null, at: string): void {
    const eventId = id(eventIdValue, 'memory event id')
    this.db.prepare('UPDATE lifecycle_memory_outbox SET state=?,last_error=?,updated_at=? WHERE event_id=?')
      .run(state, error?.slice(0, 4096) ?? null, at, eventId)
  }

  memoryOutboxEntry(eventIdValue: unknown): { eventId: string; event: Record<string, unknown>; state: string; lastError: string | null } | null {
    const row = this.db.prepare('SELECT * FROM lifecycle_memory_outbox WHERE event_id=?').get(id(eventIdValue, 'memory event id')) as any
    return row ? { eventId: row.event_id, event: parse(row.payload_json), state: row.state, lastError: row.last_error ?? null } : null
  }

  getAutonomousIntake(sourceKeyValue: unknown): AutonomousTaskIntakeRecord | null {
    const row = this.db.prepare('SELECT * FROM autonomous_task_intake WHERE source_key=?').get(id(sourceKeyValue, 'sourceKey')) as any
    return row ? this.autonomousIntakeRow(row) : null
  }

  findAutonomousIntakeByFingerprint(projectIdValue: unknown, entityType: string, fingerprint: string): AutonomousTaskIntakeRecord | null {
    const projectId = id(projectIdValue, 'projectId')
    if (!/^[0-9a-f]{64}$/i.test(fingerprint)) throw new Error('autonomous intake fingerprint is invalid')
    const row = this.db.prepare(`SELECT * FROM autonomous_task_intake
      WHERE project_id=? AND entity_type=? AND fingerprint=?
      ORDER BY (task_id IS NULL),first_seen_at,source_key LIMIT 1`)
      .get(projectId, entityType.slice(0, 256), fingerprint) as any
    return row ? this.autonomousIntakeRow(row) : null
  }

  upsertAutonomousIntake(input: Omit<AutonomousTaskIntakeRecord, 'firstSeenAt' | 'lastSeenAt'> & { at: string }): AutonomousTaskIntakeRecord {
    const sourceKey = id(input.sourceKey, 'sourceKey')
    const projectId = id(input.projectId, 'projectId')
    if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 0) throw new Error('sourceVersion is invalid')
    if (!/^[0-9a-f]{64}$/i.test(input.fingerprint)) throw new Error('autonomous intake fingerprint is invalid')
    const existing = this.getAutonomousIntake(sourceKey)
    const taskId = input.taskId == null ? existing?.taskId ?? null : id(input.taskId, 'taskId')
    if (existing && existing.projectId !== projectId) throw new Error('autonomous intake source belongs to a different project')
    this.db.prepare(`INSERT INTO autonomous_task_intake
      (source_key,project_id,entity_type,entity_id,source_task_id,source_version,fingerprint,task_id,detail_json,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET
      source_version=excluded.source_version,fingerprint=excluded.fingerprint,task_id=COALESCE(excluded.task_id,autonomous_task_intake.task_id),
      detail_json=excluded.detail_json,last_seen_at=excluded.last_seen_at
      WHERE excluded.source_version >= autonomous_task_intake.source_version`)
      .run(sourceKey, projectId, input.entityType.slice(0, 256), input.entityId.slice(0, 512), input.sourceTaskId ?? null,
        input.sourceVersion, input.fingerprint, taskId, json(input.detail, 'autonomous intake detail'), existing?.firstSeenAt ?? input.at, input.at)
    return this.getAutonomousIntake(sourceKey)!
  }

  bindAutonomousTask(sourceKeyValue: unknown, taskIdValue: unknown, at: string): AutonomousTaskIntakeRecord {
    const sourceKey = id(sourceKeyValue, 'sourceKey')
    const taskId = id(taskIdValue, 'taskId')
    if (!this.getAutonomousIntake(sourceKey)) throw new Error('autonomous intake source not found')
    this.db.prepare('UPDATE autonomous_task_intake SET task_id=?,last_seen_at=? WHERE source_key=?').run(taskId, at, sourceKey)
    return this.getAutonomousIntake(sourceKey)!
  }

  getAutonomousDispatch(dispatchKeyValue: unknown): AutonomousTaskDispatchRecord | null {
    const row = this.db.prepare('SELECT * FROM autonomous_task_dispatch WHERE dispatch_key=?').get(id(dispatchKeyValue, 'dispatchKey')) as any
    return row ? this.autonomousDispatchRow(row) : null
  }

  reserveAutonomousDispatch(input: { dispatchKey: string; projectId: string; taskId: string; stepId: string; attempt: number; at: string }): AutonomousTaskDispatchRecord {
    const key = id(input.dispatchKey, 'dispatchKey')
    const existing = this.getAutonomousDispatch(key)
    if (existing) return existing
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new Error('autonomous dispatch attempt is invalid')
    this.db.prepare(`INSERT INTO autonomous_task_dispatch
      (dispatch_key,project_id,task_id,step_id,attempt,state,created_at,updated_at) VALUES (?,?,?,?,?,'RESERVED',?,?)`)
      .run(key, id(input.projectId, 'projectId'), id(input.taskId, 'taskId'), id(input.stepId, 'stepId'), input.attempt, input.at, input.at)
    return this.getAutonomousDispatch(key)!
  }

  updateAutonomousDispatch(dispatchKeyValue: unknown, input: { state: AutonomousTaskDispatchRecord['state']; sessionId?: string | null; lastError?: string | null; at: string }): AutonomousTaskDispatchRecord {
    const key = id(dispatchKeyValue, 'dispatchKey')
    if (!this.getAutonomousDispatch(key)) throw new Error('autonomous dispatch reservation not found')
    const sessionId = input.sessionId == null ? null : id(input.sessionId, 'sessionId')
    this.db.prepare('UPDATE autonomous_task_dispatch SET state=?,session_id=COALESCE(?,session_id),last_error=?,updated_at=? WHERE dispatch_key=?')
      .run(input.state, sessionId, input.lastError?.slice(0, 4096) ?? null, input.at, key)
    return this.getAutonomousDispatch(key)!
  }

  private sessionRow(row: any): AgentLifecycleSession {
    return {
      sessionId: row.session_id, agentId: row.agent_id, agentType: row.agent_type,
      projectId: row.project_id, taskId: row.task_id, stepId: row.step_id ?? null,
      assignmentId: row.assignment_id ?? null, bindingId: row.binding_id ?? null,
      state: row.state, startedAt: row.started_at, lastActivityAt: row.last_activity_at
    }
  }

  private claimRow(row: any): AgentLifecycleClaim {
    return {
      claimId: row.claim_id, taskId: row.task_id, sessionId: row.session_id, agentId: row.agent_id,
      mode: row.mode, state: row.state, stepId: row.step_id ?? null, assignmentId: row.assignment_id ?? null,
      bindingId: row.binding_id ?? null, startedAt: row.started_at, lastActivityAt: row.last_activity_at
    }
  }

  private worklogRow(row: any): LifecycleWorklogEntry {
    return {
      worklogId: row.worklog_id, sessionId: row.session_id, agentId: row.agent_id, agentType: row.agent_type,
      projectId: row.project_id, taskId: row.task_id, eventType: row.event_type, importance: row.importance,
      content: parse(row.content_json), createdAt: row.created_at
    }
  }

  private autonomousIntakeRow(row: any): AutonomousTaskIntakeRecord {
    return {
      sourceKey: row.source_key, projectId: row.project_id, entityType: row.entity_type, entityId: row.entity_id,
      sourceTaskId: row.source_task_id ?? null, sourceVersion: Number(row.source_version), fingerprint: row.fingerprint,
      taskId: row.task_id ?? null, detail: parse(row.detail_json), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at
    }
  }

  private autonomousDispatchRow(row: any): AutonomousTaskDispatchRecord {
    return {
      dispatchKey: row.dispatch_key, projectId: row.project_id, taskId: row.task_id, stepId: row.step_id,
      attempt: Number(row.attempt), state: row.state, sessionId: row.session_id ?? null,
      lastError: row.last_error ?? null, createdAt: row.created_at, updatedAt: row.updated_at
    }
  }
}

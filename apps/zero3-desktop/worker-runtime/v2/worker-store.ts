import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_JSON_BYTES = 1024 * 1024

export function workflowJson(value: unknown, label: string, maxBytes = MAX_JSON_BYTES): string {
  const text = JSON.stringify(value ?? null)
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  return text
}

export function workflowParse<T>(value: unknown, fallback: T): T {
  return value == null ? fallback : JSON.parse(String(value)) as T
}

function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    if (!path.isAbsolute(filename)) throw new Error('workflow worker database path must be absolute')
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    fs.closeSync(fs.openSync(filename, 'a', 0o600))
  }
  const db = new DatabaseSync(filename)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS workflow_runs (
      workflow_run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, module_id TEXT NOT NULL, module_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_task ON workflow_runs(task_id,workflow_run_id);
    CREATE TABLE IF NOT EXISTS workflow_worker_bindings (
      worker_slot_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, worker_definition_id TEXT NOT NULL,
      provider TEXT NOT NULL, required_capabilities_json TEXT NOT NULL, max_batch_size INTEGER NOT NULL,
      session_policy_json TEXT NOT NULL, role TEXT, prompt_revision TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_workflow_bindings_run ON workflow_worker_bindings(workflow_run_id,worker_definition_id);`)
  db.exec(`CREATE TABLE IF NOT EXISTS worker_slots (
      worker_slot_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, worker_definition_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'IDLE', active_worker_session_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS physical_worker_sessions (
      worker_session_id TEXT PRIMARY KEY, worker_slot_id TEXT NOT NULL, generation INTEGER NOT NULL,
      logical_session_id TEXT NOT NULL, conversation_id TEXT, conversation_url TEXT,
      state TEXT NOT NULL, processed_item_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, closed_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_physical_sessions_slot ON physical_worker_sessions(worker_slot_id,generation,state);
    CREATE TABLE IF NOT EXISTS work_items (
      workflow_run_id TEXT NOT NULL, work_item_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workflow_run_id,work_item_id));
    CREATE INDEX IF NOT EXISTS idx_work_items_run ON work_items(workflow_run_id,status,ordinal,work_item_id);
    CREATE TABLE IF NOT EXISTS stage_runs (
      stage_run_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
      stage_key TEXT NOT NULL, ordinal INTEGER NOT NULL, worker_definition_id TEXT NOT NULL,
      required_capability TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', instruction TEXT NOT NULL,
      skill_json TEXT, inputs_json TEXT NOT NULL DEFAULT '[]', expected_outputs_json TEXT NOT NULL DEFAULT '[]',
      policy_json TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL, claim_id TEXT, artifacts_json TEXT NOT NULL DEFAULT '[]', last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_stage_runs_ready ON stage_runs(workflow_run_id,worker_definition_id,status,ordinal,stage_run_id);
    CREATE INDEX IF NOT EXISTS idx_stage_runs_item ON stage_runs(workflow_run_id,work_item_id,ordinal,stage_run_id);`)
  db.exec(`CREATE TABLE IF NOT EXISTS stage_dependencies (
      stage_run_id TEXT NOT NULL, depends_on_stage_run_id TEXT NOT NULL,
      PRIMARY KEY(stage_run_id,depends_on_stage_run_id));
    CREATE INDEX IF NOT EXISTS idx_stage_dependencies_parent ON stage_dependencies(depends_on_stage_run_id,stage_run_id);
    CREATE TABLE IF NOT EXISTS workflow_claims (
      claim_id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, worker_definition_id TEXT NOT NULL,
      worker_slot_id TEXT NOT NULL, worker_session_id TEXT NOT NULL, generation INTEGER NOT NULL,
      status TEXT NOT NULL, lease_until TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      completed_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_workflow_claims_active ON workflow_claims(workflow_run_id,worker_slot_id,status,lease_until);
    CREATE TABLE IF NOT EXISTS workflow_claim_units (
      claim_id TEXT NOT NULL, stage_run_id TEXT NOT NULL,
      PRIMARY KEY(claim_id,stage_run_id));
    CREATE TABLE IF NOT EXISTS workflow_worker_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      workflow_run_id TEXT NOT NULL, work_item_id TEXT, stage_run_id TEXT,
      worker_definition_id TEXT, worker_slot_id TEXT, worker_session_id TEXT, claim_id TEXT,
      type TEXT NOT NULL, payload_json TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_worker_events(workflow_run_id,sequence);
    CREATE TABLE IF NOT EXISTS worker_binding_generations (
      worker_slot_id TEXT NOT NULL, generation INTEGER NOT NULL, worker_session_id TEXT,
      reason TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(worker_slot_id,generation));
    CREATE TABLE IF NOT EXISTS workflow_worker_idempotency (
      scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key,idempotency_key));`)
  return db
}

export class Zero3WorkflowWorkerStore {
  readonly db: DatabaseSync
  constructor(filename: string) { this.db = openDatabase(filename) }
  close(): void { this.db.close() }

  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}

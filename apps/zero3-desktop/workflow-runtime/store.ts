import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ZERO3_WORKFLOW_ARTIFACT,
  type WorkflowArtifactRecord,
  type WorkflowArtifactRelocation,
  type WorkflowArtifactSeed,
  type WorkflowEventRecord,
  type WorkflowExternalJobRecord,
  type WorkflowExternalJobState,
  type WorkflowItemRecord,
  type WorkflowRunPlan,
  type WorkflowRunRecord,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
  type WorkflowStageRunRecord,
  type WorkflowStageStatus
} from './contracts.ts'

function json(value: unknown): string { return JSON.stringify(value ?? {}) }
function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  return JSON.parse(value) as T
}
function now(): string { return new Date().toISOString() }
function id(value: string, label: string): string {
  const text = value.trim()
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(text)) throw new Error(`${label} is invalid`)
  return text
}

export class Zero3WorkflowStore {
  readonly db: DatabaseSync

  constructor(readonly filename: string) {
    if (filename !== ':memory:') {
      if (!path.isAbsolute(filename)) throw new Error('workflow database path must be absolute')
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
      fs.closeSync(fs.openSync(filename, 'a', 0o600))
    }
    this.db = new DatabaseSync(filename)
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;

      CREATE TABLE IF NOT EXISTS workflow_runs (
        workflow_run_id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL,
        module_version TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        plan_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS work_items (
        workflow_run_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workflow_run_id, item_id),
        FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(workflow_run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(workflow_run_id, status, ordinal);

      CREATE TABLE IF NOT EXISTS stage_runs (
        stage_run_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        title TEXT NOT NULL,
        executor TEXT NOT NULL,
        worker_definition_id TEXT,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        current_activity TEXT,
        claim_owner_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workflow_run_id, item_id, stage_id),
        FOREIGN KEY(workflow_run_id, item_id) REFERENCES work_items(workflow_run_id, item_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stage_ready ON stage_runs(workflow_run_id, status, worker_definition_id, item_id);

      CREATE TABLE IF NOT EXISTS workflow_artifacts (
        artifact_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        stage_run_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        logical_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT,
        storage_json TEXT NOT NULL,
        sha256 TEXT,
        size_bytes INTEGER,
        state TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(stage_run_id) REFERENCES stage_runs(stage_run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_item ON workflow_artifacts(workflow_run_id, item_id, stage_id, logical_name);

      CREATE TABLE IF NOT EXISTS workflow_external_jobs (
        job_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        stage_run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        request_key TEXT NOT NULL,
        external_id TEXT,
        state TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(stage_run_id) REFERENCES stage_runs(stage_run_id) ON DELETE CASCADE,
        UNIQUE(stage_run_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS idx_external_jobs_run ON workflow_external_jobs(workflow_run_id, state, updated_at);

      CREATE TABLE IF NOT EXISTS workflow_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        workflow_run_id TEXT NOT NULL,
        item_id TEXT,
        stage_run_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        at TEXT NOT NULL,
        FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(workflow_run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(workflow_run_id, sequence);
    `)
  }

  close(): void { this.db.close() }

  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  createRun(plan: WorkflowRunPlan): WorkflowRunSnapshot {
    return this.transaction(() => {
      const runId = id(plan.workflowRunId, 'workflowRunId')
      if (this.db.prepare('SELECT 1 FROM workflow_runs WHERE workflow_run_id=?').get(runId)) throw new Error(`workflow run already exists: ${runId}`)
      const at = plan.createdAt || now()
      this.db.prepare(`INSERT INTO workflow_runs
        (workflow_run_id,module_id,module_version,project_id,title,status,progress,plan_json,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,'READY',0,?,?,?,?)`)
        .run(runId, plan.moduleId, plan.moduleVersion, plan.projectId, plan.title, json(plan), json(plan.metadata), at, at)

      const completedByItem = new Map(plan.items.map(item => [item.itemId, new Set(item.completedStageIds ?? [])] as const))
      const insertItem = this.db.prepare(`INSERT INTO work_items
        (workflow_run_id,item_id,ordinal,title,status,progress,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,'PENDING',0,?,?,?)`)
      const insertStage = this.db.prepare(`INSERT INTO stage_runs
        (stage_run_id,workflow_run_id,item_id,stage_id,title,executor,worker_definition_id,status,progress,current_activity,claim_owner_id,attempt,max_attempts,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,0,?,?,?,?)`)

      plan.items.forEach((item, index) => {
        id(item.itemId, 'itemId')
        insertItem.run(runId, item.itemId, index + 1, item.title, json(item.metadata ?? {}), at, at)
        const completed = completedByItem.get(item.itemId) ?? new Set<string>()
        for (const stage of plan.stages) {
          const status: WorkflowStageStatus = completed.has(stage.stageId)
            ? 'COMPLETED'
            : stage.dependsOn.every(dependency => completed.has(dependency))
              ? 'READY'
              : 'WAITING_DEPENDENCY'
          insertStage.run(
            `${runId}:${item.itemId}:${stage.stageId}`,
            runId,
            item.itemId,
            stage.stageId,
            stage.title,
            stage.executor,
            stage.workerDefinitionId ?? null,
            status,
            status === 'COMPLETED' ? 1 : 0,
            stage.maxAttempts,
            json(stage.metadata ?? {}),
            at,
            at
          )
        }
        for (const artifact of item.initialArtifacts ?? []) this.insertArtifactTx(runId, item.itemId, artifact, at)
      })
      this.appendEventTx(runId, null, null, 'run.created', { moduleId: plan.moduleId, moduleVersion: plan.moduleVersion, itemCount: plan.items.length }, at)
      this.recomputeTx(runId, at)
      return this.snapshot(runId)
    })
  }

  startRun(runIdValue: string): WorkflowRunSnapshot {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const run = this.requireRunRow(runId)
      if (run.status === 'RUNNING') return this.snapshot(runId)
      if (run.status !== 'READY') throw new Error(`workflow run cannot start while ${run.status}`)
      const at = now()
      this.db.prepare("UPDATE workflow_runs SET status='RUNNING',updated_at=? WHERE workflow_run_id=?").run(at, runId)
      this.appendEventTx(runId, null, null, 'run.started', {}, at)
      const ready = this.db.prepare("SELECT item_id,stage_run_id FROM stage_runs WHERE workflow_run_id=? AND status='READY' ORDER BY item_id,stage_id").all(runId) as any[]
      for (const stage of ready) this.appendEventTx(runId, stage.item_id, stage.stage_run_id, 'stage.ready', { reason: 'run_started' }, at)
      this.recomputeTx(runId, at)
      return this.snapshot(runId)
    })
  }

  listRuns(): WorkflowRunRecord[] {
    return this.db.prepare('SELECT * FROM workflow_runs ORDER BY updated_at DESC, workflow_run_id').all().map(row => this.runView(row))
  }

  snapshot(runIdValue: string): WorkflowRunSnapshot {
    const runId = id(runIdValue, 'workflowRunId')
    const row = this.requireRunRow(runId)
    const plan = parse<WorkflowRunPlan>(row.plan_json, {} as WorkflowRunPlan)
    const items = this.db.prepare('SELECT * FROM work_items WHERE workflow_run_id=? ORDER BY ordinal,item_id').all(runId).map(rowValue => this.itemView(rowValue))
    const stages = this.db.prepare('SELECT * FROM stage_runs WHERE workflow_run_id=? ORDER BY item_id,stage_id').all(runId).map(rowValue => this.stageView(rowValue))
    const artifacts = this.db.prepare('SELECT * FROM workflow_artifacts WHERE workflow_run_id=? ORDER BY created_at,artifact_id').all(runId).map(rowValue => this.artifactView(rowValue))
    const externalJobs = this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? ORDER BY created_at,job_id').all(runId).map(rowValue => this.externalJobView(rowValue))
    const events = this.db.prepare('SELECT * FROM workflow_events WHERE workflow_run_id=? ORDER BY sequence').all(runId).map(rowValue => this.eventView(rowValue))
    return { plan, run: this.runView(row), items, stages, artifacts, externalJobs, events }
  }

  readyStages(runIdValue: string, workerDefinitionId?: string | null): WorkflowStageRunRecord[] {
    const runId = id(runIdValue, 'workflowRunId')
    const rows = workerDefinitionId
      ? this.db.prepare("SELECT * FROM stage_runs WHERE workflow_run_id=? AND status IN ('READY','FIX_REQUIRED') AND worker_definition_id=? ORDER BY item_id,stage_id").all(runId, workerDefinitionId)
      : this.db.prepare("SELECT * FROM stage_runs WHERE workflow_run_id=? AND status IN ('READY','FIX_REQUIRED') ORDER BY item_id,stage_id").all(runId)
    return rows.map(row => this.stageView(row))
  }

  claimStage(runIdValue: string, stageRunIdValue: string, ownerValue: string): WorkflowStageRunRecord {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const owner = id(ownerValue, 'claimOwnerId')
      const row = this.requireStageRow(runId, stageRunId)
      if (row.status !== 'READY' && row.status !== 'FIX_REQUIRED') throw new Error(`stage ${stageRunId} is not claimable while ${row.status}`)
      if (Number(row.attempt) >= Number(row.max_attempts)) throw new Error(`stage ${stageRunId} attempt budget exhausted`)
      const at = now()
      this.db.prepare("UPDATE stage_runs SET status='CLAIMED',claim_owner_id=?,attempt=attempt+1,current_activity=NULL,updated_at=? WHERE stage_run_id=?")
        .run(owner, at, stageRunId)
      this.appendEventTx(runId, row.item_id, stageRunId, 'stage.claimed', { owner }, at)
      this.recomputeTx(runId, at)
      return this.stageView(this.requireStageRow(runId, stageRunId))
    })
  }

  startStage(runIdValue: string, stageRunIdValue: string, ownerValue?: string | null): WorkflowStageRunRecord {
    return this.transitionStage(runIdValue, stageRunIdValue, ['CLAIMED', 'READY', 'FIX_REQUIRED'], 'RUNNING', row => {
      if (ownerValue && row.claim_owner_id && row.claim_owner_id !== ownerValue) throw new Error('stage claim owner mismatch')
      return { current_activity: null }
    }, 'stage.started')
  }

  reportProgress(runIdValue: string, stageRunIdValue: string, progress: number, activity?: string | null): WorkflowStageRunRecord {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const row = this.requireStageRow(runId, stageRunId)
      if (!['CLAIMED', 'RUNNING', 'FIX_REQUIRED'].includes(String(row.status))) throw new Error(`stage ${stageRunId} cannot report progress while ${row.status}`)
      if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('progress must be between 0 and 1')
      const at = now()
      this.db.prepare("UPDATE stage_runs SET status='RUNNING',progress=?,current_activity=?,updated_at=? WHERE stage_run_id=?")
        .run(progress, activity?.trim() || null, at, stageRunId)
      this.appendEventTx(runId, row.item_id, stageRunId, 'progress.updated', { progress, currentActivity: activity?.trim() || null }, at)
      this.recomputeTx(runId, at)
      return this.stageView(this.requireStageRow(runId, stageRunId))
    })
  }

  requestVerification(runIdValue: string, stageRunIdValue: string, artifacts: readonly WorkflowArtifactSeed[] = []): WorkflowRunSnapshot {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const row = this.requireStageRow(runId, stageRunId)
      if (!['RUNNING', 'CLAIMED', 'FIX_REQUIRED'].includes(String(row.status))) throw new Error(`stage ${stageRunId} cannot request verification while ${row.status}`)
      const at = now()
      for (const artifact of artifacts) this.insertArtifactTx(runId, row.item_id, { ...artifact, stageId: row.stage_id }, at, stageRunId)
      this.db.prepare("UPDATE stage_runs SET status='VERIFYING',progress=MAX(progress,0.95),current_activity=NULL,updated_at=? WHERE stage_run_id=?").run(at, stageRunId)
      this.appendEventTx(runId, row.item_id, stageRunId, 'stage.verification_requested', { artifactCount: artifacts.length }, at)
      this.recomputeTx(runId, at)
      return this.snapshot(runId)
    })
  }

  gatePassed(runIdValue: string, stageRunIdValue: string, evidence: Readonly<Record<string, unknown>> = {}): WorkflowRunSnapshot {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const row = this.requireStageRow(runId, stageRunId)
      if (row.status !== 'VERIFYING') throw new Error(`stage ${stageRunId} cannot pass gate while ${row.status}`)
      const missing = this.missingRequiredOutputsTx(runId, row.item_id, row.stage_id)
      if (missing.length) throw new Error(`completion gate missing required artifacts: ${missing.join(', ')}`)
      const at = now()
      this.db.prepare("UPDATE stage_runs SET status='COMPLETED',progress=1,current_activity=NULL,claim_owner_id=NULL,updated_at=? WHERE stage_run_id=?").run(at, stageRunId)
      this.appendEventTx(runId, row.item_id, stageRunId, 'stage.completed', evidence, at)
      this.releaseDependenciesTx(runId, row.item_id, at)
      this.recomputeTx(runId, at)
      return this.snapshot(runId)
    })
  }

  gateFailed(runIdValue: string, stageRunIdValue: string, reason: string): WorkflowRunSnapshot {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const row = this.requireStageRow(runId, stageRunId)
      if (row.status !== 'VERIFYING') throw new Error(`stage ${stageRunId} cannot fail gate while ${row.status}`)
      const at = now()
      this.db.prepare("UPDATE stage_runs SET status='FIX_REQUIRED',progress=MIN(progress,0.94),current_activity=?,claim_owner_id=NULL,updated_at=? WHERE stage_run_id=?")
        .run(reason.trim() || 'completion gate failed', at, stageRunId)
      this.appendEventTx(runId, row.item_id, stageRunId, 'stage.fix_required', { reason: reason.trim() || 'completion gate failed' }, at)
      this.recomputeTx(runId, at)
      return this.snapshot(runId)
    })
  }

  blockStage(runIdValue: string, stageRunIdValue: string, reason: string, waitingHuman = false): WorkflowRunSnapshot {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const row = this.requireStageRow(runId, stageRunId)
      const at = now()
      const status: WorkflowStageStatus = waitingHuman ? 'WAITING_HUMAN' : 'BLOCKED'
      this.db.prepare('UPDATE stage_runs SET status=?,current_activity=?,updated_at=? WHERE stage_run_id=?')
        .run(status, reason.trim() || null, at, stageRunId)
      this.appendEventTx(runId, row.item_id, stageRunId, waitingHuman ? 'stage.waiting_human' : 'stage.blocked', { reason }, at)
      this.recomputeTx(runId, at)
      return this.snapshot(runId)
    })
  }

  resumeStage(runIdValue: string, stageRunIdValue: string): WorkflowRunSnapshot {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const row = this.requireStageRow(runId, stageRunId)
      if (!['BLOCKED', 'WAITING_HUMAN'].includes(String(row.status))) throw new Error(`stage ${stageRunId} cannot resume while ${row.status}`)
      const next: WorkflowStageStatus = row.claim_owner_id ? 'RUNNING' : 'READY'
      const at = now()
      this.db.prepare('UPDATE stage_runs SET status=?,current_activity=NULL,updated_at=? WHERE stage_run_id=?').run(next, at, stageRunId)
      this.appendEventTx(runId, row.item_id, stageRunId, 'stage.resumed', { from: row.status, to: next }, at)
      this.recomputeTx(runId, at)
      return this.snapshot(runId)
    })
  }

  registerArtifact(runIdValue: string, itemIdValue: string, seed: WorkflowArtifactSeed): WorkflowArtifactRecord {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const itemId = id(itemIdValue, 'itemId')
      const at = now()
      const record = this.insertArtifactTx(runId, itemId, seed, at)
      this.appendEventTx(runId, itemId, record.stageRunId, 'artifact.available', { artifactId: record.artifactId, logicalName: record.logicalName, storage: record.storage }, at)
      return record
    })
  }


  relocateArtifact(runIdValue: string, artifactIdValue: string, relocation: WorkflowArtifactRelocation): WorkflowArtifactRecord {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const artifactId = id(artifactIdValue, 'artifactId')
      const row = this.db.prepare('SELECT * FROM workflow_artifacts WHERE workflow_run_id=? AND artifact_id=?').get(runId, artifactId) as any
      if (!row) throw new Error(`workflow artifact not found: ${artifactId}`)
      const previous = this.artifactView(row)
      const metadata = { ...previous.metadata, ...(relocation.metadataPatch ?? {}) }
      const at = now()
      this.db.prepare(`UPDATE workflow_artifacts SET storage_json=?,sha256=?,size_bytes=?,state=?,metadata_json=? WHERE workflow_run_id=? AND artifact_id=?`)
        .run(
          json(relocation.storage),
          relocation.sha256 === undefined ? previous.sha256 : relocation.sha256,
          relocation.sizeBytes === undefined ? previous.sizeBytes : relocation.sizeBytes,
          relocation.state ?? previous.state,
          json(metadata),
          runId,
          artifactId
        )
      const updated = this.artifactView(this.db.prepare('SELECT * FROM workflow_artifacts WHERE workflow_run_id=? AND artifact_id=?').get(runId, artifactId))
      this.appendEventTx(runId, updated.itemId, updated.stageRunId, 'artifact.relocated', {
        artifactId,
        from: previous.storage,
        to: updated.storage,
        state: updated.state
      }, at)
      return updated
    })
  }

  ensureExternalJobIntent(
    runIdValue: string,
    stageRunIdValue: string,
    providerValue: string,
    requestKeyValue: string,
    metadata: Readonly<Record<string, unknown>> = {}
  ): WorkflowExternalJobRecord {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const provider = id(providerValue, 'externalJob provider')
      const requestKey = id(requestKeyValue, 'externalJob requestKey')
      const stage = this.requireStageRow(runId, stageRunId)
      const existing = this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? AND stage_run_id=? AND request_key=?').get(runId, stageRunId, requestKey)
      if (existing) {
        const view = this.externalJobView(existing)
        if (view.provider !== provider) throw new Error(`external job intent provider conflicts with existing request ${requestKey}`)
        return view
      }
      const latest = this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? AND stage_run_id=? ORDER BY created_at DESC,job_id DESC LIMIT 1').get(runId, stageRunId)
      if (latest) {
        const previous = this.externalJobView(latest)
        if (!['FAILED', 'CANCELLED'].includes(previous.state)) {
          throw new Error(`external job stage ${stageRunId} already has non-terminal request ${previous.requestKey} in ${previous.state}`)
        }
      }
      const at = now()
      const jobId = `wjob-${randomUUID()}`
      this.db.prepare(`INSERT INTO workflow_external_jobs
        (job_id,workflow_run_id,item_id,stage_run_id,provider,request_key,external_id,state,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,NULL,'PENDING',?,?,?)`)
        .run(jobId, runId, stage.item_id, stageRunId, provider, requestKey, json(metadata), at, at)
      this.appendEventTx(runId, stage.item_id, stageRunId, 'external_job.intent', { jobId, provider, requestKey }, at)
      return this.externalJobView(this.db.prepare('SELECT * FROM workflow_external_jobs WHERE job_id=?').get(jobId))
    })
  }

  recordExternalJobSubmitted(
    runIdValue: string,
    stageRunIdValue: string,
    externalIdValue: string,
    metadataPatch: Readonly<Record<string, unknown>> = {}
  ): WorkflowExternalJobRecord {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const externalId = externalIdValue.trim()
      if (!externalId || externalId.length > 2048 || externalId.includes('\0')) throw new Error('external job id is invalid')
      const row = this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? AND stage_run_id=? ORDER BY created_at DESC,job_id DESC LIMIT 1').get(runId, stageRunId)
      if (!row) throw new Error(`external job intent not found for stage ${stageRunId}`)
      const current = this.externalJobView(row)
      if (current.externalId && current.externalId !== externalId) throw new Error('external job already bound to a different external id')
      const metadata = { ...current.metadata, ...metadataPatch }
      const at = now()
      this.db.prepare("UPDATE workflow_external_jobs SET external_id=?,state='SUBMITTED',metadata_json=?,updated_at=? WHERE job_id=?")
        .run(externalId, json(metadata), at, current.jobId)
      if (current.externalId !== externalId || current.state !== 'SUBMITTED') {
        this.appendEventTx(runId, current.itemId, stageRunId, 'external_job.submitted', { jobId: current.jobId, externalId }, at)
      }
      return this.externalJobView(this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? AND stage_run_id=? ORDER BY created_at DESC,job_id DESC LIMIT 1').get(runId, stageRunId))
    })
  }

  updateExternalJobState(
    runIdValue: string,
    stageRunIdValue: string,
    state: WorkflowExternalJobState,
    metadataPatch: Readonly<Record<string, unknown>> = {}
  ): WorkflowExternalJobRecord {
    const allowed = new Set<WorkflowExternalJobState>(['PENDING', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN'])
    if (!allowed.has(state)) throw new Error('external job state is invalid')
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const row = this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? AND stage_run_id=? ORDER BY created_at DESC,job_id DESC LIMIT 1').get(runId, stageRunId)
      if (!row) throw new Error(`external job intent not found for stage ${stageRunId}`)
      const current = this.externalJobView(row)
      const metadata = { ...current.metadata, ...metadataPatch }
      if (current.state === state && JSON.stringify(current.metadata) === JSON.stringify(metadata)) return current
      const at = now()
      this.db.prepare('UPDATE workflow_external_jobs SET state=?,metadata_json=?,updated_at=? WHERE job_id=?')
        .run(state, json(metadata), at, current.jobId)
      this.appendEventTx(runId, current.itemId, stageRunId, 'external_job.state_changed', { jobId: current.jobId, from: current.state, to: state }, at)
      return this.externalJobView(this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? AND stage_run_id=? ORDER BY created_at DESC,job_id DESC LIMIT 1').get(runId, stageRunId))
    })
  }

  externalJob(runIdValue: string, stageRunIdValue: string): WorkflowExternalJobRecord | null {
    const runId = id(runIdValue, 'workflowRunId')
    const stageRunId = id(stageRunIdValue, 'stageRunId')
    const row = this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? AND stage_run_id=? ORDER BY created_at DESC,job_id DESC LIMIT 1').get(runId, stageRunId)
    return row ? this.externalJobView(row) : null
  }

  listExternalJobs(runIdValue: string): WorkflowExternalJobRecord[] {
    const runId = id(runIdValue, 'workflowRunId')
    return this.db.prepare('SELECT * FROM workflow_external_jobs WHERE workflow_run_id=? ORDER BY created_at,job_id').all(runId).map(row => this.externalJobView(row))
  }

  private missingRequiredOutputsTx(runId: string, itemId: string, stageId: string): string[] {
    const plan = parse<WorkflowRunPlan>(this.requireRunRow(runId).plan_json, {} as WorkflowRunPlan)
    const definition = plan.stages.find(stage => stage.stageId === stageId)
    if (!definition) throw new Error(`workflow stage definition not found: ${stageId}`)
    const rows = this.db.prepare("SELECT logical_name,state FROM workflow_artifacts WHERE workflow_run_id=? AND item_id=? AND stage_id=? AND state IN ('AVAILABLE','VERIFIED')")
      .all(runId, itemId, stageId) as any[]
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(String(row.logical_name), (counts.get(String(row.logical_name)) ?? 0) + 1)
    const missing: string[] = []
    for (const expected of definition.expectedOutputs.filter(output => output.required)) {
      const count = counts.get(expected.logicalName) ?? 0
      const minimum = expected.minCount ?? 1
      if (count < minimum) missing.push(expected.logicalName)
      if (expected.maxCount != null && count > expected.maxCount) missing.push(`${expected.logicalName}(>${expected.maxCount})`)
    }
    return missing
  }

  private transitionStage(
    runIdValue: string,
    stageRunIdValue: string,
    from: readonly WorkflowStageStatus[],
    to: WorkflowStageStatus,
    validate: (row: any) => Record<string, unknown>,
    eventType: string
  ): WorkflowStageRunRecord {
    return this.transaction(() => {
      const runId = id(runIdValue, 'workflowRunId')
      const stageRunId = id(stageRunIdValue, 'stageRunId')
      const row = this.requireStageRow(runId, stageRunId)
      if (!from.includes(row.status as WorkflowStageStatus)) throw new Error(`stage ${stageRunId} cannot transition ${row.status} -> ${to}`)
      validate(row)
      const at = now()
      this.db.prepare('UPDATE stage_runs SET status=?,updated_at=? WHERE stage_run_id=?').run(to, at, stageRunId)
      this.appendEventTx(runId, row.item_id, stageRunId, eventType, { from: row.status, to }, at)
      this.recomputeTx(runId, at)
      return this.stageView(this.requireStageRow(runId, stageRunId))
    })
  }

  private insertArtifactTx(runId: string, itemId: string, seed: WorkflowArtifactSeed, at: string, stageRunIdOverride?: string): WorkflowArtifactRecord {
    const stage = stageRunIdOverride
      ? this.requireStageRow(runId, stageRunIdOverride)
      : this.db.prepare('SELECT * FROM stage_runs WHERE workflow_run_id=? AND item_id=? AND stage_id=?').get(runId, itemId, seed.stageId)
    if (!stage) throw new Error(`artifact stage not found: ${runId}/${itemId}/${seed.stageId}`)
    const artifactId = seed.artifactId?.trim() || `wart-${randomUUID()}`
    const existing = this.db.prepare('SELECT * FROM workflow_artifacts WHERE artifact_id=?').get(artifactId)
    if (existing) return this.artifactView(existing)
    this.db.prepare(`INSERT INTO workflow_artifacts
      (artifact_id,workflow_run_id,item_id,stage_run_id,stage_id,logical_name,kind,mime_type,storage_json,sha256,size_bytes,state,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        artifactId,
        runId,
        itemId,
        stage.stage_run_id,
        stage.stage_id,
        seed.logicalName,
        seed.kind,
        seed.mimeType ?? null,
        json(seed.storage),
        seed.sha256 ?? null,
        seed.sizeBytes ?? null,
        seed.state ?? 'AVAILABLE',
        json(seed.metadata ?? {}),
        at
      )
    return this.artifactView(this.db.prepare('SELECT * FROM workflow_artifacts WHERE artifact_id=?').get(artifactId))
  }

  private releaseDependenciesTx(runId: string, itemId: string, at: string): void {
    const plan = parse<WorkflowRunPlan>(this.requireRunRow(runId).plan_json, {} as WorkflowRunPlan)
    const rows = this.db.prepare('SELECT stage_id,status,stage_run_id FROM stage_runs WHERE workflow_run_id=? AND item_id=?').all(runId, itemId)
    const byStage = new Map(rows.map((row: any) => [String(row.stage_id), row]))
    for (const definition of plan.stages) {
      const row: any = byStage.get(definition.stageId)
      if (!row || row.status !== 'WAITING_DEPENDENCY') continue
      if (!definition.dependsOn.every(dependency => byStage.get(dependency)?.status === 'COMPLETED')) continue
      this.db.prepare("UPDATE stage_runs SET status='READY',updated_at=? WHERE stage_run_id=?").run(at, row.stage_run_id)
      this.appendEventTx(runId, itemId, row.stage_run_id, 'stage.ready', { reason: 'dependencies_completed' }, at)
    }
  }

  private recomputeTx(runId: string, at: string): void {
    const itemRows = this.db.prepare('SELECT item_id FROM work_items WHERE workflow_run_id=? ORDER BY ordinal').all(runId)
    for (const itemRow of itemRows as any[]) {
      const stages = this.db.prepare('SELECT status,progress FROM stage_runs WHERE workflow_run_id=? AND item_id=?').all(runId, itemRow.item_id) as any[]
      const progress = stages.length ? stages.reduce((sum, row) => sum + Number(row.progress), 0) / stages.length : 0
      const statuses = new Set(stages.map(row => String(row.status)))
      const active = ['RUNNING', 'CLAIMED', 'VERIFYING', 'FIX_REQUIRED', 'READY'].some(value => statuses.has(value))
      const status = statuses.size > 0 && [...statuses].every(value => value === 'COMPLETED')
        ? 'COMPLETED'
        : statuses.has('FAILED')
          ? 'FAILED'
          : active
            ? 'RUNNING'
            : statuses.has('BLOCKED') || statuses.has('WAITING_HUMAN')
              ? 'WAITING'
              : 'PENDING'
      this.db.prepare('UPDATE work_items SET status=?,progress=?,updated_at=? WHERE workflow_run_id=? AND item_id=?')
        .run(status, progress, at, runId, itemRow.item_id)
    }
    const items = this.db.prepare('SELECT status,progress FROM work_items WHERE workflow_run_id=?').all(runId) as any[]
    const progress = items.length ? items.reduce((sum, row) => sum + Number(row.progress), 0) / items.length : 0
    const run = this.requireRunRow(runId)
    const stageRows = this.db.prepare('SELECT status FROM stage_runs WHERE workflow_run_id=?').all(runId) as any[]
    const stageStatuses = new Set(stageRows.map(row => String(row.status)))
    const runnable = ['READY', 'CLAIMED', 'RUNNING', 'VERIFYING', 'FIX_REQUIRED'].some(value => stageStatuses.has(value))
    let status: WorkflowRunStatus = run.status as WorkflowRunStatus
    if (items.length > 0 && items.every(row => row.status === 'COMPLETED')) status = 'COMPLETED'
    else if (items.some(row => row.status === 'FAILED')) status = 'FAILED'
    else if (status === 'READY') status = 'READY'
    else if (status !== 'CANCELLED' && runnable) status = 'RUNNING'
    else if (status !== 'CANCELLED' && stageStatuses.has('WAITING_HUMAN')) status = 'WAITING_HUMAN'
    else if (status !== 'CANCELLED' && stageStatuses.has('BLOCKED')) status = 'BLOCKED'
    this.db.prepare('UPDATE workflow_runs SET status=?,progress=?,updated_at=? WHERE workflow_run_id=?').run(status, progress, at, runId)
  }

  private appendEventTx(runId: string, itemId: string | null, stageRunId: string | null, type: string, payload: Record<string, unknown>, at: string): void {
    this.db.prepare('INSERT INTO workflow_events (event_id,workflow_run_id,item_id,stage_run_id,type,payload_json,at) VALUES (?,?,?,?,?,?,?)')
      .run(`wevt-${randomUUID()}`, runId, itemId, stageRunId, type, json(payload), at)
  }

  private requireRunRow(runId: string): any {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE workflow_run_id=?').get(runId)
    if (!row) throw new Error(`workflow run not found: ${runId}`)
    return row
  }

  private requireStageRow(runId: string, stageRunId: string): any {
    const row = this.db.prepare('SELECT * FROM stage_runs WHERE workflow_run_id=? AND stage_run_id=?').get(runId, stageRunId)
    if (!row) throw new Error(`workflow stage run not found: ${stageRunId}`)
    return row
  }

  private runView(row: any): WorkflowRunRecord {
    return {
      workflowRunId: row.workflow_run_id,
      moduleId: row.module_id,
      moduleVersion: row.module_version,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      progress: Number(row.progress),
      metadata: parse(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private itemView(row: any): WorkflowItemRecord {
    return {
      workflowRunId: row.workflow_run_id,
      itemId: row.item_id,
      ordinal: Number(row.ordinal),
      title: row.title,
      status: row.status,
      progress: Number(row.progress),
      metadata: parse(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private stageView(row: any): WorkflowStageRunRecord {
    return {
      stageRunId: row.stage_run_id,
      workflowRunId: row.workflow_run_id,
      itemId: row.item_id,
      stageId: row.stage_id,
      title: row.title,
      executor: row.executor,
      workerDefinitionId: row.worker_definition_id,
      status: row.status,
      progress: Number(row.progress),
      currentActivity: row.current_activity,
      claimOwnerId: row.claim_owner_id,
      attempt: Number(row.attempt),
      maxAttempts: Number(row.max_attempts),
      metadata: parse(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private artifactView(row: any): WorkflowArtifactRecord {
    return {
      contract: ZERO3_WORKFLOW_ARTIFACT,
      artifactId: row.artifact_id,
      workflowRunId: row.workflow_run_id,
      itemId: row.item_id,
      stageRunId: row.stage_run_id,
      stageId: row.stage_id,
      logicalName: row.logical_name,
      kind: row.kind,
      mimeType: row.mime_type,
      storage: parse(row.storage_json, { provider: 'LOCAL' }),
      sha256: row.sha256,
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
      state: row.state,
      metadata: parse(row.metadata_json, {}),
      createdAt: row.created_at
    }
  }

  private externalJobView(row: any): WorkflowExternalJobRecord {
    return {
      jobId: row.job_id,
      workflowRunId: row.workflow_run_id,
      itemId: row.item_id,
      stageRunId: row.stage_run_id,
      provider: row.provider,
      requestKey: row.request_key,
      externalId: row.external_id,
      state: row.state,
      metadata: parse(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private eventView(row: any): WorkflowEventRecord {
    return {
      sequence: Number(row.sequence),
      eventId: row.event_id,
      workflowRunId: row.workflow_run_id,
      itemId: row.item_id,
      stageRunId: row.stage_run_id,
      type: row.type,
      payload: parse(row.payload_json, {}),
      at: row.at
    }
  }
}

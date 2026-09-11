import { createHash, randomUUID } from 'node:crypto'

import {
  nextWorkerGeneration,
  normalizePhysicalWorkerSession,
  normalizeWorkflowArtifactRef,
  normalizeWorkflowWorkUnit,
  normalizeWorkflowWorkerBinding,
  type PhysicalWorkerSession,
  type WorkflowArtifactRef,
  type WorkflowWorkUnit,
  type WorkflowWorkerBinding
} from './contracts.ts'
import {
  issueWorkerBindingTicket,
  verifyWorkerBindingTicket,
  type WorkerBindingTicketClaims
} from './binding-ticket.ts'
import { Zero3WorkflowWorkerStore, workflowJson, workflowParse } from './worker-store.ts'

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
const DEFAULT_LEASE_SECONDS = 30 * 60
const MAX_BATCH_SIZE = 100
const MAX_JSON_BYTES = 1024 * 1024

function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}
function text(value: unknown, label: string, max = 4096): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized
}
function optionalText(value: unknown, label: string, max = 4096): string | null {
  if (value == null || value === '') return null
  return text(value, label, max)
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
  return value
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]))
  }
  return value
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex') }
function plusSeconds(at: string, seconds: number): string { return new Date(new Date(at).getTime() + seconds * 1000).toISOString() }
function iso(value = new Date()): string { return value.toISOString() }
function array(value: unknown, label: string, max = 100_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} items`)
  return value
}

export type WorkflowStageSeed = WorkflowWorkUnit & {
  stageKey: string
  ordinal?: number
  workerDefinitionId: string
  requiredCapability: string
  dependsOn?: string[]
}
export type WorkflowWorkItemSeed = {
  workItemId: string
  ordinal?: number
  title: string
  metadata?: Record<string, unknown>
  stages: WorkflowStageSeed[]
}
export type WorkflowWorkerClaimView = {
  claimId: string
  workflowRunId: string
  workerDefinitionId: string
  workerSlotId: string
  workerSessionId: string
  generation: number
  leaseUntil: string
  units: WorkflowWorkUnit[]
}
export type WorkflowWorkerRuntimeOptions = {
  ticketSecret: string | Uint8Array
  clock?: () => Date
  defaultLeaseSeconds?: number
}

type BindingRow = {
  worker_slot_id: string
  workflow_run_id: string
  worker_definition_id: string
  provider: string
  required_capabilities_json: string
  max_batch_size: number
  session_policy_json: string
  role: string | null
  prompt_revision: string | null
  metadata_json: string
}

export class Zero3WorkflowWorkerRuntime {
  private readonly clock: () => Date
  private readonly defaultLeaseSeconds: number

  constructor(readonly store: Zero3WorkflowWorkerStore, private readonly options: WorkflowWorkerRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.defaultLeaseSeconds = options.defaultLeaseSeconds == null
      ? DEFAULT_LEASE_SECONDS
      : integer(options.defaultLeaseSeconds, 'defaultLeaseSeconds', 1, 86_400)
  }

  private now(): string { return iso(this.clock()) }
  private event(input: {
    workflowRunId: string; type: string; payload?: unknown; workItemId?: string | null;
    stageRunId?: string | null; workerDefinitionId?: string | null; workerSlotId?: string | null;
    workerSessionId?: string | null; claimId?: string | null; at?: string
  }): void {
    this.store.db.prepare(`INSERT INTO workflow_worker_events
      (event_id,workflow_run_id,work_item_id,stage_run_id,worker_definition_id,worker_slot_id,worker_session_id,claim_id,type,payload_json,at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      `wwevt-${randomUUID()}`, input.workflowRunId, input.workItemId ?? null, input.stageRunId ?? null,
      input.workerDefinitionId ?? null, input.workerSlotId ?? null, input.workerSessionId ?? null,
      input.claimId ?? null, input.type, workflowJson(input.payload ?? {}, 'workflow worker event payload'), input.at ?? this.now())
  }

  private idempotent<T>(scopeKey: string, keyValue: unknown, operation: string, request: unknown, run: () => T): T {
    const key = id(keyValue, 'idempotencyKey')
    const requestHash = hash(request)
    const existing = this.store.db.prepare('SELECT operation,request_hash,response_json FROM workflow_worker_idempotency WHERE scope_key=? AND idempotency_key=?')
      .get(scopeKey, key) as any
    if (existing) {
      if (existing.operation !== operation || existing.request_hash !== requestHash) throw new Error('workflow worker idempotency key was reused with different content')
      return workflowParse(existing.response_json, null) as T
    }
    const result = run()
    this.store.db.prepare('INSERT INTO workflow_worker_idempotency (scope_key,idempotency_key,operation,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(scopeKey, key, operation, requestHash, workflowJson(result, 'workflow worker idempotency response'), this.now())
    return result
  }

  private binding(workerSlotIdValue: unknown): { binding: WorkflowWorkerBinding; row: BindingRow; role: string | null; promptRevision: string | null } {
    const workerSlotId = id(workerSlotIdValue, 'workerSlotId')
    const row = this.store.db.prepare('SELECT * FROM workflow_worker_bindings WHERE worker_slot_id=?').get(workerSlotId) as BindingRow | undefined
    if (!row) throw new Error('workflow worker binding not found')
    const run = this.store.db.prepare('SELECT module_id,module_version FROM workflow_runs WHERE workflow_run_id=?').get(row.workflow_run_id) as any
    if (!run) throw new Error('workflow run for binding not found')
    const binding = normalizeWorkflowWorkerBinding({
      workflowRunId: row.workflow_run_id,
      moduleId: run.module_id,
      moduleVersion: run.module_version,
      workerDefinitionId: row.worker_definition_id,
      workerSlotId: row.worker_slot_id,
      provider: row.provider,
      requiredCapabilities: workflowParse(row.required_capabilities_json, []),
      maxBatchSize: Number(row.max_batch_size),
      sessionPolicy: workflowParse(row.session_policy_json, {})
    })
    return { binding, row, role: row.role ?? null, promptRevision: row.prompt_revision ?? null }
  }

  private slot(workerSlotIdValue: unknown): any {
    const workerSlotId = id(workerSlotIdValue, 'workerSlotId')
    const row = this.store.db.prepare('SELECT * FROM worker_slots WHERE worker_slot_id=?').get(workerSlotId) as any
    if (!row) throw new Error('worker slot not found')
    return row
  }

  private session(workerSessionIdValue: unknown): PhysicalWorkerSession {
    const workerSessionId = id(workerSessionIdValue, 'workerSessionId')
    const row = this.store.db.prepare('SELECT * FROM physical_worker_sessions WHERE worker_session_id=?').get(workerSessionId) as any
    if (!row) throw new Error('physical worker session not found')
    return normalizePhysicalWorkerSession({
      workerSlotId: row.worker_slot_id, workerSessionId: row.worker_session_id,
      logicalSessionId: row.logical_session_id, conversationId: row.conversation_id ?? undefined,
      conversationUrl: row.conversation_url ?? undefined, generation: Number(row.generation),
      state: row.state, processedItemCount: Number(row.processed_item_count), startedAt: row.started_at
    })
  }

  ensureWorkflowRun(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'workflow run input')
    const workflowRunId = id(input.workflowRunId, 'workflowRunId')
    const taskId = id(input.taskId, 'taskId')
    const moduleId = id(input.moduleId, 'moduleId')
    const moduleVersion = id(input.moduleVersion, 'moduleVersion')
    const metadata = input.metadata == null ? {} : object(input.metadata, 'workflow run metadata')
    return this.store.transaction(() => {
      const existing = this.store.db.prepare('SELECT * FROM workflow_runs WHERE workflow_run_id=?').get(workflowRunId) as any
      if (existing) {
        if (existing.task_id !== taskId || existing.module_id !== moduleId || existing.module_version !== moduleVersion || existing.metadata_json !== workflowJson(metadata, 'workflow run metadata')) {
          throw new Error('workflow run identity conflicts with existing run')
        }
        return { workflowRunId, taskId, moduleId, moduleVersion, status: existing.status, metadata: workflowParse(existing.metadata_json, {}) }
      }
      const at = this.now()
      this.store.db.prepare(`INSERT INTO workflow_runs
        (workflow_run_id,task_id,module_id,module_version,status,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,'ACTIVE',?,?,?)`).run(workflowRunId, taskId, moduleId, moduleVersion, workflowJson(metadata, 'workflow run metadata'), at, at)
      this.event({ workflowRunId, type: 'workflow_run.created', payload: { taskId, moduleId, moduleVersion }, at })
      return { workflowRunId, taskId, moduleId, moduleVersion, status: 'ACTIVE', metadata }
    })
  }

  ensureWorkerBinding(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'worker binding input')
    const binding = normalizeWorkflowWorkerBinding(input.binding ?? input)
    const role = optionalText(input.role, 'role', 1024)
    const promptRevision = optionalText(input.promptRevision, 'promptRevision', 256)
    const metadata = input.metadata == null ? {} : object(input.metadata, 'worker binding metadata')
    return this.store.transaction(() => {
      const run = this.store.db.prepare('SELECT * FROM workflow_runs WHERE workflow_run_id=?').get(binding.workflowRunId) as any
      if (!run) throw new Error('workflow run must exist before worker binding')
      if (run.module_id !== binding.moduleId || run.module_version !== binding.moduleVersion) throw new Error('worker binding module identity does not match workflow run')
      const current = this.store.db.prepare('SELECT * FROM workflow_worker_bindings WHERE worker_slot_id=?').get(binding.workerSlotId) as any
      const canonical = {
        workflowRunId: binding.workflowRunId, workerDefinitionId: binding.workerDefinitionId,
        provider: binding.provider, requiredCapabilities: binding.requiredCapabilities,
        maxBatchSize: binding.maxBatchSize, sessionPolicy: binding.sessionPolicy,
        role, promptRevision, metadata
      }
      if (current) {
        const existing = {
          workflowRunId: current.workflow_run_id, workerDefinitionId: current.worker_definition_id,
          provider: current.provider, requiredCapabilities: workflowParse(current.required_capabilities_json, []),
          maxBatchSize: Number(current.max_batch_size), sessionPolicy: workflowParse(current.session_policy_json, {}),
          role: current.role ?? null, promptRevision: current.prompt_revision ?? null,
          metadata: workflowParse(current.metadata_json, {})
        }
        if (hash(existing) !== hash(canonical)) throw new Error('worker binding conflicts with existing slot definition')
        return this.workerSlotSnapshot(binding.workerSlotId)
      }
      const at = this.now()
      this.store.db.prepare(`INSERT INTO workflow_worker_bindings
        (worker_slot_id,workflow_run_id,worker_definition_id,provider,required_capabilities_json,max_batch_size,session_policy_json,role,prompt_revision,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        binding.workerSlotId, binding.workflowRunId, binding.workerDefinitionId, binding.provider,
        workflowJson(binding.requiredCapabilities, 'binding capabilities'), binding.maxBatchSize,
        workflowJson(binding.sessionPolicy, 'binding session policy'), role, promptRevision,
        workflowJson(metadata, 'worker binding metadata'), at, at)
      this.store.db.prepare(`INSERT INTO worker_slots
        (worker_slot_id,workflow_run_id,worker_definition_id,generation,state,created_at,updated_at)
        VALUES (?,?,?,1,'IDLE',?,?)`).run(binding.workerSlotId, binding.workflowRunId, binding.workerDefinitionId, at, at)
      this.store.db.prepare('INSERT INTO worker_binding_generations (worker_slot_id,generation,worker_session_id,reason,at) VALUES (?,1,NULL,?,?)')
        .run(binding.workerSlotId, 'binding_created', at)
      this.event({ workflowRunId: binding.workflowRunId, workerDefinitionId: binding.workerDefinitionId, workerSlotId: binding.workerSlotId, type: 'worker_slot.created', payload: { requiredCapabilities: binding.requiredCapabilities, maxBatchSize: binding.maxBatchSize }, at })
      return this.workerSlotSnapshot(binding.workerSlotId)
    })
  }

  workerSlotSnapshot(workerSlotIdValue: unknown): Record<string, unknown> {
    const { binding, role, promptRevision, row } = this.binding(workerSlotIdValue)
    const slot = this.slot(binding.workerSlotId)
    const activeSession = slot.active_worker_session_id ? this.session(slot.active_worker_session_id) : null
    return {
      binding,
      role,
      promptRevision,
      metadata: workflowParse(row.metadata_json, {}),
      slot: {
        workerSlotId: slot.worker_slot_id,
        workflowRunId: slot.workflow_run_id,
        workerDefinitionId: slot.worker_definition_id,
        generation: Number(slot.generation),
        state: slot.state,
        activeWorkerSessionId: slot.active_worker_session_id ?? null
      },
      activeSession
    }
  }

  addWorkItems(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'work item seed input')
    const workflowRunId = id(input.workflowRunId, 'workflowRunId')
    const items = array(input.items, 'items', 10_000)
    if (items.length === 0) throw new Error('items must contain at least one WorkItem')
    const key = input.idempotencyKey
    return this.store.transaction(() => this.idempotent(`workflow:${workflowRunId}:seed`, key, 'add_work_items', { workflowRunId, items }, () => {
      const run = this.store.db.prepare('SELECT * FROM workflow_runs WHERE workflow_run_id=?').get(workflowRunId) as any
      if (!run) throw new Error('workflow run not found')
      const maxItem = this.store.db.prepare('SELECT COALESCE(MAX(ordinal),0) AS value FROM work_items WHERE workflow_run_id=?').get(workflowRunId) as any
      let nextItemOrdinal = Number(maxItem.value) + 1
      const stageDependencies: Array<{ stageRunId: string; dependsOn: string[] }> = []
      const insertedStageIds: string[] = []
      const insertedItemIds: string[] = []
      for (const [itemIndex, rawValue] of items.entries()) {
        const raw = object(rawValue, `items[${itemIndex}]`)
        const workItemId = id(raw.workItemId, `items[${itemIndex}].workItemId`)
        const title = text(raw.title, `items[${itemIndex}].title`, 1024)
        const ordinal = raw.ordinal == null ? nextItemOrdinal++ : integer(raw.ordinal, 'workItem ordinal', 1, 2_147_483_647)
        const metadata = raw.metadata == null ? {} : object(raw.metadata, 'workItem metadata')
        const stages = array(raw.stages, `items[${itemIndex}].stages`, 1000)
        if (stages.length === 0) throw new Error(`WorkItem ${workItemId} must contain at least one StageRun`)
        if (this.store.db.prepare('SELECT 1 FROM work_items WHERE workflow_run_id=? AND work_item_id=?').get(workflowRunId, workItemId)) {
          throw new Error(`WorkItem already exists: ${workItemId}`)
        }
        const at = this.now()
        this.store.db.prepare(`INSERT INTO work_items
          (workflow_run_id,work_item_id,ordinal,title,status,metadata_json,created_at,updated_at)
          VALUES (?,?,?,?, 'PENDING', ?,?,?)`).run(workflowRunId, workItemId, ordinal, title, workflowJson(metadata, 'workItem metadata'), at, at)
        insertedItemIds.push(workItemId)
        for (const [stageIndex, stageValue] of stages.entries()) {
          const stage = object(stageValue, `stages[${stageIndex}]`)
          const stageRunId = id(stage.stageRunId, 'stageRunId')
          const stageKey = id(stage.stageKey, 'stageKey')
          const workerDefinitionId = id(stage.workerDefinitionId, 'workerDefinitionId')
          const requiredCapability = id(stage.requiredCapability, 'requiredCapability')
          const normalized = normalizeWorkflowWorkUnit({
            workItemId,
            stageRunId,
            title: stage.title ?? title,
            instruction: stage.instruction,
            skill: stage.skill,
            inputs: stage.inputs ?? [],
            expectedOutputs: stage.expectedOutputs ?? [],
            policy: stage.policy,
            metadata: stage.metadata ?? {}
          })
          const stageOrdinal = stage.ordinal == null ? stageIndex + 1 : integer(stage.ordinal, 'stage ordinal', 1, 2_147_483_647)
          if (this.store.db.prepare('SELECT 1 FROM stage_runs WHERE stage_run_id=?').get(stageRunId)) throw new Error(`StageRun already exists: ${stageRunId}`)
          const policy = normalized.policy
          this.store.db.prepare(`INSERT INTO stage_runs
            (stage_run_id,workflow_run_id,work_item_id,stage_key,ordinal,worker_definition_id,required_capability,status,instruction,
             skill_json,inputs_json,expected_outputs_json,policy_json,metadata_json,max_attempts,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,'PENDING',?,?,?,?,?,?,?, ?,?)`).run(
            stageRunId, workflowRunId, workItemId, stageKey, stageOrdinal, workerDefinitionId, requiredCapability,
            normalized.instruction, normalized.skill == null ? null : workflowJson(normalized.skill, 'stage skill'),
            workflowJson(normalized.inputs, 'stage inputs'), workflowJson(normalized.expectedOutputs, 'stage expected outputs'),
            workflowJson(policy, 'stage policy'), workflowJson(normalized.metadata, 'stage metadata'), policy.maxAttempts, at, at)
          const dependsOn = array(stage.dependsOn ?? [], 'stage dependencies', 1000).map((value, depIndex) => id(value, `dependsOn[${depIndex}]`))
          if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`StageRun ${stageRunId} contains duplicate dependencies`)
          if (dependsOn.includes(stageRunId)) throw new Error(`StageRun ${stageRunId} cannot depend on itself`)
          stageDependencies.push({ stageRunId, dependsOn })
          insertedStageIds.push(stageRunId)
        }
      }
      for (const entry of stageDependencies) {
        for (const parent of entry.dependsOn) {
          const parentRow = this.store.db.prepare('SELECT workflow_run_id FROM stage_runs WHERE stage_run_id=?').get(parent) as any
          if (!parentRow || parentRow.workflow_run_id !== workflowRunId) throw new Error(`unknown or cross-run dependency ${parent} for ${entry.stageRunId}`)
          this.store.db.prepare('INSERT INTO stage_dependencies (stage_run_id,depends_on_stage_run_id) VALUES (?,?)').run(entry.stageRunId, parent)
        }
      }
      for (const stageRunId of insertedStageIds) this.recalculateStageReadiness(stageRunId, this.now())
      for (const workItemId of insertedItemIds) this.recalculateWorkItem(workflowRunId, workItemId, this.now())
      this.event({ workflowRunId, type: 'work_items.added', payload: { workItemIds: insertedItemIds, stageRunIds: insertedStageIds } })
      return {
        addedWorkItems: insertedItemIds.length,
        addedStageRuns: insertedStageIds.length,
        counts: this.workflowCounts(workflowRunId)
      }
    }))
  }

  private recalculateStageReadiness(stageRunIdValue: unknown, at: string): string {
    const stageRunId = id(stageRunIdValue, 'stageRunId')
    const row = this.store.db.prepare('SELECT * FROM stage_runs WHERE stage_run_id=?').get(stageRunId) as any
    if (!row) throw new Error('StageRun not found')
    if (!['PENDING', 'READY'].includes(row.status)) return row.status
    const unresolved = this.store.db.prepare(`SELECT COUNT(*) AS value FROM stage_dependencies d
      JOIN stage_runs parent ON parent.stage_run_id=d.depends_on_stage_run_id
      WHERE d.stage_run_id=? AND parent.status!='COMPLETED'`).get(stageRunId) as any
    const status = Number(unresolved.value) === 0 ? 'READY' : 'PENDING'
    if (row.status !== status) this.store.db.prepare('UPDATE stage_runs SET status=?,updated_at=? WHERE stage_run_id=?').run(status, at, stageRunId)
    return status
  }

  private recalculateWorkItem(workflowRunId: string, workItemId: string, at: string): { status: string; becameCompleted: boolean } {
    const item = this.store.db.prepare('SELECT status FROM work_items WHERE workflow_run_id=? AND work_item_id=?').get(workflowRunId, workItemId) as any
    if (!item) throw new Error('WorkItem not found')
    const rows = this.store.db.prepare('SELECT status FROM stage_runs WHERE workflow_run_id=? AND work_item_id=?').all(workflowRunId, workItemId) as any[]
    if (rows.length === 0) throw new Error('WorkItem has no StageRuns')
    const statuses = rows.map(row => String(row.status))
    let status = 'PENDING'
    if (statuses.every(value => value === 'COMPLETED')) status = 'COMPLETED'
    else if (statuses.some(value => value === 'FAILED' || value === 'BLOCKED')) status = 'BLOCKED'
    else if (statuses.some(value => ['CLAIMED', 'RUNNING'].includes(value))) status = 'RUNNING'
    else if (statuses.some(value => value === 'READY')) status = 'READY'
    const becameCompleted = item.status !== 'COMPLETED' && status === 'COMPLETED'
    if (item.status !== status) this.store.db.prepare('UPDATE work_items SET status=?,updated_at=? WHERE workflow_run_id=? AND work_item_id=?').run(status, at, workflowRunId, workItemId)
    return { status, becameCompleted }
  }

  workflowCounts(workflowRunIdValue: unknown): Record<string, number> {
    const workflowRunId = id(workflowRunIdValue, 'workflowRunId')
    const items = this.store.db.prepare('SELECT status,COUNT(*) AS value FROM work_items WHERE workflow_run_id=? GROUP BY status').all(workflowRunId) as any[]
    const stages = this.store.db.prepare('SELECT status,COUNT(*) AS value FROM stage_runs WHERE workflow_run_id=? GROUP BY status').all(workflowRunId) as any[]
    const result: Record<string, number> = { workItemsTotal: 0, stageRunsTotal: 0 }
    for (const row of items) {
      result.workItemsTotal += Number(row.value)
      result[`workItems${String(row.status).toLowerCase().replace(/(^|_)([a-z])/g, (_: string, __: string, c: string) => c.toUpperCase())}`] = Number(row.value)
    }
    for (const row of stages) {
      result.stageRunsTotal += Number(row.value)
      result[`stageRuns${String(row.status).toLowerCase().replace(/(^|_)([a-z])/g, (_: string, __: string, c: string) => c.toUpperCase())}`] = Number(row.value)
    }
    return result
  }

  workflowSnapshot(workflowRunIdValue: unknown): Record<string, unknown> {
    const workflowRunId = id(workflowRunIdValue, 'workflowRunId')
    const run = this.store.db.prepare('SELECT * FROM workflow_runs WHERE workflow_run_id=?').get(workflowRunId) as any
    if (!run) throw new Error('workflow run not found')
    const items = (this.store.db.prepare('SELECT * FROM work_items WHERE workflow_run_id=? ORDER BY ordinal,work_item_id').all(workflowRunId) as any[])
      .map(row => ({ workItemId: row.work_item_id, ordinal: Number(row.ordinal), title: row.title, status: row.status, metadata: workflowParse(row.metadata_json, {}) }))
    const stages = (this.store.db.prepare('SELECT * FROM stage_runs WHERE workflow_run_id=? ORDER BY work_item_id,ordinal,stage_run_id').all(workflowRunId) as any[])
      .map(row => this.stageView(row))
    const slots = (this.store.db.prepare('SELECT worker_slot_id FROM worker_slots WHERE workflow_run_id=? ORDER BY worker_slot_id').all(workflowRunId) as any[])
      .map(row => this.workerSlotSnapshot(row.worker_slot_id))
    const claims = (this.store.db.prepare('SELECT * FROM workflow_claims WHERE workflow_run_id=? ORDER BY created_at,claim_id').all(workflowRunId) as any[])
      .map(row => this.claimView(row.claim_id))
    return {
      run: {
        workflowRunId: run.workflow_run_id, taskId: run.task_id, moduleId: run.module_id,
        moduleVersion: run.module_version, status: run.status, metadata: workflowParse(run.metadata_json, {})
      },
      counts: this.workflowCounts(workflowRunId), items, stages, slots, claims
    }
  }

  private stageView(rowValue: any): Record<string, unknown> {
    const row = rowValue?.stage_run_id
      ? rowValue
      : this.store.db.prepare('SELECT * FROM stage_runs WHERE stage_run_id=?').get(id(rowValue, 'stageRunId')) as any
    if (!row) throw new Error('StageRun not found')
    const workItem = this.store.db.prepare('SELECT title FROM work_items WHERE workflow_run_id=? AND work_item_id=?')
      .get(row.workflow_run_id, row.work_item_id) as any
    return {
      workItemId: row.work_item_id,
      stageRunId: row.stage_run_id,
      stageKey: row.stage_key,
      status: row.status,
      title: workItem?.title ?? row.work_item_id,
      instruction: row.instruction,
      ...(row.skill_json ? { skill: workflowParse(row.skill_json, null) } : {}),
      inputs: workflowParse(row.inputs_json, []),
      expectedOutputs: workflowParse(row.expected_outputs_json, []),
      policy: workflowParse(row.policy_json, {}),
      metadata: workflowParse(row.metadata_json, {}),
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      artifacts: workflowParse(row.artifacts_json, []),
      lastError: row.last_error ?? null
    }
  }

  private claimView(claimIdValue: unknown): WorkflowWorkerClaimView {
    const claimId = id(claimIdValue, 'claimId')
    const row = this.store.db.prepare('SELECT * FROM workflow_claims WHERE claim_id=?').get(claimId) as any
    if (!row) throw new Error('workflow claim not found')
    const stageRows = this.store.db.prepare(`SELECT s.* FROM workflow_claim_units u
      JOIN stage_runs s ON s.stage_run_id=u.stage_run_id
      WHERE u.claim_id=? ORDER BY s.ordinal,s.stage_run_id`).all(claimId) as any[]
    return {
      claimId,
      workflowRunId: row.workflow_run_id,
      workerDefinitionId: row.worker_definition_id,
      workerSlotId: row.worker_slot_id,
      workerSessionId: row.worker_session_id,
      generation: Number(row.generation),
      leaseUntil: row.lease_until,
      units: stageRows.map(stage => this.stageView(stage) as unknown as WorkflowWorkUnit)
    }
  }

  private currentClaims(workerSlotId: string): any[] {
    return this.store.db.prepare("SELECT * FROM workflow_claims WHERE worker_slot_id=? AND status='ACTIVE' ORDER BY created_at")
      .all(workerSlotId) as any[]
  }

  private expireClaimsTx(workflowRunId: string, at: string): string[] {
    const rows = this.store.db.prepare("SELECT * FROM workflow_claims WHERE workflow_run_id=? AND status='ACTIVE' AND lease_until<=? ORDER BY created_at")
      .all(workflowRunId, at) as any[]
    const expired: string[] = []
    for (const claim of rows) {
      const stages = this.store.db.prepare(`SELECT s.* FROM workflow_claim_units u JOIN stage_runs s ON s.stage_run_id=u.stage_run_id WHERE u.claim_id=?`)
        .all(claim.claim_id) as any[]
      for (const stage of stages) {
        if (!['CLAIMED', 'RUNNING'].includes(stage.status)) continue
        const next = Number(stage.attempts) >= Number(stage.max_attempts) ? 'FAILED' : 'READY'
        this.store.db.prepare('UPDATE stage_runs SET status=?,claim_id=NULL,last_error=?,updated_at=? WHERE stage_run_id=?')
          .run(next, next === 'FAILED' ? 'lease expired; attempt budget exhausted' : 'lease expired', at, stage.stage_run_id)
        this.recalculateWorkItem(workflowRunId, stage.work_item_id, at)
      }
      this.store.db.prepare("UPDATE workflow_claims SET status='EXPIRED',updated_at=?,completed_at=? WHERE claim_id=?")
        .run(at, at, claim.claim_id)
      expired.push(claim.claim_id)
      this.event({ workflowRunId, claimId: claim.claim_id, workerDefinitionId: claim.worker_definition_id,
        workerSlotId: claim.worker_slot_id, workerSessionId: claim.worker_session_id,
        type: 'claim.expired', payload: { generation: Number(claim.generation) }, at })
    }
    return expired
  }

  private verifiedTicket(ticketValue: unknown): { claims: WorkerBindingTicketClaims; binding: WorkflowWorkerBinding; slot: any; session: PhysicalWorkerSession } {
    const ticket = text(ticketValue, 'bindingTicket', 16_384)
    const preliminary = verifyWorkerBindingTicket(ticket, { secret: this.options.ticketSecret, clock: this.clock })
    const slot = this.slot(preliminary.workerSlotId)
    const session = this.session(preliminary.workerSessionId)
    const { binding } = this.binding(preliminary.workerSlotId)
    const claims = verifyWorkerBindingTicket(ticket, {
      secret: this.options.ticketSecret,
      clock: this.clock,
      expected: {
        workflowRunId: binding.workflowRunId,
        workerDefinitionId: binding.workerDefinitionId,
        workerSlotId: binding.workerSlotId,
        workerSessionId: session.workerSessionId,
        provider: 'GPT_WEB',
        generation: Number(slot.generation)
      }
    })
    if (slot.active_worker_session_id !== session.workerSessionId) throw new Error('worker binding ticket session is no longer active')
    if (session.generation !== Number(slot.generation)) throw new Error('physical worker session generation is stale')
    if (['LOST', 'CLOSED'].includes(session.state)) throw new Error(`physical worker session is ${session.state}`)
    return { claims, binding, slot, session }
  }

  openPhysicalSession(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'physical worker session input')
    const workerSlotId = id(input.workerSlotId, 'workerSlotId')
    const logicalSessionId = text(input.logicalSessionId, 'logicalSessionId', 512)
    const conversationId = optionalText(input.conversationId, 'conversationId', 512)
    const conversationUrl = optionalText(input.conversationUrl, 'conversationUrl', 4096)
    return this.store.transaction(() => {
      const { binding } = this.binding(workerSlotId)
      const slot = this.slot(workerSlotId)
      this.expireClaimsTx(binding.workflowRunId, this.now())
      if (slot.active_worker_session_id) {
        const active = this.session(slot.active_worker_session_id)
        if (!['CLOSED', 'LOST'].includes(active.state)) throw new Error('worker slot already has an active physical session')
      }
      const workerSessionId = `gptws-${randomUUID()}`
      const at = this.now()
      const session = normalizePhysicalWorkerSession({
        workerSlotId, workerSessionId, logicalSessionId,
        ...(conversationId ? { conversationId } : {}), ...(conversationUrl ? { conversationUrl } : {}),
        generation: Number(slot.generation), state: 'ACTIVE', processedItemCount: 0, startedAt: at
      })
      this.store.db.prepare(`INSERT INTO physical_worker_sessions
        (worker_session_id,worker_slot_id,generation,logical_session_id,conversation_id,conversation_url,state,processed_item_count,started_at,last_activity_at)
        VALUES (?,?,?,?,?,?, 'ACTIVE',0,?,?)`).run(workerSessionId, workerSlotId, session.generation, logicalSessionId, conversationId, conversationUrl, at, at)
      this.store.db.prepare("UPDATE worker_slots SET active_worker_session_id=?,state='ACTIVE',updated_at=? WHERE worker_slot_id=?")
        .run(workerSessionId, at, workerSlotId)
      this.store.db.prepare('UPDATE worker_binding_generations SET worker_session_id=? WHERE worker_slot_id=? AND generation=?')
        .run(workerSessionId, workerSlotId, session.generation)
      const issued = issueWorkerBindingTicket(binding, session, { secret: this.options.ticketSecret, clock: this.clock })
      this.event({ workflowRunId: binding.workflowRunId, workerDefinitionId: binding.workerDefinitionId,
        workerSlotId, workerSessionId, type: 'physical_session.opened', payload: { generation: session.generation, logicalSessionId }, at })
      return { workerSessionId, generation: session.generation, ticket: issued.ticket, binding, session }
    })
  }

  bootstrapWorker(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'bootstrap_worker input')
    const verified = this.verifiedTicket(input.bindingTicket ?? input.ticket)
    return this.store.transaction(() => {
      const at = this.now()
      this.store.db.prepare("UPDATE physical_worker_sessions SET state='ACTIVE',last_activity_at=? WHERE worker_session_id=?")
        .run(at, verified.session.workerSessionId)
      this.store.db.prepare("UPDATE worker_slots SET state='ACTIVE',updated_at=? WHERE worker_slot_id=?")
        .run(at, verified.binding.workerSlotId)
      const active = this.currentClaims(verified.binding.workerSlotId)
        .find(row => row.worker_session_id === verified.session.workerSessionId)
      const { role, promptRevision } = this.binding(verified.binding.workerSlotId)
      return {
        workflowRunId: verified.binding.workflowRunId,
        workerDefinitionId: verified.binding.workerDefinitionId,
        workerSlotId: verified.binding.workerSlotId,
        workerSessionId: verified.session.workerSessionId,
        generation: verified.claims.generation,
        role,
        promptRevision,
        maxBatchSize: verified.binding.maxBatchSize,
        activeClaim: active ? this.claimView(active.claim_id) : null,
        rules: ['claim_only_assigned_work','use_required_skill','register_structured_artifacts','do_not_modify_workflow','do_not_self_complete_workflow']
      }
    })
  }

  private createClaimTx(
    verified: { claims: WorkerBindingTicketClaims; binding: WorkflowWorkerBinding; slot: any; session: PhysicalWorkerSession },
    maxItems: number,
    leaseSeconds: number,
    at: string
  ): WorkflowWorkerClaimView | null {
    const existing = this.currentClaims(verified.binding.workerSlotId)
      .find(row => row.worker_session_id === verified.session.workerSessionId)
    if (existing) return this.claimView(existing.claim_id)
    if (['ROTATING', 'CLOSED', 'LOST'].includes(String(verified.slot.state))) return null
    const rows = this.store.db.prepare(`SELECT s.* FROM stage_runs s
      JOIN work_items i ON i.workflow_run_id=s.workflow_run_id AND i.work_item_id=s.work_item_id
      WHERE s.workflow_run_id=? AND s.worker_definition_id=? AND s.status='READY'
        AND s.attempts < s.max_attempts
      ORDER BY i.ordinal,s.ordinal,s.stage_run_id LIMIT ?`)
      .all(verified.binding.workflowRunId, verified.binding.workerDefinitionId, maxItems) as any[]
    const eligible = rows.filter(row => verified.claims.allowedCapabilities.includes(row.required_capability))
    if (eligible.length === 0) return null
    const claimId = `wfclaim-${randomUUID()}`
    const leaseUntil = plusSeconds(at, leaseSeconds)
    this.store.db.prepare(`INSERT INTO workflow_claims
      (claim_id,workflow_run_id,worker_definition_id,worker_slot_id,worker_session_id,generation,status,lease_until,created_at,updated_at)
      VALUES (?,?,?,?,?,?, 'ACTIVE', ?,?,?)`).run(
      claimId, verified.binding.workflowRunId, verified.binding.workerDefinitionId,
      verified.binding.workerSlotId, verified.session.workerSessionId, verified.claims.generation,
      leaseUntil, at, at)
    for (const row of eligible) {
      this.store.db.prepare('INSERT INTO workflow_claim_units (claim_id,stage_run_id) VALUES (?,?)').run(claimId, row.stage_run_id)
      this.store.db.prepare("UPDATE stage_runs SET status='CLAIMED',claim_id=?,attempts=attempts+1,updated_at=? WHERE stage_run_id=? AND status='READY'")
        .run(claimId, at, row.stage_run_id)
      this.recalculateWorkItem(verified.binding.workflowRunId, row.work_item_id, at)
    }
    this.store.db.prepare("UPDATE physical_worker_sessions SET state='ACTIVE',last_activity_at=? WHERE worker_session_id=?")
      .run(at, verified.session.workerSessionId)
    this.store.db.prepare("UPDATE worker_slots SET state='ACTIVE',updated_at=? WHERE worker_slot_id=?")
      .run(at, verified.binding.workerSlotId)
    this.event({ workflowRunId: verified.binding.workflowRunId, workerDefinitionId: verified.binding.workerDefinitionId,
      workerSlotId: verified.binding.workerSlotId, workerSessionId: verified.session.workerSessionId,
      claimId, type: 'claim.created', payload: { stageRunIds: eligible.map(row => row.stage_run_id), leaseUntil }, at })
    return this.claimView(claimId)
  }

  claimWorkV2(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'workflow claim input')
    const verified = this.verifiedTicket(input.bindingTicket ?? input.ticket)
    const maxItems = Math.min(verified.binding.maxBatchSize,
      input.maxItems == null ? verified.binding.maxBatchSize : integer(input.maxItems, 'maxItems', 1, MAX_BATCH_SIZE))
    const leaseSeconds = input.leaseSeconds == null
      ? this.defaultLeaseSeconds
      : integer(input.leaseSeconds, 'leaseSeconds', 1, 86_400)
    const key = input.idempotencyKey
    return this.store.transaction(() => this.idempotent(
      `workflow:${verified.binding.workflowRunId}:session:${verified.session.workerSessionId}`,
      key,
      'claim_work_v2',
      { ticketId: verified.claims.ticketId, maxItems, leaseSeconds },
      () => {
        const at = this.now()
        this.expireClaimsTx(verified.binding.workflowRunId, at)
        const refreshed = this.verifiedTicket(input.bindingTicket ?? input.ticket)
        const claim = this.createClaimTx(refreshed, maxItems, leaseSeconds, at)
        if (!claim) {
          this.store.db.prepare("UPDATE physical_worker_sessions SET state='WAITING',last_activity_at=? WHERE worker_session_id=?")
            .run(at, refreshed.session.workerSessionId)
          this.store.db.prepare("UPDATE worker_slots SET state='WAITING',updated_at=? WHERE worker_slot_id=?")
            .run(at, refreshed.binding.workerSlotId)
          return { state: 'NO_WORK_AVAILABLE', workflowRunId: refreshed.binding.workflowRunId, counts: this.workflowCounts(refreshed.binding.workflowRunId) }
        }
        return { state: 'CLAIMED', claim, counts: this.workflowCounts(refreshed.binding.workflowRunId) }
      }
    ))
  }

  private requireActiveClaim(verified: { claims: WorkerBindingTicketClaims; binding: WorkflowWorkerBinding; session: PhysicalWorkerSession }, claimIdValue: unknown): any {
    const claimId = id(claimIdValue, 'claimId')
    const row = this.store.db.prepare('SELECT * FROM workflow_claims WHERE claim_id=?').get(claimId) as any
    if (!row) throw new Error('workflow claim not found')
    if (row.workflow_run_id !== verified.binding.workflowRunId || row.worker_slot_id !== verified.binding.workerSlotId ||
        row.worker_session_id !== verified.session.workerSessionId || Number(row.generation) !== verified.claims.generation) {
      throw new Error('workflow claim is outside the Worker Binding Ticket scope')
    }
    if (row.status !== 'ACTIVE') throw new Error(`workflow claim is ${row.status}`)
    if (row.lease_until <= this.now()) throw new Error('workflow claim lease has expired')
    return row
  }

  reportProgressV2(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'workflow progress input')
    const verified = this.verifiedTicket(input.bindingTicket ?? input.ticket)
    const progress = Number(input.progress)
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('progress must be between 0 and 1')
    const activity = optionalText(input.currentActivity, 'currentActivity', 2048)
    const leaseSeconds = input.leaseSeconds == null ? this.defaultLeaseSeconds : integer(input.leaseSeconds, 'leaseSeconds', 1, 86_400)
    const key = input.idempotencyKey
    return this.store.transaction(() => this.idempotent(
      `workflow:${verified.binding.workflowRunId}:session:${verified.session.workerSessionId}`,
      key,
      'report_progress_v2',
      { claimId: input.claimId, progress, activity, leaseSeconds },
      () => {
        const claim = this.requireActiveClaim(verified, input.claimId)
        const at = this.now()
        const leaseUntil = plusSeconds(at, leaseSeconds)
        this.store.db.prepare('UPDATE workflow_claims SET lease_until=?,updated_at=? WHERE claim_id=?').run(leaseUntil, at, claim.claim_id)
        const stageRows = this.store.db.prepare(`SELECT s.* FROM workflow_claim_units u JOIN stage_runs s ON s.stage_run_id=u.stage_run_id WHERE u.claim_id=?`)
          .all(claim.claim_id) as any[]
        for (const stage of stageRows) {
          if (stage.status === 'CLAIMED') this.store.db.prepare("UPDATE stage_runs SET status='RUNNING',updated_at=? WHERE stage_run_id=?").run(at, stage.stage_run_id)
        }
        this.store.db.prepare('UPDATE physical_worker_sessions SET last_activity_at=? WHERE worker_session_id=?')
          .run(at, verified.session.workerSessionId)
        this.event({ workflowRunId: verified.binding.workflowRunId, workerDefinitionId: verified.binding.workerDefinitionId,
          workerSlotId: verified.binding.workerSlotId, workerSessionId: verified.session.workerSessionId,
          claimId: claim.claim_id, type: 'claim.progress', payload: { progress, currentActivity: activity, leaseUntil }, at })
        return { claimId: claim.claim_id, progress, currentActivity: activity, leaseUntil }
      }
    ))
  }

  private expectedOutputsSatisfied(stage: any, artifacts: WorkflowArtifactRef[]): void {
    const expected = workflowParse<any[]>(stage.expected_outputs_json, [])
    for (const output of expected) {
      if (output?.required === false) continue
      const name = String(output?.logicalName ?? '').trim()
      if (!name) continue
      if (!artifacts.some(artifact => artifact.logicalName === name)) throw new Error(`required output missing for ${stage.stage_run_id}: ${name}`)
    }
  }

  commitAndClaimNext(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'commit_and_claim_next input')
    const verified = this.verifiedTicket(input.bindingTicket ?? input.ticket)
    const rawArtifacts = array(input.artifacts ?? [], 'artifacts', 1000)
    const artifacts = rawArtifacts.map(normalizeWorkflowArtifactRef)
    const maxItems = Math.min(verified.binding.maxBatchSize,
      input.maxItems == null ? verified.binding.maxBatchSize : integer(input.maxItems, 'maxItems', 1, MAX_BATCH_SIZE))
    const leaseSeconds = input.leaseSeconds == null ? this.defaultLeaseSeconds : integer(input.leaseSeconds, 'leaseSeconds', 1, 86_400)
    const key = input.idempotencyKey
    return this.store.transaction(() => this.idempotent(
      `workflow:${verified.binding.workflowRunId}:session:${verified.session.workerSessionId}`,
      key,
      'commit_and_claim_next_v2',
      { claimId: input.claimId, artifacts, maxItems, leaseSeconds },
      () => {
        const claim = this.requireActiveClaim(verified, input.claimId)
        const at = this.now()
        const stages = this.store.db.prepare(`SELECT s.* FROM workflow_claim_units u JOIN stage_runs s ON s.stage_run_id=u.stage_run_id WHERE u.claim_id=? ORDER BY s.ordinal,s.stage_run_id`)
          .all(claim.claim_id) as any[]
        const claimedIds = new Set(stages.map(stage => String(stage.stage_run_id)))
        for (const artifact of artifacts) {
          if (artifact.workflowRunId !== verified.binding.workflowRunId || !claimedIds.has(artifact.stageRunId)) {
            throw new Error(`artifact ${artifact.artifactId} is outside the active claim`)
          }
          if (artifact.producer.workerDefinitionId !== verified.binding.workerDefinitionId ||
              artifact.producer.workerSlotId !== verified.binding.workerSlotId ||
              artifact.producer.workerSessionId !== verified.session.workerSessionId) {
            throw new Error(`artifact ${artifact.artifactId} producer does not match the active Worker Binding`)
          }
        }
        const releasedStages: string[] = []
        const completedWorkItems = new Set<string>()
        for (const stage of stages) {
          const stageArtifacts = artifacts.filter(artifact => artifact.stageRunId === stage.stage_run_id)
          this.expectedOutputsSatisfied(stage, stageArtifacts)
          this.store.db.prepare(`UPDATE stage_runs SET status='COMPLETED',claim_id=NULL,artifacts_json=?,last_error=NULL,updated_at=? WHERE stage_run_id=?`)
            .run(workflowJson(stageArtifacts, 'stage artifacts'), at, stage.stage_run_id)
          const dependents = this.store.db.prepare('SELECT stage_run_id FROM stage_dependencies WHERE depends_on_stage_run_id=? ORDER BY stage_run_id')
            .all(stage.stage_run_id) as any[]
          for (const dependent of dependents) {
            const before = this.store.db.prepare('SELECT status FROM stage_runs WHERE stage_run_id=?').get(dependent.stage_run_id) as any
            const next = this.recalculateStageReadiness(dependent.stage_run_id, at)
            if (before?.status !== 'READY' && next === 'READY') releasedStages.push(dependent.stage_run_id)
          }
          const workItem = this.recalculateWorkItem(verified.binding.workflowRunId, stage.work_item_id, at)
          if (workItem.becameCompleted) completedWorkItems.add(stage.work_item_id)
          this.event({ workflowRunId: verified.binding.workflowRunId, workItemId: stage.work_item_id,
            stageRunId: stage.stage_run_id, workerDefinitionId: verified.binding.workerDefinitionId,
            workerSlotId: verified.binding.workerSlotId, workerSessionId: verified.session.workerSessionId,
            claimId: claim.claim_id, type: 'stage.completed', payload: { artifactIds: stageArtifacts.map(a => a.artifactId) }, at })
        }
        this.store.db.prepare("UPDATE workflow_claims SET status='COMPLETED',updated_at=?,completed_at=? WHERE claim_id=?")
          .run(at, at, claim.claim_id)
        const processedDelta = completedWorkItems.size || new Set(stages.map(stage => stage.work_item_id)).size
        this.store.db.prepare('UPDATE physical_worker_sessions SET processed_item_count=processed_item_count+?,last_activity_at=? WHERE worker_session_id=?')
          .run(processedDelta, at, verified.session.workerSessionId)
        const refreshedSession = this.session(verified.session.workerSessionId)
        const limit = verified.binding.sessionPolicy.maxItemsPerPhysicalSession
        const rotateRequired = limit != null && refreshedSession.processedItemCount >= limit
        if (rotateRequired) {
          this.store.db.prepare("UPDATE physical_worker_sessions SET state='ROTATING',last_activity_at=? WHERE worker_session_id=?")
            .run(at, refreshedSession.workerSessionId)
          this.store.db.prepare("UPDATE worker_slots SET state='ROTATING',updated_at=? WHERE worker_slot_id=?")
            .run(at, verified.binding.workerSlotId)
        }
        const nextClaim = rotateRequired ? null : this.createClaimTx(
          this.verifiedTicket(input.bindingTicket ?? input.ticket), maxItems, leaseSeconds, at)
        const unfinished = this.store.db.prepare("SELECT COUNT(*) AS value FROM stage_runs WHERE workflow_run_id=? AND status!='COMPLETED'")
          .get(verified.binding.workflowRunId) as any
        if (Number(unfinished.value) === 0) {
          this.store.db.prepare("UPDATE workflow_runs SET status='COMPLETED',updated_at=? WHERE workflow_run_id=?")
            .run(at, verified.binding.workflowRunId)
        }
        return {
          committed: true,
          previousClaim: { claimId: claim.claim_id, status: 'COMPLETED' },
          releasedStages: [...new Set(releasedStages)],
          completedWorkItems: [...completedWorkItems],
          rotateRequired,
          next: rotateRequired
            ? { state: 'ROTATE_REQUIRED' }
            : nextClaim
              ? { state: 'CLAIMED', claim: nextClaim }
              : { state: 'NO_WORK_AVAILABLE' },
          counts: this.workflowCounts(verified.binding.workflowRunId)
        }
      }
    ))
  }

  reportBlockedV2(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'report_blocked input')
    const verified = this.verifiedTicket(input.bindingTicket ?? input.ticket)
    const disposition = text(input.disposition, 'disposition', 64)
    if (!['BLOCKED_RETRYABLE', 'WAITING_HUMAN', 'BLOCKED_TERMINAL'].includes(disposition)) throw new Error('blocked disposition is invalid')
    const reason = text(input.reason, 'reason', 4096)
    const key = input.idempotencyKey
    return this.store.transaction(() => this.idempotent(
      `workflow:${verified.binding.workflowRunId}:session:${verified.session.workerSessionId}`,
      key,
      'report_blocked_v2',
      { claimId: input.claimId, disposition, reason },
      () => {
        const claim = this.requireActiveClaim(verified, input.claimId)
        const at = this.now()
        const stages = this.store.db.prepare(`SELECT s.* FROM workflow_claim_units u JOIN stage_runs s ON s.stage_run_id=u.stage_run_id WHERE u.claim_id=?`)
          .all(claim.claim_id) as any[]
        for (const stage of stages) {
          let status = 'BLOCKED'
          if (disposition === 'BLOCKED_RETRYABLE') status = Number(stage.attempts) >= Number(stage.max_attempts) ? 'FAILED' : 'READY'
          if (disposition === 'BLOCKED_TERMINAL') status = 'FAILED'
          this.store.db.prepare('UPDATE stage_runs SET status=?,claim_id=NULL,last_error=?,updated_at=? WHERE stage_run_id=?')
            .run(status, reason, at, stage.stage_run_id)
          this.recalculateWorkItem(verified.binding.workflowRunId, stage.work_item_id, at)
        }
        const claimStatus = disposition === 'BLOCKED_RETRYABLE' ? 'BLOCKED_RETRYABLE' : disposition
        this.store.db.prepare('UPDATE workflow_claims SET status=?,updated_at=?,completed_at=? WHERE claim_id=?')
          .run(claimStatus, at, at, claim.claim_id)
        this.store.db.prepare("UPDATE physical_worker_sessions SET state='WAITING',last_activity_at=? WHERE worker_session_id=?")
          .run(at, verified.session.workerSessionId)
        this.store.db.prepare("UPDATE worker_slots SET state='WAITING',updated_at=? WHERE worker_slot_id=?")
          .run(at, verified.binding.workerSlotId)
        this.event({ workflowRunId: verified.binding.workflowRunId, workerDefinitionId: verified.binding.workerDefinitionId,
          workerSlotId: verified.binding.workerSlotId, workerSessionId: verified.session.workerSessionId,
          claimId: claim.claim_id, type: 'claim.blocked', payload: { disposition, reason }, at })
        return { claimId: claim.claim_id, state: claimStatus, disposition, reason, counts: this.workflowCounts(verified.binding.workflowRunId) }
      }
    ))
  }

  recoverWorker(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'recover_worker input')
    const verified = this.verifiedTicket(input.bindingTicket ?? input.ticket)
    return this.store.transaction(() => {
      const at = this.now()
      this.expireClaimsTx(verified.binding.workflowRunId, at)
      const refreshed = this.verifiedTicket(input.bindingTicket ?? input.ticket)
      const active = this.currentClaims(refreshed.binding.workerSlotId)
        .find(row => row.worker_session_id === refreshed.session.workerSessionId)
      const slotSnapshot = this.workerSlotSnapshot(refreshed.binding.workerSlotId)
      const readyCount = Number((this.store.db.prepare("SELECT COUNT(*) AS value FROM stage_runs WHERE workflow_run_id=? AND worker_definition_id=? AND status='READY'")
        .get(refreshed.binding.workflowRunId, refreshed.binding.workerDefinitionId) as any).value)
      return {
        ...slotSnapshot,
        activeClaim: active ? this.claimView(active.claim_id) : null,
        readyWorkCount: readyCount,
        rotateRequired: String(refreshed.slot.state) === 'ROTATING',
        counts: this.workflowCounts(refreshed.binding.workflowRunId)
      }
    })
  }

  rotatePhysicalSession(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'rotate physical session input')
    const workerSlotId = id(input.workerSlotId, 'workerSlotId')
    const logicalSessionId = text(input.logicalSessionId, 'logicalSessionId', 512)
    const reason = text(input.reason ?? 'session_rotation', 'reason', 1024)
    const conversationId = optionalText(input.conversationId, 'conversationId', 512)
    const conversationUrl = optionalText(input.conversationUrl, 'conversationUrl', 4096)
    return this.store.transaction(() => {
      const { binding } = this.binding(workerSlotId)
      const slot = this.slot(workerSlotId)
      const at = this.now()
      this.expireClaimsTx(binding.workflowRunId, at)
      const activeClaims = this.currentClaims(workerSlotId)
      if (activeClaims.length > 0) {
        this.store.db.prepare("UPDATE worker_slots SET state='ROTATING',updated_at=? WHERE worker_slot_id=?").run(at, workerSlotId)
        if (slot.active_worker_session_id) {
          this.store.db.prepare("UPDATE physical_worker_sessions SET state='ROTATING',last_activity_at=? WHERE worker_session_id=?")
            .run(at, slot.active_worker_session_id)
        }
        return { state: 'ROTATION_PENDING', activeClaimIds: activeClaims.map(row => row.claim_id), generation: Number(slot.generation) }
      }
      if (slot.active_worker_session_id) {
        this.store.db.prepare("UPDATE physical_worker_sessions SET state='CLOSED',closed_at=?,last_activity_at=? WHERE worker_session_id=?")
          .run(at, at, slot.active_worker_session_id)
      }
      const generation = nextWorkerGeneration(Number(slot.generation))
      const workerSessionId = `gptws-${randomUUID()}`
      this.store.db.prepare(`INSERT INTO physical_worker_sessions
        (worker_session_id,worker_slot_id,generation,logical_session_id,conversation_id,conversation_url,state,processed_item_count,started_at,last_activity_at)
        VALUES (?,?,?,?,?,?, 'ACTIVE',0,?,?)`).run(
        workerSessionId, workerSlotId, generation, logicalSessionId, conversationId, conversationUrl, at, at)
      this.store.db.prepare("UPDATE worker_slots SET generation=?,state='ACTIVE',active_worker_session_id=?,updated_at=? WHERE worker_slot_id=?")
        .run(generation, workerSessionId, at, workerSlotId)
      this.store.db.prepare('INSERT INTO worker_binding_generations (worker_slot_id,generation,worker_session_id,reason,at) VALUES (?,?,?,?,?)')
        .run(workerSlotId, generation, workerSessionId, reason, at)
      const session = this.session(workerSessionId)
      const issued = issueWorkerBindingTicket(binding, session, { secret: this.options.ticketSecret, clock: this.clock })
      this.event({ workflowRunId: binding.workflowRunId, workerDefinitionId: binding.workerDefinitionId,
        workerSlotId, workerSessionId, type: 'physical_session.rotated', payload: { generation, reason }, at })
      return { state: 'ROTATED', workerSessionId, generation, ticket: issued.ticket, session }
    })
  }

  expireLeases(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'expire workflow leases input')
    const workflowRunId = id(input.workflowRunId, 'workflowRunId')
    const at = input.at == null ? this.now() : new Date(text(input.at, 'at', 128)).toISOString()
    return this.store.transaction(() => ({ expiredClaimIds: this.expireClaimsTx(workflowRunId, at), counts: this.workflowCounts(workflowRunId) }))
  }
}

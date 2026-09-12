import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'
import { patchOverlaySource } from './overlay-patch.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'worker-runtime', 'v2')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'worker-runtime', 'v2')
const workflowSourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'workflow-runtime')
const workflowTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'workflow-runtime')
const capabilitySourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'capability-runtime')
const capabilityTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'capability-runtime')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function normalizeRelativeTypeScriptSpecifiers(source) {
  return source.replace(/(['"])(\.\.?\/[^'"\r\n]+)\.(?:ts|tsx)\1/gu, '$1$2$1')
}
function patchFile(relativePath, replacements, invariants = []) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  const patched = patchOverlaySource({
    relativePath,
    source: read(file),
    replacements,
    invariants,
    driftPrefix: 'Zero3 Agent Lifecycle overlay'
  })
  write(file, patched)
}

function copySources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    write(path.join(targetDir, entry.name), overlayRuntimeSource(normalizeRelativeTypeScriptSpecifiers(read(path.join(sourceDir, entry.name)))))
  }
  fs.mkdirSync(workflowTargetDir, { recursive: true })
  for (const entry of fs.readdirSync(workflowSourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    write(path.join(workflowTargetDir, entry.name), overlayRuntimeSource(normalizeRelativeTypeScriptSpecifiers(read(path.join(workflowSourceDir, entry.name)))))
  }
  fs.mkdirSync(capabilityTargetDir, { recursive: true })
  for (const entry of fs.readdirSync(capabilitySourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    write(path.join(capabilityTargetDir, entry.name), overlayRuntimeSource(normalizeRelativeTypeScriptSpecifiers(read(path.join(capabilitySourceDir, entry.name)))))
  }
}

const videoBridgeRuntime = String.raw`
const zero3VideoGenerationTaskBridge = new Zero3VideoGenerationTaskBridge({
  execution: {
    getTask: taskId => zero3ExecutionRuntime.getTask(taskId) as any,
    createAssignment: (taskId, stepId, executor, executorId) => zero3ExecutionRuntime.createAssignment(taskId, stepId, executor as any, executorId ?? null) as any,
    bindSession: (assignmentId, input) => zero3ExecutionRuntime.bindSession(assignmentId, input as any),
    recordProgress: (taskId, stepId, progress, activity) => zero3ExecutionRuntime.runtime.recordProgress(taskId, stepId, progress, activity),
    recordArtifact: (taskId, stepId, artifact, identity) => zero3ExecutionRuntime.runtime.recordArtifact(taskId, stepId, artifact, identity),
    requestCompletion: (taskId, stepId) => zero3ExecutionRuntime.runtime.requestCompletion(taskId, stepId),
    gatePassed: (taskId, stepId, evidence) => zero3ExecutionRuntime.runtime.gatePassed(taskId, stepId, evidence),
    gateFailed: (taskId, stepId, reason) => zero3ExecutionRuntime.runtime.gateFailed(taskId, stepId, reason),
    transitionStep: (taskId, stepId, status, reason) => zero3ExecutionRuntime.transitionStep(taskId, stepId, status as any, reason) as any
  },
  worker: zero3WorkflowWorkerRuntime,
  artifactContent: createLocalArtifactContentReader(),
  hostCapability: {
    run: async input => ({
      ok: false as const, externalCapability: true,
      reason: '宿主能力 ' + String(input.capability) + ' 尚未接入：云端 GPU / Remotion 渲染与剪映导出需要 Remote Compute 或本机能力注册后可用。'
    })
  },
  productionProfiles: { get: projectId => zero3ProductionProfileStore.get(projectId) }
})
let zero3VideoBridgeTimer: NodeJS.Timeout | null = null
let zero3VideoBridgeTicking = false
async function zero3ReconcileVideoGenerationTasks() {
  if (zero3VideoBridgeTicking) return
  zero3VideoBridgeTicking = true
  try {
    const tasks = await zero3ExecutionRuntime.listTasks() as any[]
    return await zero3VideoGenerationTaskBridge.reconcileTasks(tasks)
  } finally { zero3VideoBridgeTicking = false }
}
void app.whenReady().then(() => {
  zero3VideoBridgeTimer = setInterval(() => { void zero3ReconcileVideoGenerationTasks().catch(() => undefined) }, 10_000)
  zero3VideoBridgeTimer.unref?.()
})
ipcMain.handle('zero3:video-generation:reconcile', () => zero3ReconcileVideoGenerationTasks())
ipcMain.handle('zero3:video-generation:status', () => zero3VideoGenerationTaskBridge.status())
app.on('before-quit', () => { if (zero3VideoBridgeTimer) clearInterval(zero3VideoBridgeTimer) })
`

const mainRuntime = String.raw`
function zero3WorkerBindingSecret() {
  const file = path.join(app.getPath('userData'), 'zero3', 'worker-binding-secret')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    const existing = fs.readFileSync(file)
    if (existing.byteLength < 32) throw new Error('worker binding secret is too short')
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const created = crypto.randomBytes(48)
  try { fs.writeFileSync(file, created, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return zero3WorkerBindingSecret()
  }
  return created
}
const zero3CapabilityRuntime = createZero3CapabilityRuntime({
  root: path.join(app.getPath('userData'), 'zero3', 'capability-runtime'),
  nodeId: process.env.ZERO3_WORKER_TUNNEL_NODE_ID?.trim() || 'zero3-desktop'
})
const zero3WorkflowWorkerStore = new Zero3WorkflowWorkerStore(path.join(app.getPath('userData'), 'zero3', 'workflow-worker.sqlite3'))
const zero3ProductionProfileStore = new ProjectProductionProfileStore(path.join(app.getPath('userData'), 'zero3', 'production-profiles.json'))
const zero3WorkflowWorkerRuntime = new Zero3WorkflowWorkerRuntime(zero3WorkflowWorkerStore, { ticketSecret: zero3WorkerBindingSecret() })
const zero3WorkerStationManager = new Zero3WorkerStationManager(zero3WorkflowWorkerRuntime, {
  create: projectId => zero3GptWeb.create(projectId),
  executionStatus: entryId => zero3GptWeb.executionStatus(entryId),
  sendWakeup: (entryId, message) => zero3GptWeb.sendWakeup(entryId, message)
})
void app.whenReady().then(() => zero3WorkerStationManager.start())
const zero3WorkerWakeupController = new Zero3WorkerWakeupController(zero3WorkflowWorkerRuntime, {
  executionStatus: entryId => zero3GptWeb.executionStatus(entryId),
  sendWakeup: (entryId, message) => zero3GptWeb.sendWakeup(entryId, message)
})
zero3WorkerWakeupController.start()
const zero3AgentLifecycleStore = new Zero3AgentLifecycleStore(path.join(app.getPath('userData'), 'zero3', 'agent-lifecycle.sqlite3'))
const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(
  zero3AgentLifecycleStore,
  {
    listTasks: async () => await zero3ExecutionRuntime.listTasks() as any[],
    getTask: taskId => zero3ExecutionRuntime.getTask(taskId),
    refreshSkillPreflight: taskId => zero3ExecutionRuntime.refreshSkillPreflight(taskId) as any,
    createTask: input => zero3ExecutionRuntime.createTask(input as any),
    createAssignment: (taskId, stepId, executor, executorId) => zero3ExecutionRuntime.createAssignment(taskId, stepId, executor, executorId),
    bindSession: (assignmentId, input) => zero3ExecutionRuntime.bindSession(assignmentId, input as any),
    recordProgress: (taskId, stepId, progress, activity, identity) => zero3ExecutionRuntime.runtime.recordProgress(taskId, stepId, progress, activity, identity),
    recordArtifact: (taskId, stepId, artifact, identity) => zero3ExecutionRuntime.runtime.recordArtifact(taskId, stepId, artifact, identity),
    requestCompletion: (taskId, stepId, identity) => zero3ExecutionRuntime.runtime.requestCompletion(taskId, stepId, identity),
    updateSessionState: (taskId, bindingId, state) => zero3ExecutionRuntime.updateSessionState(taskId, bindingId, state),
    transitionStep: (taskId, stepId, status, reason) => zero3ExecutionRuntime.transitionStep(taskId, stepId, status as any, reason)
  },
  {
    register: input => zero3ArtifactReferenceStore.register(input as any),
    list: async taskId => {
      const [references, localFiles] = await Promise.all([zero3ArtifactReferenceStore.list(taskId), zero3ArtifactStore.list(taskId)])
      return [
        ...references,
        ...localFiles.map(record => ({
          ...record,
          logicalName: path.basename(record.originalPath),
          storage: { provider: 'LOCAL', path: record.storedPath },
          version: 1,
          status: 'produced'
        }))
      ]
    },
    get: async (taskId, artifactId) => {
      const reference = await zero3ArtifactReferenceStore.get(taskId, artifactId)
      if (reference) return reference
      const record = await zero3ArtifactStore.get(taskId, artifactId)
      return record ? { ...record, logicalName: path.basename(record.originalPath), storage: { provider: 'LOCAL', path: record.storedPath }, version: 1, status: 'produced' } : null
    }
  },
  { memoryForProject: projectId => zero3SharedMemoryForProject(projectId) }
)
function zero3AutonomousTaskFlag(name: string, fallback = false): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return fallback
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return ['1', 'true', 'yes', 'on'].includes(raw)
}
const zero3AutonomousTaskInterval = Number.parseInt(process.env.ZERO3_AUTONOMOUS_TASK_INTERVAL_MS ?? '', 10)

function zero3AutonomousExecutionExecutor(stepExecutor: string, routed: string): string | null {
  if (stepExecutor && stepExecutor !== 'AUTO') return stepExecutor
  if (routed === 'CODEX') return 'CODEX'
  if (routed === 'CLAUDE') return 'CLAUDE'
  if (routed === 'GEMINI') return 'ANTIGRAVITY'
  if (routed === 'ZERO3_API') return 'ZERO3'
  return null
}
async function zero3DispatchAutonomousAgent(input: { task: any; stepId: string; attempt: number }) {
  const taskId = input.task.definition.task.taskId
  const step = input.task.definition.steps.find((item: any) => item.stepId === input.stepId)
  if (!step) return { dispatched: false, reason: 'Autonomous step definition not found.' }
  try {
    const request = buildAutonomousAgentDispatchRequest(input.task, input.stepId, input.attempt, new Date().toISOString())
    const record = await zero3AgentRuntime.dispatchAgentTask(request.taskSpec as any, request.context as any)
    const resolvedTarget = typeof record.resolvedTarget === 'string' ? record.resolvedTarget : ''
    const executor = zero3AutonomousExecutionExecutor(step.executor, resolvedTarget)
    if (!executor) return { dispatched: false, reason: 'Unified Agent Runtime returned no supported executor.' }

    let execution = await zero3ExecutionRuntime.getTask(taskId) as any
    let runtimeStep = execution.runtime.steps.find((item: any) => item.stepId === input.stepId)
    let assignment = runtimeStep?.assignmentId
      ? execution.runtime.assignments.find((item: any) => item.assignmentId === runtimeStep.assignmentId) ?? null
      : null
    if (!assignment) {
      assignment = await zero3ExecutionRuntime.createAssignment(taskId, input.stepId, executor as any, 'agent-runtime:' + String((request.taskSpec as any).taskId))
    }

    const binding = record.binding && typeof record.binding === 'object' ? record.binding as Record<string, unknown> : {}
    const logicalSessionId = typeof binding.targetLogicalSessionId === 'string'
      ? binding.targetLogicalSessionId
      : 'agent-runtime:' + String((request.taskSpec as any).taskId)
    execution = await zero3ExecutionRuntime.getTask(taskId) as any
    const hasBinding = execution.runtime.sessionBindings.some((item: any) => item.assignmentId === assignment.assignmentId && item.state !== 'closed')
    if (!hasBinding) {
      await zero3ExecutionRuntime.bindSession(assignment.assignmentId, {
        logicalSessionId,
        runtimeConversationId: typeof binding.runtimeConversationId === 'string' ? binding.runtimeConversationId : null,
        state: 'active',
        metadata: { autonomous: true, agentTaskId: (request.taskSpec as any).taskId, resolvedTarget }
      })
    }

    const result = record.result && typeof record.result === 'object' ? record.result as Record<string, unknown> : {}
    const resultStatus = typeof result.status === 'string' ? result.status : ''
    const summary = typeof result.summary === 'string' ? result.summary : 'Unified Agent Runtime state: ' + String(record.state)
    execution = await zero3ExecutionRuntime.getTask(taskId) as any
    runtimeStep = execution.runtime.steps.find((item: any) => item.stepId === input.stepId)
    if ((resultStatus === 'COMPLETE' || resultStatus === 'PARTIAL') && record.state === 'COMPLETE') {
      if (runtimeStep && ['dispatching', 'running', 'waiting_report', 'fix_required'].includes(runtimeStep.status)) {
        await zero3ExecutionRuntime.runtime.requestCompletion(taskId, input.stepId)
      }
      execution = await zero3ExecutionRuntime.getTask(taskId) as any
      runtimeStep = execution.runtime.steps.find((item: any) => item.stepId === input.stepId)
      if (runtimeStep?.status === 'verifying') {
        await zero3ExecutionRuntime.runtime.gatePassed(taskId, input.stepId, {
          source: 'zero3_agent_runtime', provider: result.provider ?? resolvedTarget,
          executorId: result.executorId ?? null, summary,
          verificationProfile: record.verificationProfile ?? null
        })
      }
    } else if (runtimeStep && record.state === 'REVIEW_PENDING') {
      if (runtimeStep.status === 'dispatching') {
        await zero3ExecutionRuntime.transitionStep(taskId, input.stepId, 'running', 'Unified Agent Runtime produced a result pending independent review.')
        execution = await zero3ExecutionRuntime.getTask(taskId) as any
        runtimeStep = execution.runtime.steps.find((item: any) => item.stepId === input.stepId)
      }
      if (runtimeStep?.status === 'running') {
        await zero3ExecutionRuntime.transitionStep(taskId, input.stepId, 'waiting_report', 'Unified Agent Runtime is waiting for independent review.')
      }
    } else if (runtimeStep && resultStatus === 'BLOCKED' && runtimeStep.status !== 'blocked') {
      await zero3ExecutionRuntime.transitionStep(taskId, input.stepId, 'blocked', summary)
    } else if (runtimeStep && resultStatus === 'FAILED' && runtimeStep.status !== 'failed') {
      await zero3ExecutionRuntime.transitionStep(taskId, input.stepId, 'failed', summary)
    } else if (runtimeStep && resultStatus === 'OUTCOME_UNKNOWN' && runtimeStep.status !== 'outcome_unknown') {
      await zero3ExecutionRuntime.transitionStep(taskId, input.stepId, 'outcome_unknown', summary)
    }
    return { dispatched: true, resolvedExecutor: executor, state: record.state, sessionId: logicalSessionId }
  } catch (error) {
    return { dispatched: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
async function zero3AutonomousExternalGuards(projectId: string, taskIds: readonly string[]) {
  const events: Array<Record<string, unknown>> = []
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',')
    const workerSql = "SELECT e.*, r.task_id FROM workflow_worker_events e JOIN workflow_runs r ON r.workflow_run_id=e.workflow_run_id WHERE r.task_id IN (" + placeholders + ") AND e.type IN ('claim.blocked','wakeup.rotation_required') ORDER BY e.sequence DESC LIMIT 200"
    const workerRows = zero3WorkflowWorkerStore.db.prepare(workerSql).all(...taskIds) as any[]
    for (const row of workerRows) {
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(String(row.payload_json ?? '{}')) as Record<string, unknown> } catch {}
      const reason = typeof payload.reason === 'string' ? payload.reason : String(row.type)
      const terminal = payload.disposition === 'BLOCKED_TERMINAL'
      events.push({
        source: 'worker', projectId, sourceTaskId: row.task_id,
        eventRef: 'worker:' + String(row.event_id), kind: String(row.type).replaceAll('.', '_'),
        message: reason, blocking: terminal || row.type === 'wakeup.rotation_required',
        affectedResources: [row.worker_slot_id ? 'worker-slot:' + String(row.worker_slot_id) : '', row.worker_session_id ? 'worker-session:' + String(row.worker_session_id) : ''].filter(Boolean),
        metadata: { workflowRunId: row.workflow_run_id, claimId: row.claim_id ?? null, disposition: payload.disposition ?? null }
      })
    }
  }
  for (const operation of zero3CapabilityRuntime.listOperations(projectId)) {
    if (!['BLOCKED', 'FAILED', 'TIMED_OUT'].includes(operation.status)) continue
    events.push({
      source: 'tool_mcp', projectId, sourceTaskId: operation.context?.taskId ?? null,
      eventRef: 'capability:' + operation.operationId, kind: 'capability_' + operation.status.toLowerCase(),
      message: operation.error?.message ?? (operation.capability + ' ' + operation.status),
      blocking: operation.status !== 'BLOCKED' || operation.error?.code === 'POLICY_DENIED',
      affectedResources: ['capability:' + operation.capability, 'node:' + operation.nodeId],
      metadata: { operationId: operation.operationId, capability: operation.capability, errorCode: operation.error?.code ?? null }
    })
  }
  const remoteStatus = zero3RemoteNode.status()
  if (remoteStatus.enabled && !remoteStatus.connected && ((remoteStatus.activeTaskId && taskIds.includes(remoteStatus.activeTaskId)) || remoteStatus.pendingDeliveries > 0)) {
    events.push({
      source: 'compute', projectId, sourceTaskId: remoteStatus.activeTaskId ?? null,
      eventRef: 'compute:' + remoteStatus.nodeId + ':' + String(remoteStatus.lastHeartbeatAt ?? 'offline'),
      kind: 'remote_node_offline', message: remoteStatus.lastError ?? ('Remote node ' + remoteStatus.nodeId + ' is offline'),
      blocking: Boolean(remoteStatus.activeTaskId && taskIds.includes(remoteStatus.activeTaskId)),
      affectedResources: ['node:' + remoteStatus.nodeId],
      metadata: { pendingDeliveries: remoteStatus.pendingDeliveries, lastHeartbeatAt: remoteStatus.lastHeartbeatAt }
    })
  }
  return events
}
const zero3AutonomousTaskLoop = new Zero3AutonomousTaskLoop(
  zero3AgentLifecycleStore,
  {
    projects: { list: () => zero3Projects.list() },
    memoryForProject: projectId => zero3SharedMemoryForProject(projectId),
    execution: {
      listTasks: async () => await zero3ExecutionRuntime.listTasks() as any[],
      getTask: taskId => zero3ExecutionRuntime.getTask(taskId) as any,
      createTask: input => zero3ExecutionRuntime.createTask(input as any) as any,
      refreshSkillPreflight: taskId => zero3ExecutionRuntime.refreshSkillPreflight(taskId),
      reconcileReadiness: taskId => zero3ExecutionRuntime.reconcileReadiness(taskId) as any,
      transitionStep: (taskId, stepId, status, reason) => zero3ExecutionRuntime.transitionStep(taskId, stepId, status as any, reason) as any,
      transitionTask: (taskId, status, reason) => zero3ExecutionRuntime.runtime.transitionTask(taskId, status as any, reason) as any,
      createAssignment: (taskId, stepId, executor, executorId) => zero3ExecutionRuntime.createAssignment(taskId, stepId, executor as any, executorId ?? null),
      bindSession: (assignmentId, input) => zero3ExecutionRuntime.bindSession(assignmentId, input as any),
      recordProgress: (taskId, stepId, progress, activity) => zero3ExecutionRuntime.runtime.recordProgress(taskId, stepId, progress, activity),
      requestCompletion: (taskId, stepId) => zero3ExecutionRuntime.runtime.requestCompletion(taskId, stepId),
      gatePassed: (taskId, stepId, evidence) => zero3ExecutionRuntime.runtime.gatePassed(taskId, stepId, evidence ?? {})
    },
    lifecycle: {
      sessionStart: input => zero3AgentLifecycleRuntime.sessionStart(input) as any,
      taskClaim: input => zero3AgentLifecycleRuntime.taskClaim(input) as any
    },
    gpt: {
      create: projectId => zero3GptWeb.create(projectId),
      sendWakeup: (entryId, message) => zero3GptWeb.sendWakeup(entryId, message),
      executionStatus: entryId => zero3GptWeb.executionStatus(entryId)
    },
    agentDispatch: {
      dispatch: input => zero3DispatchAutonomousAgent(input as any)
    },
    guardSources: {
      list: (projectId, taskIds) => zero3AutonomousExternalGuards(projectId, taskIds) as any
    }
  },
  {
    enabled: zero3AutonomousTaskFlag('ZERO3_AUTONOMOUS_TASK_LOOP_ENABLED', true),
    autoDispatch: zero3AutonomousTaskFlag('ZERO3_AUTONOMOUS_TASK_AUTO_DISPATCH', true),
    advertisedPluginCapabilities: [
      'zero3.full-capability.web-gpt',
      'agent.dispatch.unified',
      'agent.dispatch.codex.full',
      'session.bootstrap.project',
      'memory.shared.lifecycle'
    ],
    ...(Number.isSafeInteger(zero3AutonomousTaskInterval) && zero3AutonomousTaskInterval > 0 ? { intervalMs: zero3AutonomousTaskInterval } : {})
  }
)
void app.whenReady().then(() => zero3AutonomousTaskLoop.start())
ipcMain.handle('zero3:autonomous:status', () => zero3AutonomousTaskLoop.status())
ipcMain.handle('zero3:autonomous:create-goal', (_event, request: unknown) => zero3AutonomousTaskLoop.createGoal(request as any))
ipcMain.handle('zero3:autonomous:dashboard', (_event, projectId: unknown, rootTaskId?: unknown) => zero3AutonomousTaskLoop.dashboard(String(projectId), typeof rootTaskId === 'string' ? rootTaskId : null))
ipcMain.handle('zero3:autonomous:reconcile-project', (_event, projectId: unknown) => zero3AutonomousTaskLoop.reconcileProjectNow(String(projectId)))
ipcMain.handle('zero3:autonomous:ingest-guard', (_event, request: unknown) => zero3AutonomousTaskLoop.ingestGuardEvent(request as any))
${videoBridgeRuntime}
function zero3WorkflowWorkerInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow worker request must be an object')
  return value as Record<string, unknown>
}
ipcMain.handle('zero3:workflow-worker:ensure-run', (_event, request: unknown) => zero3WorkflowWorkerRuntime.ensureWorkflowRun(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:ensure-binding', (_event, request: unknown) => zero3WorkflowWorkerRuntime.ensureWorkerBinding(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:add-items', (_event, request: unknown) => zero3WorkflowWorkerRuntime.addWorkItems(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:get-production-profile', (_event, projectId: unknown) => zero3ProductionProfileStore.get(String(projectId)))
ipcMain.handle('zero3:workflow-worker:upsert-production-profile', (_event, request: unknown) => zero3ProductionProfileStore.upsert(zero3WorkflowWorkerInput(request) as never))
ipcMain.handle('zero3:workflow-worker:install-cognitive-store', async (_event, request: unknown) => {
  const input = zero3WorkflowWorkerInput(request)
  const installed = installCognitiveStoreWorkflow(zero3WorkflowWorkerRuntime, input as never)
  const stations = await zero3WorkerStationManager.reconcileRun(String(input.workflowRunId), String(input.projectId))
  return { ...installed, stations }
})
ipcMain.handle('zero3:workflow-worker:install-video-generation', async (_event, request: unknown) => {
  const input = zero3WorkflowWorkerInput(request)
  const installed = installVideoGenerationWorkflow(zero3WorkflowWorkerRuntime, input as never)
  const stations = await zero3WorkerStationManager.reconcileRun(String(input.workflowRunId), String(input.projectId))
  return { ...installed, stations }
})
ipcMain.handle('zero3:workflow-worker:materialize-video-generation-plan', (_event, request: unknown) =>
  materializeVideoGenerationProductionPlan(zero3WorkflowWorkerRuntime, zero3WorkflowWorkerInput(request) as never))
ipcMain.handle('zero3:workflow-worker:open-session', (_event, request: unknown) => zero3WorkflowWorkerRuntime.openPhysicalSession(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:rotate-session', (_event, request: unknown) => zero3WorkflowWorkerRuntime.rotatePhysicalSession(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:snapshot', (_event, workflowRunId: unknown) => zero3WorkflowWorkerRuntime.workflowSnapshot(workflowRunId))
ipcMain.handle('zero3:workflow-worker:expire-leases', (_event, request: unknown) => zero3WorkflowWorkerRuntime.expireLeases(zero3WorkflowWorkerInput(request)))

async function zero3WorkerRpcRuntime() {
  const v1 = await zero3WorkerAdmin()
  return {
    registerWorker: input => v1.registerWorker(input),
    claimWork: input => ('bindingTicket' in input || 'ticket' in input) ? zero3WorkflowWorkerRuntime.claimWorkV2(input) : v1.claimWork(input),
    reportProgress: input => ('bindingTicket' in input || 'ticket' in input) ? zero3WorkflowWorkerRuntime.reportProgressV2(input) : v1.reportProgress(input),
    completeAndClaimNext: input => v1.completeAndClaimNext(input),
    reportFailure: input => v1.reportFailure(input),
    getTaskContext: input => v1.getTaskContext(input),
    sessionStart: input => zero3AgentLifecycleRuntime.sessionStart(input),
    contextResolve: input => zero3AgentLifecycleRuntime.contextResolve(input),
    taskClaim: input => zero3AgentLifecycleRuntime.taskClaim(input),
    eventRecord: input => zero3AgentLifecycleRuntime.eventRecord(input),
    artifactRegister: input => zero3AgentLifecycleRuntime.artifactRegister(input),
    taskComplete: input => zero3AgentLifecycleRuntime.taskComplete(input),
    memoryCommit: input => zero3AgentLifecycleRuntime.memoryCommit(input),
    handoffCreate: input => zero3AgentLifecycleRuntime.handoffCreate(input),
    bootstrapWorker: input => zero3WorkflowWorkerRuntime.bootstrapWorker(input),
    commitAndClaimNextV2: input => zero3WorkflowWorkerRuntime.commitAndClaimNext(input),
    reportBlockedV2: input => zero3WorkflowWorkerRuntime.reportBlockedV2(input),
    recoverWorker: input => zero3WorkflowWorkerRuntime.recoverWorker(input),
    taskBootstrap: input => zero3AgentLifecycleRuntime.taskBootstrap(input),
    dispatchCodexTask: async input => {
      const context = await zero3AgentLifecycleRuntime.contextResolve({ sessionId: input.sessionId }) as any
      const task = context.task?.definition?.task ?? {}
      return dispatchZero3CodexTask(zero3Control, input, {
        projectContext: {
          project_id: task.projectId,
          context_version: context.contextVersion,
          source_entry_id: input.sessionId,
          source_kind: 'gpt_web'
        }
      })
    },
    verifyCommit: async input => {
      const context = await zero3AgentLifecycleRuntime.contextResolve({ sessionId: input.sessionId }) as any
      const result = await verifyZero3Commit(input)
      return { ...result, taskId: context.task?.definition?.task?.taskId ?? null, contextVersion: context.contextVersion }
    },
    listCapabilities: input => zero3CapabilityRuntime.listCapabilities(input),
    describeCapability: input => zero3CapabilityRuntime.describeCapability(input),
    invokeCapability: input => zero3CapabilityRuntime.invokeCapability(input as any),
    getOperation: input => zero3CapabilityRuntime.getOperation(input),
    cancelOperation: input => zero3CapabilityRuntime.cancelOperation(input),
    claimWorkV2: input => zero3WorkflowWorkerRuntime.claimWorkV2(input),
    reportProgressV2: input => zero3WorkflowWorkerRuntime.reportProgressV2(input)
  }
}
app.on('before-quit', () => { zero3AutonomousTaskLoop.stop(); zero3WorkerStationManager.stop(); zero3WorkerWakeupController.stop(); zero3AgentLifecycleStore.close(); zero3WorkflowWorkerStore.close(); zero3CapabilityRuntime.close() })
`

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3Autonomous', {
  status: () => ipcRenderer.invoke('zero3:autonomous:status'),
  createGoal: input => ipcRenderer.invoke('zero3:autonomous:create-goal', input),
  dashboard: (projectId, rootTaskId) => ipcRenderer.invoke('zero3:autonomous:dashboard', projectId, rootTaskId),
  reconcileProject: projectId => ipcRenderer.invoke('zero3:autonomous:reconcile-project', projectId),
  ingestGuard: input => ipcRenderer.invoke('zero3:autonomous:ingest-guard', input)
})

contextBridge.exposeInMainWorld('zero3WorkflowWorkers', {
  ensureRun: input => ipcRenderer.invoke('zero3:workflow-worker:ensure-run', input),
  ensureBinding: input => ipcRenderer.invoke('zero3:workflow-worker:ensure-binding', input),
  addItems: input => ipcRenderer.invoke('zero3:workflow-worker:add-items', input),
  getProductionProfile: projectId => ipcRenderer.invoke('zero3:workflow-worker:get-production-profile', projectId),
  upsertProductionProfile: input => ipcRenderer.invoke('zero3:workflow-worker:upsert-production-profile', input),
  installCognitiveStore: input => ipcRenderer.invoke('zero3:workflow-worker:install-cognitive-store', input),
  installVideoGeneration: input => ipcRenderer.invoke('zero3:workflow-worker:install-video-generation', input),
  materializeVideoGenerationPlan: input => ipcRenderer.invoke('zero3:workflow-worker:materialize-video-generation-plan', input),
  openSession: input => ipcRenderer.invoke('zero3:workflow-worker:open-session', input),
  rotateSession: input => ipcRenderer.invoke('zero3:workflow-worker:rotate-session', input),
  snapshot: workflowRunId => ipcRenderer.invoke('zero3:workflow-worker:snapshot', workflowRunId),
  expireLeases: input => ipcRenderer.invoke('zero3:workflow-worker:expire-leases', input),
  videoBridgeStatus: () => ipcRenderer.invoke('zero3:video-generation:status'),
  reconcileVideoGeneration: () => ipcRenderer.invoke('zero3:video-generation:reconcile')
})

contextBridge.exposeInMainWorld('hermesDesktop', {`

const globalBridge = String.raw`    zero3Autonomous: {
      status: () => Promise<unknown>
      createGoal: (input: { title: string; goal: string; projectId: string; workspace?: string | null; requiredSkills?: string[]; optionalSkills?: string[]; requiredCapabilities?: string[]; importance?: 'low' | 'normal' | 'high' | 'critical' }) => Promise<unknown>
      dashboard: (projectId: string, rootTaskId?: string | null) => Promise<unknown>
      reconcileProject: (projectId: string) => Promise<unknown>
      ingestGuard: (input: Record<string, unknown>) => Promise<unknown>
    }
    zero3WorkflowWorkers: {
      ensureRun: (input: Record<string, unknown>) => Promise<unknown>
      ensureBinding: (input: Record<string, unknown>) => Promise<unknown>
      addItems: (input: Record<string, unknown>) => Promise<unknown>
      getProductionProfile: (projectId: string) => Promise<unknown>
      upsertProductionProfile: (input: Record<string, unknown>) => Promise<unknown>
      installCognitiveStore: (input: Record<string, unknown>) => Promise<unknown>
      installVideoGeneration: (input: Record<string, unknown>) => Promise<unknown>
      materializeVideoGenerationPlan: (input: Record<string, unknown>) => Promise<unknown>
      openSession: (input: Record<string, unknown>) => Promise<unknown>
      rotateSession: (input: Record<string, unknown>) => Promise<unknown>
      snapshot: (workflowRunId: string) => Promise<unknown>
      expireLeases: (input: Record<string, unknown>) => Promise<unknown>
      videoBridgeStatus: () => Promise<unknown>
      reconcileVideoGeneration: () => Promise<unknown>
    }
    hermesDesktop: {`

// The Execution Runtime composition point is one statement, but the dispose
// binding that holds it has been renamed more than once and the statement that
// follows it keeps moving, so match the statement itself and insert after
// whatever spelling the generated tree currently uses. Exactly one match is
// required: no match means the Execution Runtime overlay never ran, and more
// than one means a previous replay duplicated the composition point.
const EXECUTION_RUNTIME_COMPOSITION = /const [A-Za-z0-9_$]+ = registerExecutionDesktopIpc\(zero3ExecutionRuntime[^\n]*\)\n/
// The Remote Host overlay owns the constructor and this overlay upgrades its
// runtime provider from the legacy admin port to the Worker RPC composite.
const WORKER_RUNTIME_PROVIDER = /}, \(\) => zero3Worker[A-Za-z0-9_$]*\(\)\)/

export function applyZero3AgentLifecycleRuntime() {
  copySources()
  patchFile(
    'electron/main.ts',
    [
      {
        // The workflow-runtime import line is upgraded in place when an older overlay
        // run already inserted it; a fresh tree falls through to the anchor candidate.
        label: 'Agent Lifecycle runtime import',
        appliedMarker: 'Zero3VideoGenerationTaskBridge',
        from: {
          from: "import { ProjectProductionProfileStore, Zero3WorkerStationManager, Zero3WorkerWakeupController, installCognitiveStoreWorkflow, installVideoGenerationWorkflow, materializeVideoGenerationProductionPlan } from './zero3/workflow-runtime/index'",
          to: "import { ProjectProductionProfileStore, Zero3VideoGenerationTaskBridge, Zero3WorkerStationManager, Zero3WorkerWakeupController, createLocalArtifactContentReader, installCognitiveStoreWorkflow, installVideoGenerationWorkflow, materializeVideoGenerationProductionPlan } from './zero3/workflow-runtime/index'"
        },
        fromAny: ['const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR'],
        to: "import { Zero3AgentLifecycleRuntime, Zero3AgentLifecycleStore, Zero3WorkflowWorkerRuntime, Zero3WorkflowWorkerStore } from './zero3/worker-runtime/v2/index'\nimport { ProjectProductionProfileStore, Zero3VideoGenerationTaskBridge, Zero3WorkerStationManager, Zero3WorkerWakeupController, createLocalArtifactContentReader, installCognitiveStoreWorkflow, installVideoGenerationWorkflow, materializeVideoGenerationProductionPlan } from './zero3/workflow-runtime/index'\nimport { dispatchZero3CodexTask, loadZero3RemoteHostConfig, resolveZero3AgentWorkspace, summarizeZero3AgentFastPathTelemetry, verifyZero3Commit } from './zero3/remote-host/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
      },
      {
        label: 'Capability Runtime import',
        appliedMarker: "from './zero3/capability-runtime/index'",
        from: 'const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR',
        to: "import { createZero3CapabilityRuntime } from './zero3/capability-runtime/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
      },
      {
        // Runs after the Agent Lifecycle import replacement, which re-emits the
        // same anchor, so the loop import is added without disturbing it.
        label: 'Autonomous Task Loop runtime import',
        appliedMarker: 'buildAutonomousAgentDispatchRequest',
        from: 'const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR',
        to: "import { Zero3AutonomousTaskLoop, buildAutonomousAgentDispatchRequest } from './zero3/worker-runtime/v2/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
      },
      {
        label: 'Agent Lifecycle composition after Execution Runtime',
        appliedMarker: 'const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(',
        fromAny: [EXECUTION_RUNTIME_COMPOSITION],
        to: match => match + mainRuntime,
        hint:
          'The Execution Runtime bridge overlay (apply-execution-runtime-bridge.mjs) composes it and must run first; use prepare-codex-upstream.mjs instead of applying overlays by hand.'
      },
      {
        // Upgrades a tree that already carries the older mainRuntime block: the bridge
        // composition is appended after the autonomous ingest-guard handler it sits
        // behind. A freshly patched tree already contains the marker and skips.
        label: 'Video generation task bridge composition',
        appliedMarker: 'const zero3VideoGenerationTaskBridge = new Zero3VideoGenerationTaskBridge(',
        from: "ipcMain.handle('zero3:autonomous:ingest-guard', (_event, request: unknown) => zero3AutonomousTaskLoop.ingestGuardEvent(request as any))",
        to: match => `${match}\n${videoBridgeRuntime}`
      },
      {
        label: 'Capability Runtime composition',
        appliedMarker: 'const zero3CapabilityRuntime = createZero3CapabilityRuntime(',
        from: "const zero3WorkflowWorkerStore = new Zero3WorkflowWorkerStore(path.join(app.getPath('userData'), 'zero3', 'workflow-worker.sqlite3'))",
        to: "const zero3CapabilityRuntime = createZero3CapabilityRuntime({\n  root: path.join(app.getPath('userData'), 'zero3', 'capability-runtime'),\n  nodeId: process.env.ZERO3_WORKER_TUNNEL_NODE_ID?.trim() || 'zero3-desktop'\n})\nconst zero3WorkflowWorkerStore = new Zero3WorkflowWorkerStore(path.join(app.getPath('userData'), 'zero3', 'workflow-worker.sqlite3'))"
      },
      {
        label: 'Capability RPC methods',
        appliedMarker: 'listCapabilities: input => zero3CapabilityRuntime.listCapabilities(input)',
        from: '    claimWorkV2: input => zero3WorkflowWorkerRuntime.claimWorkV2(input),',
        to: "    listCapabilities: input => zero3CapabilityRuntime.listCapabilities(input),\n    describeCapability: input => zero3CapabilityRuntime.describeCapability(input),\n    invokeCapability: input => zero3CapabilityRuntime.invokeCapability(input as any),\n    getOperation: input => zero3CapabilityRuntime.getOperation(input),\n    cancelOperation: input => zero3CapabilityRuntime.cancelOperation(input),\n    claimWorkV2: input => zero3WorkflowWorkerRuntime.claimWorkV2(input),"
      },
      {
        label: 'Capability Runtime teardown',
        appliedMarker: 'zero3CapabilityRuntime.close()',
        fromAny: [/zero3WorkflowWorkerStore\.close\(\)(?= \}\))/],
        to: match => `${match}; zero3CapabilityRuntime.close()`
      },
      {
        label: 'Remote Worker RPC composite runtime provider',
        appliedMarker: '}, () => zero3WorkerRpcRuntime())',
        fromAny: ['}, () => zero3WorkerAdmin())', WORKER_RUNTIME_PROVIDER],
        to: '}, () => zero3WorkerRpcRuntime())',
        hint: 'The Remote Host overlay (apply-remote-host-runtime.mjs) composes the Zero3RemoteNode constructor and must run first.'
      }
    ],
    [
      { label: 'Agent Lifecycle composition point', text: 'const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(', count: 1 },
      { label: 'Workflow Worker store composition point', text: 'const zero3WorkflowWorkerStore = new Zero3WorkflowWorkerStore(', count: 1 },
      { label: 'Capability Runtime composition point', text: 'const zero3CapabilityRuntime = createZero3CapabilityRuntime(', count: 1 },
      { label: 'Worker RPC composite runtime definition', text: 'async function zero3WorkerRpcRuntime(', count: 1 },
      { label: 'Worker RPC composite runtime provider', text: '() => zero3WorkerRpcRuntime()', count: 1 },
      { label: 'Agent Lifecycle teardown', text: 'zero3AgentLifecycleStore.close()', count: 1 },
      { label: 'Autonomous Task Loop composition point', text: 'const zero3AutonomousTaskLoop = new Zero3AutonomousTaskLoop(', count: 1 },
      { label: 'Autonomous Task Loop teardown', text: 'zero3AutonomousTaskLoop.stop()', count: 1 },
      { label: 'Unified Autonomous Agent dispatch', text: 'async function zero3DispatchAutonomousAgent(', count: 1 },
      { label: 'Autonomous goal IPC', text: "zero3:autonomous:create-goal", count: 1 },
      { label: 'Autonomous dashboard IPC', text: "zero3:autonomous:dashboard", count: 1 },
      { label: 'Video generation install IPC', text: "zero3:workflow-worker:install-video-generation", count: 1 },
      { label: 'Video generation plan IPC', text: "zero3:workflow-worker:materialize-video-generation-plan", count: 1 },
      { label: 'Production profile IPC', text: "zero3:workflow-worker:upsert-production-profile", count: 1 },
      { label: 'Video generation task bridge composition', text: 'const zero3VideoGenerationTaskBridge = new Zero3VideoGenerationTaskBridge(', count: 1 },
      { label: 'Video generation task bridge reconcile IPC', text: 'zero3:video-generation:reconcile', count: 1 }
    ]
  )
  patchFile('electron/preload.ts', [
    { label: 'Autonomous + Workflow Worker preload', appliedMarker: "exposeInMainWorld('zero3Autonomous'", from: "contextBridge.exposeInMainWorld('hermesDesktop', {", to: preloadBridge }
  ])
  patchFile('src/global.d.ts', [
    { label: 'Autonomous + Workflow Worker renderer types', appliedMarker: '    zero3Autonomous: {', from: '    hermesDesktop: {', to: globalBridge }
  ])
}

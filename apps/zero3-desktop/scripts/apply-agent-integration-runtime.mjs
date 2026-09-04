import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const routingSourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'agent-routing-runtime')
const routingTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'agent-routing')
const bridgeSourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'agent-desktop-bridge')
const bridgeTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'agent-desktop-bridge')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Zero3 integrated agent overlay drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function stageSources() {
  fs.mkdirSync(routingTargetDir, { recursive: true })
  const routingFiles = [
    'agent-contracts.ts',
    'agent-router.ts',
    'agent-task-store.ts',
    'git-authority.ts',
    'review-loop-store.ts',
    'agent-runtime-orchestrator.ts',
    'agent-recovery-controller.ts',
    'codex-task-adapter.ts',
    'authoritative-result-finalizer.ts',
    'verification-collector.ts',
    'index.ts'
  ]
  for (const file of routingFiles) {
    const source = path.join(routingSourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 integrated routing source missing: ${source}`)
    write(path.join(routingTargetDir, file), read(source))
  }

  fs.mkdirSync(bridgeTargetDir, { recursive: true })
  for (const file of ['bridge.ts', 'index.ts']) {
    const source = path.join(bridgeSourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 integrated bridge source missing: ${source}`)
    let content = read(source)
    if (file === 'bridge.ts') {
      content = content.replace("../agent-routing-runtime/agent-contracts", "../agent-routing/agent-contracts")
    }
    write(path.join(bridgeTargetDir, file), content)
  }
}

const integratedMain = String.raw`
const zero3AgentTaskStore = new Zero3AgentTaskStore(zero3AgentTaskStateRoot)
const zero3AgentRouter = new Zero3AgentRouter()
const zero3CodexRuntime = {
  startThread: (params: unknown) => zero3CodexAppServer.request('thread/start', params),
  startTurn: (params: unknown, timeoutMs?: number) => zero3CodexAppServer.request('turn/start', params, timeoutMs),
  readThread: (params: unknown) => zero3CodexAppServer.request('thread/read', params),
  execCommand: (params: unknown, timeoutMs?: number) => zero3CodexAppServer.request('command/exec', params, timeoutMs)
}
const zero3VerificationCollector = new Zero3VerificationCollector(zero3CodexRuntime)
const zero3AuthoritativeResultFinalizer = new Zero3AuthoritativeResultFinalizer({
  collectGitEvidence: (workspace, requestedBaseSha) => zero3GitEvidence(zero3CodexRuntime, workspace, requestedBaseSha),
  verifyArtifact: async (task, artifact) => {
    const stored = await zero3ArtifactStore.get(task.taskId, artifact.artifactId)
    if (!stored || stored.sha256 !== artifact.hash) return false
    return zero3ArtifactStore.verify(stored)
  },
  collectVerification: (task, candidate) => zero3VerificationCollector.collect(task, candidate)
})
const zero3LocalCodexRunner = {
  run: async (lease: { lease_id: string; fencing_token: number; task: Record<string, unknown> }) => {
    const rawTask: Record<string, unknown> = lease.task && typeof lease.task === 'object' && !Array.isArray(lease.task) ? lease.task : {}
    const target = rawTask.target && typeof rawTask.target === 'object' && !Array.isArray(rawTask.target)
      ? rawTask.target as Record<string, unknown>
      : {}
    const workspace = typeof target.workspace === 'string' ? target.workspace.trim() : ''
    const taskId = typeof rawTask.task_id === 'string' ? rawTask.task_id.trim() : ''
    if (!workspace || !taskId) throw new Error('local Codex TaskSpec adapter requires task_id and workspace')
    const encodedTaskId = Buffer.from(taskId, 'utf8').toString('hex')
    const stateRoot = path.join(app.getPath('userData'), 'zero3', 'agent-task-state', 'codex')
    const runner = new Zero3RemoteTaskRunner({
      enabled: false,
      baseUrl: null,
      tokenFile: null,
      nodeId: 'zero3-local-agent',
      allowedWorkspaces: [path.resolve(workspace)],
      developmentAllowHttp: false,
      mappingStateFile: path.join(stateRoot, 'mappings', encodedTaskId + '.json'),
      outboxDir: path.join(stateRoot, 'outbox', encodedTaskId)
    }, zero3CodexRuntime)
    return runner.run(lease as never)
  }
}
const zero3CodexTaskAdapter = new Zero3CodexTaskAdapter(zero3LocalCodexRunner)

async function zero3ProviderAvailability() {
  let codexAvailable = false
  try {
    await zero3CodexAppServer.ensureStarted()
    codexAvailable = true
  } catch {}

  const geminiStatus = zero3Antigravity.status()
  let geminiAuthenticated: boolean | null = null
  let sawKnownUnauthenticated = false
  for (const logicalSessionId of geminiStatus.activeSessions) {
    try {
      const binding = await zero3Antigravity.binding(logicalSessionId)
      if (binding?.authState === 'AUTHENTICATED') {
        geminiAuthenticated = true
        break
      }
      if (binding?.authState === 'AUTH_REQUIRED' || binding?.authState === 'AUTH_EXPIRED') {
        sawKnownUnauthenticated = true
      }
    } catch {}
  }
  if (geminiAuthenticated !== true && sawKnownUnauthenticated) geminiAuthenticated = false

  return {
    codex: { available: codexAvailable, authenticated: codexAvailable ? true : false },
    gemini: { available: geminiStatus.available, authenticated: geminiAuthenticated }
  }
}

const zero3AgentRuntime = new Zero3AgentRuntimeOrchestrator({
  router: zero3AgentRouter,
  taskStore: zero3AgentTaskStore,
  reviewStore: zero3ReviewStore,
  antigravity: zero3Antigravity,
  codex: zero3CodexTaskAdapter,
  availability: zero3ProviderAvailability,
  finalizeResult: (task, candidate) => zero3AuthoritativeResultFinalizer.finalize(task, candidate)
})
const zero3AgentRecovery = new Zero3AgentRecoveryController({
  taskStore: zero3AgentTaskStore,
  antigravity: zero3Antigravity,
  collectGitEvidence: (workspace, requestedBaseSha) => zero3GitEvidence(zero3CodexRuntime, workspace, requestedBaseSha),
  artifactsPresent: taskId => zero3ArtifactStore.list(taskId).then(records => records.length > 0),
  reconcileOutcome: reconcileOutcomeUnknown
})
const zero3AgentDesktopHandlers = createZero3AgentDesktopHandlers({
  task: taskId => zero3AgentRuntime.task(taskId),
  dispatch: (task, context) => zero3AgentRuntime.dispatch(task, context),
  submitReviewDecision: (taskId, decision, contextVersion) => zero3AgentRuntime.submitReviewDecision(taskId, decision, contextVersion),
  recoveryInspect: taskId => zero3AgentRecovery.inspect(taskId),
  recoveryResolve: (taskId, resolution, rationale) => zero3AgentRecovery.applyResolution(taskId, resolution, rationale)
})
ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.taskGet, (_event, request: unknown) => zero3AgentDesktopHandlers.taskGet(request))
ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.dispatch, (_event, request: unknown) => zero3AgentDesktopHandlers.dispatch(request))
ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.reviewDecision, (_event, request: unknown) => zero3AgentDesktopHandlers.reviewDecision(request))
ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.recoveryInspect, (_event, request: unknown) => zero3AgentDesktopHandlers.recoveryInspect(request))
ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.recoveryResolve, (_event, request: unknown) => zero3AgentDesktopHandlers.recoveryResolve(request))

function zero3AgentCompatRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function zero3AgentCompatText(value: unknown, label: string, max = 256): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(label + ' is invalid')
  return text
}
ipcMain.handle('zero3:agent-tasks:dispatch', async (_event, request: unknown) => {
  const input = zero3AgentCompatRecord(request)
  const taskSpec = zero3AgentCompatRecord(input.taskSpec)
  const originEntryId = zero3AgentCompatText(input.originEntryId, 'originEntryId')
  const createdBySessionId = zero3AgentCompatText(taskSpec.createdBySessionId, 'taskSpec.createdBySessionId')
  if (createdBySessionId !== originEntryId) throw new Error('TaskSpec origin entry mismatch')
  const target = zero3AgentCompatText(taskSpec.target, 'taskSpec.target', 16)
  if (target !== 'CODEX' && target !== 'GEMINI') throw new Error('GPT Web compatibility handoff requires an explicit CODEX or GEMINI target')
  const projectId = zero3AgentCompatText(taskSpec.projectId, 'taskSpec.projectId')
  const taskId = zero3AgentCompatText(taskSpec.taskId, 'taskSpec.taskId', 128)
  const executionId = zero3AgentCompatText(taskSpec.executionId, 'taskSpec.executionId', 128)

  let webEntry: Awaited<ReturnType<typeof zero3GeminiWeb.create>> | null = null
  const targetLogicalSessionId = target === 'GEMINI'
    ? (webEntry = await zero3GeminiWeb.create(projectId)).logicalSessionId
    : 'codex-task:' + taskId + ':' + executionId
  const taskRecord = await zero3AgentDesktopHandlers.dispatch({
    task: taskSpec,
    context: { targetLogicalSessionId, reviewSessionId: originEntryId }
  })
  const record = zero3AgentCompatRecord(taskRecord)
  const binding = zero3AgentCompatRecord(record.binding)
  return {
    taskId,
    executionId,
    target: record.resolvedTarget === 'GEMINI' ? 'GEMINI' : 'CODEX',
    logicalSessionId: typeof binding.targetLogicalSessionId === 'string' ? binding.targetLogicalSessionId : targetLogicalSessionId,
    webEntryId: webEntry?.id ?? null
  }
})

// Preserve the P04/P06 renderer surface while routing decisions through the
// authoritative task store so ReviewDecision and task state cannot diverge.
ipcMain.removeHandler('zero3:review:decision')
ipcMain.handle('zero3:review:decision', (_event, request: unknown) => zero3AgentDesktopHandlers.reviewDecision(request))
`

const preloadSurface = String.raw`contextBridge.exposeInMainWorld('zero3AgentTask', {
  get: request => ipcRenderer.invoke('zero3:agent-task:get', request),
  dispatch: request => ipcRenderer.invoke('zero3:agent-task:dispatch', request),
  reviewDecision: request => ipcRenderer.invoke('zero3:agent-task:review-decision', request),
  recoveryInspect: request => ipcRenderer.invoke('zero3:agent-task:recovery-inspect', request),
  recoveryResolve: request => ipcRenderer.invoke('zero3:agent-task:recovery-resolve', request)
})

contextBridge.exposeInMainWorld('zero3AgentTasks', {
  dispatch: request => ipcRenderer.invoke('zero3:agent-tasks:dispatch', request)
})

contextBridge.exposeInMainWorld('zero3Artifacts', {`

const globalTypes = String.raw`
type Zero3AgentTaskTarget = 'CODEX' | 'GEMINI' | 'AUTO'
type Zero3AgentTaskType = 'DESIGN' | 'IMPLEMENT' | 'VERIFY' | 'FIX' | 'REVIEW' | 'INTEGRATE' | 'RESEARCH'
type Zero3AgentRecoveryResolution = 'KEEP_UNKNOWN' | 'ACCEPT_PARTIAL' | 'MARK_FAILED'
type Zero3AgentTaskSpecV2 = {
  protocol: 'zero3.pilot.task-spec.v2'
  taskId: string
  executionId: string
  projectId: string
  target: Zero3AgentTaskTarget
  type: Zero3AgentTaskType
  title: string
  goal: string
  contextVersion: number
  repo?: string | null
  baseSha?: string | null
  branch?: string | null
  worktreePath?: string | null
  requirements: string[]
  constraints: string[]
  requiredContracts: string[]
  inputArtifacts: Array<Record<string, unknown>>
  expectedOutputs: Array<Record<string, unknown>>
  verification: Array<Record<string, unknown>>
  completionGate: string[]
  reviewPolicy: { required: boolean; reviewer: 'GPT_WEB' | 'HUMAN' | 'CODEX'; maxCycles?: number | null }
  createdBySessionId: string
  createdAt: string
}
`

const globalSurface = String.raw`    zero3AgentTask: {
      get: (request: { taskId: string }) => Promise<unknown>
      dispatch: (request: { task: Zero3AgentTaskSpecV2; context: { targetLogicalSessionId: string; reviewSessionId?: string | null; runtimeConversationId?: string | null } }) => Promise<unknown>
      reviewDecision: (request: { taskId: string; contextVersion: number; decision: Zero3ReviewDecisionInput }) => Promise<unknown>
      recoveryInspect: (request: { taskId: string }) => Promise<unknown>
      recoveryResolve: (request: { taskId: string; resolution: Zero3AgentRecoveryResolution; rationale: string }) => Promise<unknown>
    }
    zero3AgentTasks: {
      dispatch: (request: { taskSpec: Zero3AgentTaskSpecV2; originEntryId: string }) => Promise<{ taskId: string; executionId: string; target: 'CODEX' | 'GEMINI'; logicalSessionId?: string | null; webEntryId?: string | null }>
    }
    zero3Artifacts: {`

export function applyZero3AgentIntegrationRuntime() {
  stageSources()
  patchFile('electron/main.ts', [
    {
      label: 'integrated agent-routing import',
      from: "import { Zero3ReviewLoopStore } from './zero3/agent-routing/index'",
      to:
        "import { Zero3ReviewLoopStore, Zero3AgentRouter, Zero3AgentTaskStore, Zero3AgentRuntimeOrchestrator, Zero3AgentRecoveryController, Zero3CodexTaskAdapter, Zero3AuthoritativeResultFinalizer, Zero3VerificationCollector, zero3GitEvidence } from './zero3/agent-routing/index'\n" +
        "import { createZero3AgentDesktopHandlers, ZERO3_AGENT_DESKTOP_CHANNELS } from './zero3/agent-desktop-bridge/index'"
    },
    {
      label: 'existing remote-host import',
      from: "import { Zero3RemoteNode } from './zero3/remote-host/index'",
      to: "import { Zero3RemoteNode, Zero3RemoteTaskRunner } from './zero3/remote-host/index'"
    },
    {
      label: 'artifact verification reconciliation import',
      from: "import { Zero3ArtifactStore, Zero3AntigravityMcpLease } from './zero3/artifacts/index'",
      to: "import { Zero3ArtifactStore, Zero3AntigravityMcpLease, reconcileOutcomeUnknown } from './zero3/artifacts/index'"
    },
    {
      label: 'Codex singleton composition boundary',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()',
      to: 'const zero3CodexAppServer = createZero3CodexAppServer()\n' + integratedMain
    }
  ])
  patchFile('electron/preload.ts', [
    { label: 'integrated task preload surface', from: "contextBridge.exposeInMainWorld('zero3Artifacts', {", to: preloadSurface }
  ])
  patchFile('src/global.d.ts', [
    { label: 'integrated task renderer types', from: 'type Zero3ReviewDecisionInput = {', to: globalTypes + '\ntype Zero3ReviewDecisionInput = {' },
    { label: 'integrated task renderer surface', from: '    zero3Artifacts: {', to: globalSurface }
  ])
}

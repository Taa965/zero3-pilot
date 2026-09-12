import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'agent-routing-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'agent-routing')
const stagedFiles = ['zero3-api-task-adapter.ts', 'zero3-api-availability.ts', 'zero3-executor-failure.ts']

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Zero3 Zero3-API executor overlay drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function stageSources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of stagedFiles) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 Zero3 API executor source missing: ${source}`)
    write(path.join(targetDir, file), overlayRuntimeSource(read(source)))
  }
}

const CLAUDE_ADAPTER_BLOCK = `const zero3ClaudeTaskAdapter = new Zero3ClaudeTaskAdapter({
  serverPath: path.join(app.getAppPath(), 'electron', 'zero3', 'mcp', 'project-context-server.mjs'),
  stateDir: path.join(app.getPath('userData'), 'zero3', 'project-context')
})`

// The production Zero3 API executor. It reuses the session-provider bridge the
// chat surface already owns (profile -> model provider -> Codex Agent Kernel
// thread) instead of introducing a second model API runtime, and it is pinned to
// a read-only sandbox so the advertised capability profile stays truthful.
const zero3ApiExecutorBlock = `
const ZERO3_API_TASK_PROFILE_ID = process.env.ZERO3_API_TASK_PROFILE_ID?.trim() || null
const ZERO3_API_TASK_HEALTH_TTL_MS = 15 * 60_000
const ZERO3_API_TASK_TURN_DEADLINE_MS = 9 * 60_000

// Public profile facts only: the capability probe never sees, stores or logs an
// API key. hasApiKey is a boolean derived from the encrypted keystore entry.
async function zero3Zero3ApiTaskProfiles() {
  const state = await zero3ApiProfileRead()
  return Object.values(state.profiles).map(profile => ({
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    model: profile.model,
    baseUrl: profile.baseUrl,
    hasApiKey: Boolean(profile.encryptedApiKey)
  }))
}

async function zero3Zero3ApiTaskUsage(profileId) {
  const reading = await zero3ReadProviderUsage({ provider: 'zero3', profileId, force: false })
  const windows = [reading.fiveHour?.remainingPercent, reading.weekly?.remainingPercent]
    .filter(value => typeof value === 'number')
  const balances = Array.isArray(reading.balances) ? reading.balances : []
  const remainingPercent = windows.length
    ? Math.min(...windows)
    : balances.length
      ? (balances.some(balance => typeof balance.amount === 'number' && balance.amount > 0) ? null : 0)
      : null
  return {
    status: (reading.status === 'ready' ? 'ready' : reading.status === 'unsupported' ? 'unsupported' : 'unavailable') as 'ready' | 'unsupported' | 'unavailable',
    remainingPercent,
    detail: typeof reading.detail === 'string' ? reading.detail : null
  }
}

// One real Zero3 API turn: the profile's model answers through the pinned Codex
// Agent Kernel with the bound project workspace, in a read-only sandbox.
async function zero3Zero3ApiTaskTurn(request) {
  const state = await zero3ApiProfileRead()
  const profile = state.profiles[request.profileId]
  if (!profile) throw new Error('Zero3 API Profile 不存在')
  const apiKey = await zero3DecryptApiKey(profile.encryptedApiKey)
  const bridge = await zero3ApiAgentBridge.register(profile, apiKey)
  const runtimeOverrides = {
    model: profile.model,
    modelProvider: bridge.providerId,
    cwd: request.cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: zero3ApiAgentConfig(bridge.providerId, bridge.baseUrl),
    developerInstructions: 'You are a Zero3 Pilot task executor. The workspace is read-only for this turn: inspect it with read-only tools, never mutate the computer, the repository or any remote system. If the task requires a write, a commit, a build or any other mutation, report status BLOCKED and name the executor that is required instead. Never claim verification you did not run; Zero3 re-derives Git, artifact and verification facts independently.'
  }
  const started = await zero3CodexAppServer.request('thread/start', {
    ...runtimeOverrides,
    zero3ProjectId: request.projectId,
    ephemeral: false
  })
  const threadId = zero3ApiAgentId(started, 'thread')
  let timer = null
  try {
    const text = await Promise.race<string>([
      zero3ApiAgentRunTurn(threadId, [{ type: 'text', text: request.prompt, textElements: [] }]),
      new Promise<string>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Zero3 API task turn 超时')), ZERO3_API_TASK_TURN_DEADLINE_MS)
      })
    ])
    return { text, threadId, model: profile.model, profileId: profile.id }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const zero3Zero3ApiAvailabilityProbe = new Zero3Zero3ApiAvailabilityProbe({
  profileId: ZERO3_API_TASK_PROFILE_ID,
  healthTtlMs: ZERO3_API_TASK_HEALTH_TTL_MS,
  stateFile: path.join(app.getPath('userData'), 'zero3', 'zero3-api-task-health.json'),
  port: {
    listProfiles: zero3Zero3ApiTaskProfiles,
    usage: zero3Zero3ApiTaskUsage,
    metrics: () => zero3RoutingMetricsStore.snapshot()
  }
})
const zero3Zero3ApiTaskAdapter = new Zero3Zero3ApiTaskAdapter({
  probe: zero3Zero3ApiAvailabilityProbe,
  port: {
    listProfiles: zero3Zero3ApiTaskProfiles,
    runTurn: zero3Zero3ApiTaskTurn
  }
})

// Unified Web GPT task entry (dispatch_agent_task). Web GPT submits a typed
// objective; Zero3 owns routing, execution, verification and the Task Ledger. No
// shell string, executable, credential or routing internal crosses this boundary.
const ZERO3_AGENT_TASK_ROUTING_MODES = ['AUTO', 'PINNED', 'PREFERRED']
const ZERO3_AGENT_TASK_EXECUTORS = ['CODEX', 'CLAUDE', 'GEMINI', 'ZERO3_API']
const ZERO3_AGENT_TASK_TYPES = ['DESIGN', 'IMPLEMENT', 'VERIFY', 'FIX', 'REVIEW', 'INTEGRATE', 'RESEARCH']
const ZERO3_AGENT_TASK_IMPORTANCE = ['low', 'normal', 'high', 'critical']

function zero3AgentTaskInput(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function zero3AgentTaskRequiredText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(label + ' is required and must be at most ' + String(max) + ' characters')
  return text
}
function zero3AgentTaskOptionalText(value, label, max) {
  if (value == null || value === '') return null
  return zero3AgentTaskRequiredText(value, label, max)
}
function zero3AgentTaskEnum(value, allowed, label, fallback) {
  if (value == null || value === '') return fallback
  const text = zero3AgentTaskRequiredText(value, label, 32)
  if (!allowed.includes(text)) throw new Error(label + ' is invalid')
  return text
}
function zero3AgentTaskList(value, label) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 64) throw new Error(label + ' must be an array of at most 64 strings')
  return value.map((entry, index) => zero3AgentTaskRequiredText(entry, label + '[' + String(index) + ']', 4096))
}
// Workspace resolution is imported from the Remote Host Fast Path so explicit
// overrides and inferred project/session bindings share one allow-list gate.
async function zero3DispatchAgentTask(inputValue) {
  const startedAtMs = Date.now()
  const input = zero3AgentTaskInput(inputValue)
  const sessionId = zero3AgentTaskRequiredText(input.sessionId, 'sessionId', 256)
  const idempotencyKey = zero3AgentTaskRequiredText(input.idempotencyKey, 'idempotencyKey', 256)
  const objective = zero3AgentTaskRequiredText(input.objective, 'objective', 64_000)
  const routingMode = zero3AgentTaskEnum(input.routingMode, ZERO3_AGENT_TASK_ROUTING_MODES, 'routingMode', 'AUTO')
  const preferredExecutor = routingMode === 'AUTO'
    ? null
    : zero3AgentTaskEnum(input.preferredExecutor, ZERO3_AGENT_TASK_EXECUTORS, 'preferredExecutor', null)
  if (routingMode !== 'AUTO' && !preferredExecutor) throw new Error(routingMode + ' routing requires preferredExecutor')
  const importance = zero3AgentTaskEnum(input.importance, ZERO3_AGENT_TASK_IMPORTANCE, 'importance', 'normal')
  const context = await zero3AgentLifecycleRuntime.contextResolve({ sessionId })
  const taskContext = (context && typeof context === 'object' ? context : {}) as Record<string, any>
  const definition = (taskContext.task && typeof taskContext.task === 'object' ? taskContext.task : {}) as Record<string, any>
  const definitionTask = definition.definition && typeof definition.definition === 'object' ? definition.definition.task : null
  const projectId = zero3AgentTaskOptionalText(input.projectId, 'projectId', 256)
    ?? (definitionTask && typeof definitionTask.projectId === 'string' ? definitionTask.projectId : null)
    ?? (typeof taskContext.projectId === 'string' ? taskContext.projectId : null)
  if (!projectId || !/^[A-Za-z0-9._:-]+$/.test(projectId)) throw new Error('projectId could not be resolved for this session')
  const workspaceResolution = resolveZero3AgentWorkspace(input.workspace, {
    config: loadZero3RemoteHostConfig(),
    sessionId,
    lifecycleContext: context,
    projects: await zero3Projects.list(),
    workspaceEntries: await zero3WorkspaceEntries.list()
  })
  const workspace = workspaceResolution.workspace
  const constraints = zero3AgentTaskList(input.constraints, 'constraints')
  const acceptanceCriteria = zero3AgentTaskList(input.acceptanceCriteria, 'acceptanceCriteria')
  const taskType = zero3AgentTaskEnum(input.taskType, ZERO3_AGENT_TASK_TYPES, 'taskType', workspace ? 'IMPLEMENT' : 'RESEARCH')
  const dispatchStartedAtMs = Date.now()
  const contextVersion = Number.isSafeInteger(taskContext.contextVersion) && taskContext.contextVersion > 0
    ? taskContext.contextVersion
    : 1
  // Deterministic identity: the same (sessionId, idempotencyKey) always maps to
  // the same Task, so a retried call resumes the ledger instead of forking it.
  const digest = crypto.createHash('sha256').update(sessionId + '\\n' + idempotencyKey, 'utf8').digest('hex').slice(0, 32)
  const taskId = 'webgpt-' + digest
  const executionId = taskId + '-exec-1'
  const routedTarget = (routingMode === 'AUTO' ? 'AUTO' : preferredExecutor) as Zero3TaskSpecV2['target']
  const task: Zero3TaskSpecV2 = {
    protocol: 'zero3.pilot.task-spec.v2',
    taskId,
    executionId,
    projectId,
    target: routedTarget,
    type: taskType,
    title: 'Web GPT task ' + taskId,
    goal: objective,
    contextVersion,
    importance,
    ...(workspace ? { worktreePath: workspace } : {}),
    requirements: acceptanceCriteria,
    constraints,
    requiredContracts: [],
    inputArtifacts: [],
    expectedOutputs: [],
    verification: [],
    completionGate: [],
    reviewPolicy: { required: false, reviewer: 'GPT_WEB' },
    createdBySessionId: sessionId,
    createdAt: new Date().toISOString()
  }
  const record = await zero3AgentRuntime.dispatchAgentTask(task, {
    targetLogicalSessionId: 'web-gpt:' + sessionId,
    reviewSessionId: sessionId,
    importance,
    ...(routingMode === 'AUTO' ? {} : { routingMode: routingMode as 'AUTO' | 'PINNED' | 'PREFERRED' }),
    ...(preferredExecutor ? { preferredExecutor: preferredExecutor as 'CODEX' | 'GEMINI' | 'CLAUDE' | 'ZERO3_API' } : {})
  })
  const completedAtMs = Date.now()
  const telemetry = summarizeZero3AgentFastPathTelemetry(record, { startedAtMs, dispatchStartedAtMs, completedAtMs })
  await zero3AgentRuntime.recordFastPathTelemetry(taskId, telemetry)
  const decisions = Array.isArray(record.routingDecisions) ? record.routingDecisions : []
  const attempts = Array.isArray(record.attempts) ? record.attempts : []
  const result = record.result && typeof record.result === 'object' ? record.result : null
  return {
    taskId,
    executionId,
    workspace,
    workspaceSource: workspaceResolution.source,
    timingMs: telemetry.timingMs,
    counts: telemetry.counts,
    state: record.state,
    resolvedTarget: record.resolvedTarget,
    verificationProfile: record.verificationProfile ?? null,
    routingDecisions: decisions.map(decision => ({
      selectedExecutor: decision.selectedExecutor,
      routingMode: decision.routingMode,
      score: decision.score,
      reason: decision.reason,
      fallbackOrder: decision.fallbackOrder,
      rejectedExecutors: decision.rejectedExecutors
    })),
    attempts: attempts.map(attempt => ({
      attempt: attempt.attempt,
      executor: attempt.executor,
      status: attempt.status,
      failureCode: attempt.failureCode ?? null,
      failureClass: attempt.failureClass ?? null,
      failureReason: attempt.failureReason ?? null,
      failoverReason: attempt.failoverReason ?? null
    })),
    result: result
      ? {
          provider: result.provider,
          executorId: result.executorId ?? null,
          status: result.status,
          summary: typeof result.summary === 'string' ? result.summary.slice(0, 8_000) : null,
          failure: result.failure ?? null,
          timing: result.timing ?? null
        }
      : null
  }
}
`

export function applyZero3AgentZero3ApiRuntime() {
  stageSources()

  patchFile('electron/main.ts', [
    {
      label: 'Zero3 API executor import',
      appliedMarker: 'Zero3Zero3ApiTaskAdapter',
      from: " } from './zero3/agent-routing/index'",
      to: ", Zero3Zero3ApiTaskAdapter, Zero3Zero3ApiAvailabilityProbe } from './zero3/agent-routing/index'"
    },
    {
      label: 'Zero3 API executor composition',
      appliedMarker: 'const zero3Zero3ApiTaskAdapter = new Zero3Zero3ApiTaskAdapter({',
      from: CLAUDE_ADAPTER_BLOCK,
      to: CLAUDE_ADAPTER_BLOCK + '\n' + zero3ApiExecutorBlock
    },
    {
      label: 'Zero3 API availability probe reading',
      appliedMarker: 'const zero3ApiAvailability = await zero3Zero3ApiAvailabilityProbe.probe()',
      from: '  const claudeAvailability = await zero3ClaudeTaskAdapter.availability()\n',
      to: '  const claudeAvailability = await zero3ClaudeTaskAdapter.availability()\n  const zero3ApiAvailability = await zero3Zero3ApiAvailabilityProbe.probe()\n'
    },
    {
      label: 'Zero3 API availability state',
      appliedMarker: '    zero3Api: zero3ApiAvailability',
      from: '    claude: claudeAvailability\n  }',
      to: '    claude: claudeAvailability,\n    zero3Api: zero3ApiAvailability\n  }'
    },
    {
      label: 'Zero3 API dispatcher dependency',
      appliedMarker: '  zero3Api: zero3Zero3ApiTaskAdapter,',
      from: '  claude: zero3ClaudeTaskAdapter,\n  skills: zero3TaskSkillRuntime,',
      to: '  claude: zero3ClaudeTaskAdapter,\n  zero3Api: zero3Zero3ApiTaskAdapter,\n  skills: zero3TaskSkillRuntime,'
    }
  ])
}

// The unified Web GPT dispatch tool extends the worker RPC composite. That
// composite is composed by the Agent Lifecycle overlay, so this patch runs
// immediately after it (prepare-codex-upstream / desktop-reload) instead of
// during the Gemini/agent stage where the anchor does not exist yet.
export function applyZero3UnifiedAgentTaskDispatch() {
  patchFile('electron/main.ts', [
    {
      label: 'unified Web GPT dispatch tool',
      appliedMarker: 'dispatchAgentTask: input => zero3DispatchAgentTask(input)',
      from: '    claimWorkV2: input => zero3WorkflowWorkerRuntime.claimWorkV2(input),\n    reportProgressV2: input => zero3WorkflowWorkerRuntime.reportProgressV2(input)\n  }',
      to: '    claimWorkV2: input => zero3WorkflowWorkerRuntime.claimWorkV2(input),\n    reportProgressV2: input => zero3WorkflowWorkerRuntime.reportProgressV2(input),\n    dispatchAgentTask: input => zero3DispatchAgentTask(input)\n  }'
    }
  ])
}

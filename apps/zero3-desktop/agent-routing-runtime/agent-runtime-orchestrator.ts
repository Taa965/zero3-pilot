import {
  ZERO3_EXECUTION_RESULT_V2,
  type Zero3ArtifactRef,
  type Zero3CrossAgentBinding,
  type Zero3ExecutionResultV2,
  type Zero3ExecutorFailureClass,
  type Zero3ResolvedAgentTarget,
  type Zero3ReviewDecision,
  type Zero3TaskImportance,
  type Zero3TaskSpecV2,
  type Zero3VerificationResult
} from './agent-contracts'
import type { ExecutorFailureCode } from '../executor-runtime/executor-types'
import type { Zero3ResolvedTaskSkill, Zero3SkillUsageRecord } from '../skill-runtime/skill-types'
import { Zero3AgentRouter, type Zero3ProviderAvailability } from './agent-router'
import { Zero3AgentTaskStore, type Zero3AgentTaskRecord, type Zero3AgentTaskState, type Zero3TaskAttemptRecord } from './agent-task-store'
import { Zero3ReviewLoopStore } from './review-loop-store'
import { verificationProfile, verificationProfileFor, type Zero3IntelligentRouteDecision, type Zero3RoutingExecutorId, type Zero3RoutingMode, type Zero3RoutingRequest, type Zero3VerificationProfileName } from './intelligent-router-contracts'
import type { Zero3IntelligentTaskRouter } from './intelligent-router'
import type { Zero3RoutingMetricsStore, Zero3RoutingOutcomeInput } from './routing-metrics-store'
import { classifyExecutorError } from './zero3-executor-failure'

export type Zero3CodexTaskDispatcher = {
  dispatchTask(task: Zero3TaskSpecV2, skills?: readonly Zero3ResolvedTaskSkill[]): Promise<Zero3ExecutionResultV2>
}

export type Zero3ClaudeTaskDispatcher = {
  dispatchTask(task: Zero3TaskSpecV2, skills?: readonly Zero3ResolvedTaskSkill[], skillContext?: string): Promise<Zero3ExecutionResultV2>
}

export type Zero3Zero3ApiTaskDispatcher = {
  dispatchTask(task: Zero3TaskSpecV2, skills?: readonly Zero3ResolvedTaskSkill[], skillContext?: string): Promise<Zero3ExecutionResultV2>
}

export type Zero3TaskSkillRuntime = {
  resolve(task: Zero3TaskSpecV2, target: Zero3ResolvedAgentTarget): Promise<Zero3ResolvedTaskSkill[]>
  renderContext(skills: readonly Zero3ResolvedTaskSkill[]): Promise<string>
  recordUsage(input: Omit<Zero3SkillUsageRecord, 'usageId' | 'at'>): Promise<unknown>
}

export type Zero3AntigravityTurnResultLike = {
  turnId: string
  logicalSessionId: string
  conversationId: string | null
  status: 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  response: string | null
  structuredOutput: unknown | null
  error: string | null
  rawStatus: string | null
}

export type Zero3AntigravityTaskRuntime = {
  startTurn(input: {
    logicalSessionId: string
    projectId?: string | null
    cwd: string
    prompt: string
    taskId?: string | null
    contextVersion?: number | null
  }): Promise<{ turnId: string }>
  waitTurn(turnId: string): Promise<Zero3AntigravityTurnResultLike>
}

export type Zero3AgentDispatchContext = {
  targetLogicalSessionId: string
  reviewSessionId?: string | null
  runtimeConversationId?: string | null
  // Intelligent-routing controls. Absent values inherit TaskSpec semantics:
  // an explicit TaskSpec target dispatches PINNED, AUTO dispatches AUTO.
  routingMode?: Zero3RoutingMode
  importance?: Zero3TaskImportance
  preferredExecutor?: Zero3RoutingExecutorId
}

// The unified Intelligent Agent Task Router surface. The router only decides;
// the orchestrator owns lifecycle, adapters own provider calls and the task
// store owns the authoritative Task Ledger.
export type Zero3IntelligentRoutingDependencies = {
  router: Pick<Zero3IntelligentTaskRouter, 'route'>
  metrics?: Pick<Zero3RoutingMetricsStore, 'snapshot' | 'recordOutcome'>
  // Total execution attempts (including the first) before giving up.
  maxAttempts?: number
  // Maximum executor switches (failovers) inside one dispatch.
  maxExecutorSwitches?: number
}

export type Zero3AgentRuntimeDependencies = {
  router: Zero3AgentRouter
  taskStore: Zero3AgentTaskStore
  reviewStore: Zero3ReviewLoopStore
  antigravity: Zero3AntigravityTaskRuntime
  codex: Zero3CodexTaskDispatcher
  claude?: Zero3ClaudeTaskDispatcher
  zero3Api?: Zero3Zero3ApiTaskDispatcher
  skills?: Zero3TaskSkillRuntime
  availability: () => Promise<Zero3ProviderAvailability> | Zero3ProviderAvailability
  finalizeResult: (task: Zero3TaskSpecV2, candidate: Zero3ExecutionResultV2) => Promise<Zero3ExecutionResultV2>
  // When configured, dispatch() uses the Intelligent Agent Task Router with
  // bounded failover instead of the single-shot legacy route.
  intelligentRouting?: Zero3IntelligentRoutingDependencies
}

type JsonRecord = Record<string, unknown>

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_EXECUTOR_SWITCHES = 2

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 10_000)
}

function artifactRefs(value: unknown, cycle = 1): Zero3ArtifactRef[] {
  if (!Array.isArray(value)) return []
  const result: Zero3ArtifactRef[] = []
  for (const item of value.slice(0, 1_000)) {
    const row = record(item)
    const artifactId = text(row.artifactId)
    const kind = text(row.kind)
    const pathOrUri = text(row.pathOrUri)
    const hash = text(row.hash)
    if (!artifactId || !kind || !pathOrUri || !hash) continue
    result.push({
      artifactId,
      kind,
      pathOrUri,
      hash,
      sourceProvider: 'GEMINI',
      sourceCycle: Number.isSafeInteger(row.sourceCycle) ? Number(row.sourceCycle) : cycle,
      createdAt: text(row.createdAt, new Date().toISOString())
    })
  }
  return result
}

function verificationResults(value: unknown): Zero3VerificationResult[] {
  if (!Array.isArray(value)) return []
  const result: Zero3VerificationResult[] = []
  for (const item of value.slice(0, 1_000)) {
    const row = record(item)
    const id = text(row.id)
    const state = text(row.state)
    if (!id || !['PASSED', 'FAILED', 'NOT_RUN', 'BLOCKED'].includes(state)) continue
    result.push({
      id,
      state: state as Zero3VerificationResult['state'],
      command: text(row.command) || null,
      evidence: text(row.evidence) || null,
      reason: text(row.reason) || null
    })
  }
  return result
}

function normalizeRecommendedAction(value: unknown): Zero3ExecutionResultV2['recommendedAction'] {
  const candidate = text(value)
  return ['GPT_REVIEW', 'HUMAN_REVIEW', 'CODEX_IMPLEMENT', 'RETRY'].includes(candidate)
    ? candidate as Zero3ExecutionResultV2['recommendedAction']
    : 'GPT_REVIEW'
}

function mapGeminiTurn(task: Zero3TaskSpecV2, turn: Zero3AntigravityTurnResultLike): Zero3ExecutionResultV2 {
  if (turn.status === 'OUTCOME_UNKNOWN') {
    return {
      protocol: ZERO3_EXECUTION_RESULT_V2,
      taskId: task.taskId,
      executionId: task.executionId,
      projectId: task.projectId,
      provider: 'GEMINI',
      providerRuntime: 'GEMINI_AGENT',
      status: 'OUTCOME_UNKNOWN',
      contextVersion: task.contextVersion,
      conversationId: turn.conversationId,
      summary: turn.error || 'Antigravity exited without a terminal structured result.',
      changedFiles: [],
      artifacts: [],
      git: task.baseSha || task.branch ? { baseSha: task.baseSha ?? null, branch: task.branch ?? null } : null,
      verification: [],
      knownIssues: [],
      blockers: ['Runtime outcome is unknown; reconcile authoritative Git/artifact evidence before retrying.'],
      recommendedAction: 'HUMAN_REVIEW',
      completedAt: new Date().toISOString()
    }
  }

  const structured = record(turn.structuredOutput)
  const structuredStatus = text(structured.status)
  const status = ['COMPLETE', 'PARTIAL', 'BLOCKED', 'FAILED'].includes(structuredStatus)
    ? structuredStatus as Zero3ExecutionResultV2['status']
    : turn.status
  const rawGit = record(structured.git)

  return {
    protocol: ZERO3_EXECUTION_RESULT_V2,
    taskId: task.taskId,
    executionId: task.executionId,
    projectId: task.projectId,
    provider: 'GEMINI',
    providerRuntime: 'GEMINI_AGENT',
    status,
    contextVersion: task.contextVersion,
    conversationId: turn.conversationId,
    summary: text(structured.summary, turn.response || turn.error || 'Gemini task completed without a summary.'),
    changedFiles: stringArray(structured.changedFiles),
    artifacts: artifactRefs(structured.artifacts),
    git: Object.keys(rawGit).length > 0
      ? {
          baseSha: text(rawGit.baseSha, task.baseSha ?? '') || null,
          headSha: text(rawGit.headSha) || null,
          commitSha: text(rawGit.commitSha) || null,
          branch: text(rawGit.branch, task.branch ?? '') || null
        }
      : task.baseSha || task.branch
        ? { baseSha: task.baseSha ?? null, branch: task.branch ?? null }
        : null,
    verification: verificationResults(structured.verification),
    knownIssues: stringArray(structured.knownIssues),
    blockers: stringArray(structured.blockers),
    recommendedAction: normalizeRecommendedAction(structured.recommendedAction),
    completedAt: new Date().toISOString()
  }
}

function assertResultIdentity(task: Zero3TaskSpecV2, target: Zero3ResolvedAgentTarget, result: Zero3ExecutionResultV2): void {
  if (result.protocol !== ZERO3_EXECUTION_RESULT_V2) throw new Error('execution result protocol is invalid')
  if (result.taskId !== task.taskId || result.executionId !== task.executionId || result.projectId !== task.projectId) {
    throw new Error('execution result identity mismatch')
  }
  if (result.contextVersion !== task.contextVersion) throw new Error('execution result contextVersion mismatch')
  if (result.provider !== target) throw new Error(`execution result provider ${result.provider} does not match resolved target ${target}`)
  if (target === 'CODEX' && result.providerRuntime !== 'CODEX_LOCAL') throw new Error('CODEX result must use CODEX_LOCAL runtime')
  if (target === 'GEMINI' && result.providerRuntime !== 'GEMINI_AGENT') throw new Error('GEMINI result must use GEMINI_AGENT runtime')
  if (target === 'CLAUDE' && result.providerRuntime !== 'CLAUDE_CODE') throw new Error('CLAUDE result must use CLAUDE_CODE runtime')
  if (target === 'ZERO3_API' && result.providerRuntime !== 'ZERO3_API_SESSION') throw new Error('ZERO3_API result must use ZERO3_API_SESSION runtime')
}

function stateForResult(result: Zero3ExecutionResultV2, reviewRequired: boolean): Zero3AgentTaskState {
  switch (result.status) {
    case 'OUTCOME_UNKNOWN': return 'OUTCOME_UNKNOWN'
    case 'FAILED': return 'FAILED'
    case 'BLOCKED': return 'BLOCKED'
    case 'PARTIAL': return reviewRequired ? 'REVIEW_PENDING' : 'RESULT_READY'
    case 'COMPLETE': return reviewRequired ? 'REVIEW_PENDING' : 'COMPLETE'
  }
}

function attemptStatusFor(status: Zero3ExecutionResultV2['status'] | null): Zero3TaskAttemptRecord['status'] {
  switch (status) {
    case 'COMPLETE':
    case 'PARTIAL':
      return 'SUCCEEDED'
    case 'BLOCKED':
      return 'BLOCKED'
    case 'OUTCOME_UNKNOWN':
      return 'OUTCOME_UNKNOWN'
    default:
      return 'FAILED'
  }
}

function bindingFor(task: Zero3TaskSpecV2, context: Zero3AgentDispatchContext): Zero3CrossAgentBinding {
  const timestamp = new Date().toISOString()
  return {
    projectId: task.projectId,
    taskId: task.taskId,
    originSessionId: task.createdBySessionId,
    targetLogicalSessionId: context.targetLogicalSessionId,
    reviewSessionId: context.reviewSessionId ?? null,
    runtimeConversationId: context.runtimeConversationId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function normalizeImportance(value: unknown): Zero3TaskImportance {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'critical' ? value : 'normal'
}

function isRoutingExecutorId(value: unknown): value is Zero3RoutingExecutorId {
  return value === 'CODEX' || value === 'GEMINI' || value === 'CLAUDE' || value === 'ZERO3_API'
}

// Explicit TaskSpec targets stay pinned by default: they are never silently
// switched. PREFERRED is opt-in through the dispatch context.
function resolveRoutingMode(
  task: Zero3TaskSpecV2,
  context: Zero3AgentDispatchContext
): { mode: Zero3RoutingMode; requestedExecutor: Zero3RoutingExecutorId | null } {
  if (task.target !== 'AUTO') {
    return {
      mode: context.routingMode === 'PREFERRED' ? 'PREFERRED' : 'PINNED',
      requestedExecutor: task.target
    }
  }
  if (context.routingMode === 'PINNED') {
    throw new Error('PINNED routing requires an explicit TaskSpec target executor')
  }
  if (context.preferredExecutor) {
    if (!isRoutingExecutorId(context.preferredExecutor)) {
      throw new Error(`preferred executor ${String(context.preferredExecutor)} is not a registered routing executor`)
    }
    return { mode: 'PREFERRED', requestedExecutor: context.preferredExecutor }
  }
  return { mode: 'AUTO', requestedExecutor: null }
}

// High/critical tasks must not be reviewed by the same model that executed
// them. Reviewer slots are GPT_WEB | HUMAN | CODEX, so only a CODEX reviewer on
// a CODEX execution collapses into one model; remap it to Web GPT.
function applyReviewerIndependence(
  task: Zero3TaskSpecV2,
  provider: Zero3ResolvedAgentTarget,
  profileName: Zero3VerificationProfileName
): Zero3TaskSpecV2 {
  if (!verificationProfile(profileName).requiresDistinctReviewer) return task
  if (task.reviewPolicy.reviewer !== 'CODEX' || provider !== 'CODEX') return task
  return { ...task, reviewPolicy: { ...task.reviewPolicy, reviewer: 'GPT_WEB' } }
}

type AttemptFailure = {
  // A different executor may legally pick the task up.
  switchEligible: boolean
  // The executor itself failed, so it is excluded for the rest of this task.
  // `retry_same_executor` failures keep the executor eligible.
  blameExecutor: boolean
  code: ExecutorFailureCode | null
  failureClass: Zero3ExecutorFailureClass | null
  reason: string
}

// BLOCKED (auth/permission/policy/context gates) and OUTCOME_UNKNOWN stay with
// the current authority: they are human-review/recovery situations, never
// automatic provider switches.
function classifyAttemptFailure(result: Zero3ExecutionResultV2 | null, thrown: unknown): AttemptFailure {
  // An adapter that classified its own failure is authoritative: the routing
  // decision (re-route vs retry vs waiting-human) is read from its class.
  const declared = result?.failure ?? null
  if (declared) {
    return {
      switchEligible: declared.class === 'reroute' || declared.class === 'retry_same_executor',
      blameExecutor: declared.class === 'reroute',
      code: declared.code,
      failureClass: declared.class,
      reason: `${declared.code} (${declared.class}): ${declared.detail}`
    }
  }
  if (!result) {
    // An undeclared crash carries no trustworthy class, so Zero3 keeps the
    // pre-P1 policy for it: blame the executor and continue elsewhere. Only an
    // adapter that explicitly declares its failure may ask for a same-executor
    // retry or a human gate.
    const failure = classifyExecutorError(thrown)
    const failureClass: Zero3ExecutorFailureClass =
      failure.class === 'outcome_unknown' || failure.class === 'waiting_human' ? failure.class : 'reroute'
    return {
      switchEligible: failureClass === 'reroute',
      blameExecutor: failureClass === 'reroute',
      code: failure.code,
      failureClass,
      reason: `executor raised an error: ${failure.code} (${failureClass}): ${failure.detail}`
    }
  }
  switch (result.status) {
    case 'COMPLETE':
    case 'PARTIAL':
      return { switchEligible: false, blameExecutor: false, code: null, failureClass: null, reason: 'succeeded' }
    case 'FAILED':
      return {
        switchEligible: true,
        blameExecutor: true,
        code: 'provider_error',
        failureClass: 'reroute',
        reason: `executor reported FAILED: ${result.summary || result.blockers[0] || 'no failure detail'}`
      }
    case 'BLOCKED':
      return {
        switchEligible: false,
        blameExecutor: false,
        code: 'policy_denied',
        failureClass: 'waiting_human',
        reason: `executor blocked the task: ${result.summary || result.blockers[0] || 'policy gate'}`
      }
    case 'OUTCOME_UNKNOWN':
      return {
        switchEligible: false,
        blameExecutor: false,
        code: 'context_lost',
        failureClass: 'outcome_unknown',
        reason: 'executor outcome is unknown; recovery reconciliation is required'
      }
    default:
      return {
        switchEligible: false,
        blameExecutor: false,
        code: null,
        failureClass: null,
        reason: `executor returned an unrecognized terminal status ${String(result.status)}`
      }
  }
}

type PriorAttemptSummary = {
  executor: Zero3RoutingExecutorId
  status: Zero3TaskAttemptRecord['status']
  reason: string
}

// Executor switches must not restart the task from zero. The next executor
// receives the attempt chain (who ran, what happened, why it stopped) inside the
// authoritative TaskSpec goal, while the TaskSpec identity fields stay untouched
// so TaskSpec-driven idempotency and the CompletionGate are unaffected.
function withPriorAttemptContext(task: Zero3TaskSpecV2, prior: readonly PriorAttemptSummary[]): Zero3TaskSpecV2 {
  if (prior.length === 0) return task
  const lines = prior.slice(-6).map(entry =>
    `- attempt executor=${entry.executor} status=${entry.status} reason=${entry.reason.replace(/\s+/g, ' ').trim().slice(0, 500)}`
  )
  return {
    ...task,
    goal: [
      task.goal,
      '',
      'ZERO3_PRIOR_ATTEMPT_CONTEXT:',
      'This task already ran under another executor. Continue the same TaskSpec; do not restart from scratch and do not discard valid earlier work.',
      ...lines
    ].join('\n')
  }
}

function verificationPassedOf(result: Zero3ExecutionResultV2): boolean {
  if (result.verification.length > 0) return result.verification.every(entry => entry.state === 'PASSED')
  return result.status === 'COMPLETE'
}

export class Zero3AgentRuntimeOrchestrator {
  constructor(private readonly deps: Zero3AgentRuntimeDependencies) {}

  private async recordSkillUsage(task: Zero3TaskSpecV2, target: Zero3ResolvedAgentTarget, skills: readonly Zero3ResolvedTaskSkill[], outcome: 'selected' | 'completed' | 'failed', latencyMs: number | null) {
    if (!this.deps.skills) return
    await Promise.all(skills.map(skill => this.deps.skills!.recordUsage({
      taskId: task.taskId, executionId: task.executionId, projectId: task.projectId,
      workflowId: task.workflowId ?? null, target, skillName: skill.name, skillPath: skill.path,
      source: skill.source, outcome, latencyMs
    })))
  }

  // Single executor attempt: provider call + authoritative finalization. No
  // routing, no retry policy — the dispatch loop owns those.
  private async dispatchToTarget(
    task: Zero3TaskSpecV2,
    context: Zero3AgentDispatchContext,
    target: Zero3ResolvedAgentTarget,
    resolvedSkills: readonly Zero3ResolvedTaskSkill[],
    binding: Zero3CrossAgentBinding
  ): Promise<{ result: Zero3ExecutionResultV2; binding: Zero3CrossAgentBinding }> {
    let candidate: Zero3ExecutionResultV2
    if (target === 'GEMINI') {
      if (!task.worktreePath?.trim()) throw new Error('Gemini writable tasks require an explicit isolated worktreePath')
      const skillContext = this.deps.skills ? await this.deps.skills.renderContext(resolvedSkills) : ''
      const started = await this.deps.antigravity.startTurn({
        logicalSessionId: context.targetLogicalSessionId,
        projectId: task.projectId,
        cwd: task.worktreePath,
        prompt: skillContext ? `${skillContext}\n\n${task.goal}` : task.goal,
        taskId: task.taskId,
        contextVersion: task.contextVersion
      })
      const turn = await this.deps.antigravity.waitTurn(started.turnId)
      if (turn.conversationId !== binding.runtimeConversationId) {
        binding = { ...binding, runtimeConversationId: turn.conversationId, updatedAt: new Date().toISOString() }
        await this.deps.taskStore.setBinding(task.taskId, binding)
      }
      candidate = mapGeminiTurn(task, turn)
    } else if (target === 'CLAUDE') {
      if (!this.deps.claude) throw new Error('Claude task dispatcher is not configured')
      const skillContext = this.deps.skills ? await this.deps.skills.renderContext(resolvedSkills) : ''
      candidate = await this.deps.claude.dispatchTask(task, resolvedSkills, skillContext)
    } else if (target === 'ZERO3_API') {
      if (!this.deps.zero3Api) throw new Error('Zero3 API task dispatcher is not configured')
      const skillContext = this.deps.skills ? await this.deps.skills.renderContext(resolvedSkills) : ''
      candidate = await this.deps.zero3Api.dispatchTask(task, resolvedSkills, skillContext)
    } else {
      candidate = await this.deps.codex.dispatchTask(task, resolvedSkills)
    }

    assertResultIdentity(task, target, candidate)
    candidate = await this.deps.finalizeResult(task, candidate)
    assertResultIdentity(task, target, candidate)
    return { result: candidate, binding }
  }

  async dispatch(task: Zero3TaskSpecV2, context: Zero3AgentDispatchContext): Promise<Zero3AgentTaskRecord> {
    if (this.deps.intelligentRouting) return this.dispatchAgentTask(task, context)
    return this.dispatchLegacy(task, context)
  }

  // Legacy single-shot path: preserved verbatim for compatibility with the
  // Web GPT Fast Path and every caller that has not opted into intelligent
  // routing yet.
  private async dispatchLegacy(task: Zero3TaskSpecV2, context: Zero3AgentDispatchContext): Promise<Zero3AgentTaskRecord> {
    const availability = await this.deps.availability()
    const route = this.deps.router.resolve(task, availability)
    const startedAt = Date.now()
    const resolvedSkills = this.deps.skills ? await this.deps.skills.resolve(task, route.target) : []
    await this.deps.taskStore.create(task, route.target)
    await this.deps.taskStore.setSkills(task.taskId, resolvedSkills)
    await this.recordSkillUsage(task, route.target, resolvedSkills, 'selected', null)
    let binding = bindingFor(task, context)
    await this.deps.taskStore.setBinding(task.taskId, binding)
    await this.deps.taskStore.setState(task.taskId, 'DISPATCHED')
    await this.deps.taskStore.setState(task.taskId, 'RUNNING')

    let candidate: Zero3ExecutionResultV2
    try {
      const dispatched = await this.dispatchToTarget(task, context, route.target, resolvedSkills, binding)
      candidate = dispatched.result
      binding = dispatched.binding
      await this.recordSkillUsage(task, route.target, resolvedSkills, candidate.status === 'FAILED' ? 'failed' : 'completed', Date.now() - startedAt)
    } catch (error) {
      await this.recordSkillUsage(task, route.target, resolvedSkills, 'failed', Date.now() - startedAt)
      await this.deps.taskStore.setState(task.taskId, 'FAILED')
      throw error
    }

    const nextState = stateForResult(candidate, task.reviewPolicy.required)
    await this.deps.taskStore.setResult(task.taskId, candidate, nextState)

    if (task.reviewPolicy.required && candidate.status !== 'FAILED' && candidate.status !== 'BLOCKED' && candidate.status !== 'OUTCOME_UNKNOWN') {
      await this.deps.reviewStore.createReview(task, candidate, binding)
      await this.deps.taskStore.setState(task.taskId, 'REVIEW_PENDING')
    }
    return (await this.deps.taskStore.get(task.taskId))!
  }

  // Unified intelligent entry point (`dispatch_agent_task`): the TaskSpec
  // describes the goal and constraints, Zero3 decides who executes. On
  // retryable failure the router re-selects among remaining eligible executors
  // while Task identity, Handoff and ledger history stay intact.
  async dispatchAgentTask(task: Zero3TaskSpecV2, context: Zero3AgentDispatchContext): Promise<Zero3AgentTaskRecord> {
    const routing = this.deps.intelligentRouting
    if (!routing) throw new Error('intelligent routing is not configured')
    const maxAttempts = routing.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const maxExecutorSwitches = routing.maxExecutorSwitches ?? DEFAULT_MAX_EXECUTOR_SWITCHES
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer')
    if (!Number.isSafeInteger(maxExecutorSwitches) || maxExecutorSwitches < 0) throw new Error('maxExecutorSwitches must be a non-negative integer')

    const importance = normalizeImportance(context.importance ?? task.importance)
    const profileName = verificationProfileFor(importance)
    const { mode, requestedExecutor } = resolveRoutingMode(task, context)

    const exclusions: Zero3RoutingExecutorId[] = []
    const priorAttempts: PriorAttemptSummary[] = []
    let attempts = 0
    let switches = 0
    let created = false

    while (attempts < maxAttempts) {
      const availability = await this.deps.availability()
      let metrics = null
      if (routing.metrics) {
        try {
          metrics = await routing.metrics.snapshot()
        } catch {
          metrics = null
        }
      }
      let decision: Zero3IntelligentRouteDecision
      try {
        const request: Zero3RoutingRequest = { task, mode, requestedExecutor, importance, availability, metrics, exclusions }
        decision = routing.router.route(request)
      } catch (error) {
        // Routing-level failure: pinned executor unavailable or no eligible
        // executor left. Before any attempt ran this is waiting-human
        // (BLOCKED); after attempts have run the candidate chain is exhausted
        // and the task terminates as FAILED.
        if (created) await this.deps.taskStore.setState(task.taskId, attempts > 0 ? 'FAILED' : 'BLOCKED')
        throw error
      }

      if (!created) {
        await this.deps.taskStore.create(task, decision.provider)
        await this.deps.taskStore.setRoutingMeta(task.taskId, { importance, verificationProfile: profileName })
        created = true
      } else if (attempts > 0) {
        await this.deps.taskStore.setResolvedTarget(task.taskId, decision.provider)
      }
      await this.deps.taskStore.appendRoutingDecision(task.taskId, decision)
      await this.deps.taskStore.setState(task.taskId, attempts === 0 ? 'DISPATCHED' : 'RUNNING')

      const attemptNumber = attempts + 1
      const attemptId = `${task.executionId}:attempt-${attemptNumber}`
      const startedAt = Date.now()
      const attemptTask = withPriorAttemptContext(
        applyReviewerIndependence(task, decision.provider, profileName),
        priorAttempts
      )
      const resolvedSkills = this.deps.skills ? await this.deps.skills.resolve(attemptTask, decision.provider) : []
      await this.deps.taskStore.setSkills(task.taskId, resolvedSkills)
      await this.recordSkillUsage(attemptTask, decision.provider, resolvedSkills, 'selected', null)
      let binding = bindingFor(attemptTask, context)
      if (attempts === 0) await this.deps.taskStore.setBinding(task.taskId, binding)
      await this.deps.taskStore.appendAttempt(task.taskId, {
        attemptId,
        attempt: attemptNumber,
        executor: decision.selectedExecutor,
        provider: decision.provider,
        routingMode: decision.routingMode,
        importance,
        verificationProfile: profileName,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: null,
        status: 'RUNNING',
        conversationId: null,
        failureReason: null,
        failoverReason: null
      })

      let result: Zero3ExecutionResultV2 | null = null
      let thrown: unknown = null
      try {
        const dispatched = await this.dispatchToTarget(attemptTask, context, decision.provider, resolvedSkills, binding)
        result = dispatched.result
        binding = dispatched.binding
      } catch (error) {
        thrown = error
      }
      const latencyMs = Date.now() - startedAt
      const succeeded = result != null && (result.status === 'COMPLETE' || result.status === 'PARTIAL')
      const failure = classifyAttemptFailure(result, thrown)

      if (result) {
        const attemptStatus = attemptStatusFor(result.status)
        await this.deps.taskStore.updateAttempt(task.taskId, attemptId, {
          finishedAt: new Date().toISOString(),
          status: attemptStatus,
          conversationId: result.conversationId ?? null,
          failureReason: succeeded ? null : (result.summary || result.blockers[0] || result.status),
          executorId: result.executorId ?? null,
          failureCode: succeeded ? null : failure.code,
          failureClass: succeeded ? null : failure.failureClass
        })
      } else {
        await this.deps.taskStore.updateAttempt(task.taskId, attemptId, {
          finishedAt: new Date().toISOString(),
          status: 'FAILED',
          failureReason: thrown instanceof Error ? thrown.message : String(thrown),
          executorId: null,
          failureCode: failure.code,
          failureClass: failure.failureClass
        })
      }
      await this.recordSkillUsage(attemptTask, decision.provider, resolvedSkills, succeeded ? 'completed' : 'failed', latencyMs)
      if (routing.metrics) {
        const outcome: Zero3RoutingOutcomeInput = {
          executorId: decision.selectedExecutor,
          taskClass: task.type,
          succeeded,
          verificationPassed: result ? verificationPassedOf(result) : false,
          latencyMs,
          failover: attempts > 0
        }
        try {
          await routing.metrics.recordOutcome(outcome)
        } catch {
          // Metrics must never break dispatch.
        }
      }

      if (succeeded && result) {
        const nextState = stateForResult(result, attemptTask.reviewPolicy.required)
        await this.deps.taskStore.setResult(task.taskId, result, nextState)
        if (attemptTask.reviewPolicy.required && result.status !== 'FAILED' && result.status !== 'BLOCKED' && result.status !== 'OUTCOME_UNKNOWN') {
          await this.deps.reviewStore.createReview(attemptTask, result, binding)
          await this.deps.taskStore.setState(task.taskId, 'REVIEW_PENDING')
        }
        return (await this.deps.taskStore.get(task.taskId))!
      }

      if (result) {
        await this.deps.taskStore.setResult(task.taskId, result, stateForResult(result, attemptTask.reviewPolicy.required))
      }
      priorAttempts.push({
        executor: decision.selectedExecutor,
        status: attemptStatusFor(result?.status ?? null),
        reason: failure.reason
      })

      // PINNED tasks never switch executors: a pinned failure is surfaced to
      // the user instead of being silently re-routed to another provider.
      const canSwitch = failure.switchEligible
        && mode !== 'PINNED'
        && switches < maxExecutorSwitches
        && attempts + 1 < maxAttempts
      if (!canSwitch) {
        if (result) return (await this.deps.taskStore.get(task.taskId))!
        await this.deps.taskStore.setState(task.taskId, 'FAILED')
        throw thrown ?? new Error(`agent task dispatch failed: ${failure.reason}`)
      }
      await this.deps.taskStore.updateAttempt(task.taskId, attemptId, {
        failoverReason: `${failure.reason} -> re-route (${failure.blameExecutor ? 'executor excluded' : 'executor kept eligible for a retry'})`
      })
      // Only an executor that actually failed is excluded. A retryable
      // same-executor failure keeps it in the candidate set, so the router
      // re-evaluates instead of being forced onto the next slot in a list.
      if (failure.blameExecutor) exclusions.push(decision.selectedExecutor)
      switches += 1
      attempts += 1
    }

    // Defensive: the switch bounds above make this unreachable, but a terminal
    // failure must never fall through silently.
    await this.deps.taskStore.setState(task.taskId, 'FAILED')
    throw new Error('agent task dispatch exhausted all attempts')
  }

  async submitReviewDecision(taskId: string, decision: Zero3ReviewDecision, contextVersion: number): Promise<Zero3AgentTaskRecord> {
    const review = await this.deps.reviewStore.submitDecision(taskId, decision, contextVersion)
    const state: Zero3AgentTaskState = review.state
    await this.deps.taskStore.setState(taskId, state)
    return (await this.deps.taskStore.get(taskId))!
  }

  task(taskId: string): Promise<Zero3AgentTaskRecord | null> {
    return this.deps.taskStore.get(taskId)
  }
}

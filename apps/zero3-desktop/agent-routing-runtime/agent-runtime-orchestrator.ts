import {
  ZERO3_EXECUTION_RESULT_V2,
  type Zero3ArtifactRef,
  type Zero3CrossAgentBinding,
  type Zero3ExecutionResultV2,
  type Zero3ReviewDecision,
  type Zero3TaskSpecV2,
  type Zero3VerificationResult
} from './agent-contracts'
import { Zero3AgentRouter, type Zero3ProviderAvailability } from './agent-router'
import { Zero3AgentTaskStore, type Zero3AgentTaskRecord, type Zero3AgentTaskState } from './agent-task-store'
import { Zero3ReviewLoopStore } from './review-loop-store'

export type Zero3CodexTaskDispatcher = {
  dispatchTask(task: Zero3TaskSpecV2): Promise<Zero3ExecutionResultV2>
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
}

export type Zero3AgentRuntimeDependencies = {
  router: Zero3AgentRouter
  taskStore: Zero3AgentTaskStore
  reviewStore: Zero3ReviewLoopStore
  antigravity: Zero3AntigravityTaskRuntime
  codex: Zero3CodexTaskDispatcher
  availability: () => Promise<Zero3ProviderAvailability> | Zero3ProviderAvailability
  finalizeResult: (task: Zero3TaskSpecV2, candidate: Zero3ExecutionResultV2) => Promise<Zero3ExecutionResultV2>
}

type JsonRecord = Record<string, unknown>

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

function assertResultIdentity(task: Zero3TaskSpecV2, target: 'CODEX' | 'GEMINI', result: Zero3ExecutionResultV2): void {
  if (result.protocol !== ZERO3_EXECUTION_RESULT_V2) throw new Error('execution result protocol is invalid')
  if (result.taskId !== task.taskId || result.executionId !== task.executionId || result.projectId !== task.projectId) {
    throw new Error('execution result identity mismatch')
  }
  if (result.contextVersion !== task.contextVersion) throw new Error('execution result contextVersion mismatch')
  if (result.provider !== target) throw new Error(`execution result provider ${result.provider} does not match resolved target ${target}`)
  if (target === 'CODEX' && result.providerRuntime !== 'CODEX_LOCAL') throw new Error('CODEX result must use CODEX_LOCAL runtime')
  if (target === 'GEMINI' && result.providerRuntime !== 'GEMINI_AGENT') throw new Error('GEMINI result must use GEMINI_AGENT runtime')
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

export class Zero3AgentRuntimeOrchestrator {
  constructor(private readonly deps: Zero3AgentRuntimeDependencies) {}

  async dispatch(task: Zero3TaskSpecV2, context: Zero3AgentDispatchContext): Promise<Zero3AgentTaskRecord> {
    const availability = await this.deps.availability()
    const route = this.deps.router.resolve(task, availability)
    await this.deps.taskStore.create(task, route.target)
    let binding = bindingFor(task, context)
    await this.deps.taskStore.setBinding(task.taskId, binding)
    await this.deps.taskStore.setState(task.taskId, 'DISPATCHED')
    await this.deps.taskStore.setState(task.taskId, 'RUNNING')

    let candidate: Zero3ExecutionResultV2
    try {
      if (route.target === 'GEMINI') {
        if (!task.worktreePath?.trim()) throw new Error('Gemini writable tasks require an explicit isolated worktreePath')
        const started = await this.deps.antigravity.startTurn({
          logicalSessionId: context.targetLogicalSessionId,
          projectId: task.projectId,
          cwd: task.worktreePath,
          prompt: task.goal,
          taskId: task.taskId,
          contextVersion: task.contextVersion
        })
        const turn = await this.deps.antigravity.waitTurn(started.turnId)
        if (turn.conversationId !== binding.runtimeConversationId) {
          binding = { ...binding, runtimeConversationId: turn.conversationId, updatedAt: new Date().toISOString() }
          await this.deps.taskStore.setBinding(task.taskId, binding)
        }
        candidate = mapGeminiTurn(task, turn)
      } else {
        candidate = await this.deps.codex.dispatchTask(task)
      }

      assertResultIdentity(task, route.target, candidate)
      candidate = await this.deps.finalizeResult(task, candidate)
      assertResultIdentity(task, route.target, candidate)
    } catch (error) {
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

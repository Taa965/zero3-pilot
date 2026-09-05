import type {
  Zero3ReviewDecision,
  Zero3TaskSpecV2
} from '../agent-routing-runtime/agent-contracts'

export const ZERO3_AGENT_DESKTOP_CHANNELS = {
  taskGet: 'zero3:agent-task:get',
  dispatch: 'zero3:agent-task:dispatch',
  reviewDecision: 'zero3:agent-task:review-decision',
  recoveryInspect: 'zero3:agent-task:recovery-inspect',
  recoveryResolve: 'zero3:agent-task:recovery-resolve'
} as const

export type Zero3AgentRecoveryResolution = 'KEEP_UNKNOWN' | 'ACCEPT_PARTIAL' | 'MARK_FAILED'

export type Zero3AgentDesktopRuntime = {
  task(taskId: string): Promise<unknown>
  dispatch(task: Zero3TaskSpecV2, context: {
    targetLogicalSessionId: string
    reviewSessionId?: string | null
    runtimeConversationId?: string | null
  }): Promise<unknown>
  submitReviewDecision(taskId: string, decision: Zero3ReviewDecision, contextVersion: number): Promise<unknown>
  recoveryInspect(taskId: string): Promise<unknown>
  recoveryResolve(taskId: string, resolution: Zero3AgentRecoveryResolution, rationale: string): Promise<unknown>
}

export type Zero3AgentDesktopHandlers = {
  taskGet(request: unknown): Promise<unknown>
  dispatch(request: unknown): Promise<unknown>
  reviewDecision(request: unknown): Promise<unknown>
  recoveryInspect(request: unknown): Promise<unknown>
  recoveryResolve(request: unknown): Promise<unknown>
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function boundedString(value: unknown, label: string, max = 256): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is invalid`)
  return text
}

function optionalBoundedString(value: unknown, label: string, max = 256): string | null {
  if (value == null || value === '') return null
  return boundedString(value, label, max)
}

function safeContextVersion(value: unknown): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('contextVersion must be a positive integer')
  return number
}

function taskSpec(value: unknown): Zero3TaskSpecV2 {
  const input = record(value)
  if (input.protocol !== 'zero3.pilot.task-spec.v2') throw new Error('unsupported TaskSpec protocol')
  const task = structuredClone(input) as unknown as Zero3TaskSpecV2
  boundedString(task.taskId, 'taskId', 128)
  boundedString(task.executionId, 'executionId', 128)
  boundedString(task.projectId, 'projectId', 256)
  boundedString(task.createdBySessionId, 'createdBySessionId', 256)
  boundedString(task.title, 'title', 512)
  boundedString(task.goal, 'goal', 64_000)
  safeContextVersion(task.contextVersion)
  if (!['CODEX', 'GEMINI', 'AUTO'].includes(task.target)) throw new Error('TaskSpec target is invalid')
  if (!['DESIGN', 'IMPLEMENT', 'VERIFY', 'FIX', 'REVIEW', 'INTEGRATE', 'RESEARCH'].includes(task.type)) throw new Error('TaskSpec type is invalid')
  if (!Array.isArray(task.requirements) || !Array.isArray(task.constraints) || !Array.isArray(task.completionGate)) {
    throw new Error('TaskSpec arrays are invalid')
  }
  if (!Array.isArray(task.requiredContracts) || !Array.isArray(task.inputArtifacts) || !Array.isArray(task.expectedOutputs) || !Array.isArray(task.verification)) {
    throw new Error('TaskSpec contract/artifact/output/verification arrays are invalid')
  }
  if (!task.reviewPolicy || typeof task.reviewPolicy !== 'object') throw new Error('TaskSpec reviewPolicy is invalid')
  return task
}

function reviewDecision(value: unknown): Zero3ReviewDecision {
  const input = record(value)
  if (input.protocol !== 'zero3.pilot.review-decision.v1') throw new Error('unsupported ReviewDecision protocol')
  const decision = structuredClone(input) as unknown as Zero3ReviewDecision
  boundedString(decision.reviewId, 'reviewId', 256)
  boundedString(decision.taskId, 'taskId', 128)
  boundedString(decision.reviewerSessionId, 'reviewerSessionId', 256)
  if (!Number.isSafeInteger(decision.cycle) || decision.cycle < 1 || decision.cycle > 20) throw new Error('ReviewDecision cycle is invalid')
  if (!['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED', 'ESCALATE_HUMAN'].includes(decision.decision)) throw new Error('ReviewDecision decision is invalid')
  if (!Array.isArray(decision.findings) || !Array.isArray(decision.requiredFixes) || !Array.isArray(decision.optionalSuggestions)) {
    throw new Error('ReviewDecision arrays are invalid')
  }
  return decision
}

function recoveryResolution(value: unknown): Zero3AgentRecoveryResolution {
  if (value === 'KEEP_UNKNOWN' || value === 'ACCEPT_PARTIAL' || value === 'MARK_FAILED') return value
  throw new Error('recovery resolution is invalid')
}

export function createZero3AgentDesktopHandlers(runtime: Zero3AgentDesktopRuntime): Zero3AgentDesktopHandlers {
  return {
    async taskGet(request) {
      const input = record(request)
      return runtime.task(boundedString(input.taskId, 'taskId', 128))
    },

    async dispatch(request) {
      const input = record(request)
      const task = taskSpec(input.task)
      const context = record(input.context)
      return runtime.dispatch(task, {
        targetLogicalSessionId: boundedString(context.targetLogicalSessionId, 'targetLogicalSessionId', 256),
        reviewSessionId: optionalBoundedString(context.reviewSessionId, 'reviewSessionId', 256),
        runtimeConversationId: optionalBoundedString(context.runtimeConversationId, 'runtimeConversationId', 512)
      })
    },

    async reviewDecision(request) {
      const input = record(request)
      const decision = reviewDecision(input.decision)
      const taskId = boundedString(input.taskId, 'taskId', 128)
      if (decision.taskId !== taskId) throw new Error('ReviewDecision task identity mismatch')
      return runtime.submitReviewDecision(taskId, decision, safeContextVersion(input.contextVersion))
    },

    async recoveryInspect(request) {
      const input = record(request)
      return runtime.recoveryInspect(boundedString(input.taskId, 'taskId', 128))
    },

    async recoveryResolve(request) {
      const input = record(request)
      return runtime.recoveryResolve(
        boundedString(input.taskId, 'taskId', 128),
        recoveryResolution(input.resolution),
        boundedString(input.rationale, 'rationale', 8_000)
      )
    }
  }
}

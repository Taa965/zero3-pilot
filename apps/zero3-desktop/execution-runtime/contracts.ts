export const ZERO3_EXECUTION_TASK = 'zero3.pilot.execution-task.v1' as const
export const ZERO3_EXECUTION_STEP = 'zero3.pilot.execution-step.v1' as const
export const ZERO3_EXECUTION_ASSIGNMENT = 'zero3.pilot.execution-assignment.v1' as const
export const ZERO3_EXECUTION_SESSION_BINDING = 'zero3.pilot.execution-session-binding.v1' as const
export const ZERO3_EXECUTION_EVENT = 'zero3.pilot.execution-event.v1' as const

export type ExecutionExecutorTarget =
  | 'GPT_WEB'
  | 'GEMINI_WEB'
  | 'CODEX'
  | 'CLAUDE'
  | 'ANTIGRAVITY'
  | 'ZERO3'
  | 'REMOTE_COMPUTE'
  | 'HUMAN'
  | 'AUTO'

export type ExecutionTaskStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'waiting_human'
  | 'blocked'
  | 'outcome_unknown'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type ExecutionStepStatus =
  | 'pending'
  | 'waiting_dependency'
  | 'ready'
  | 'dispatching'
  | 'running'
  | 'waiting_report'
  | 'verifying'
  | 'fix_required'
  | 'waiting_human'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'outcome_unknown'

export interface ExecutionArtifactInput {
  artifactId?: string
  logicalName: string
  kind?: string
  required: boolean
}

export interface ExecutionExpectedOutput {
  logicalName: string
  kind?: string
  mimeType?: string
  required: boolean
  minCount?: number
  maxCount?: number
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionTaskDefinition {
  contract: typeof ZERO3_EXECUTION_TASK
  taskId: string
  projectId: string | null
  workspace?: string | null
  title: string
  goal: string
  workflowId: string | null
  maxParallelSteps: number
  createdBySessionId: string | null
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
}

export interface ExecutionTaskRuntime {
  taskId: string
  status: ExecutionTaskStatus
  progress: number
  activeStepIds: readonly string[]
  blockers: readonly string[]
  lastEventSequence: number
  updatedAt: string
}

export interface ExecutionStepDefinition {
  contract: typeof ZERO3_EXECUTION_STEP
  taskId: string
  stepId: string
  title: string
  objective: string
  executor: ExecutionExecutorTarget
  dependsOn: readonly string[]
  requiredSkills?: readonly string[]
  optionalSkills?: readonly string[]
  inputArtifacts: readonly ExecutionArtifactInput[]
  expectedOutputs: readonly ExecutionExpectedOutput[]
  completionGate: readonly string[]
  maxAttempts: number
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
}

export type ExecutionSkillAdapterMode = 'native' | 'instruction-adapter' | 'web-mcp' | 'unsupported'
export type ExecutionSkillPreflightState = 'not_required' | 'ready' | 'blocked'

export interface ExecutionSkillPreflight {
  state: ExecutionSkillPreflightState
  executor: Exclude<ExecutionExecutorTarget, 'AUTO'> | null
  adapterMode: ExecutionSkillAdapterMode
  requiredSkills: readonly string[]
  optionalSkills: readonly string[]
  availableRequiredSkills: readonly string[]
  availableOptionalSkills: readonly string[]
  missingRequiredSkills: readonly string[]
  missingOptionalSkills: readonly string[]
  checkedAt: string
}

export interface ExecutionStepRuntime {
  taskId: string
  stepId: string
  status: ExecutionStepStatus
  skillPreflight?: ExecutionSkillPreflight | null
  attempt: number
  assignmentId: string | null
  progress: number
  currentActivity: string | null
  blocker: string | null
  lastEventSequence: number
  updatedAt: string
}

export interface ExecutionAssignment {
  contract: typeof ZERO3_EXECUTION_ASSIGNMENT
  assignmentId: string
  taskId: string
  stepId: string
  attempt: number
  executor: Exclude<ExecutionExecutorTarget, 'AUTO'>
  executorId: string | null
  createdAt: string
}

export type ExecutionSessionBindingState = 'created' | 'active' | 'suspended' | 'closed' | 'lost'

export interface ExecutionSessionBinding {
  contract: typeof ZERO3_EXECUTION_SESSION_BINDING
  bindingId: string
  taskId: string
  stepId: string
  assignmentId: string
  executor: Exclude<ExecutionExecutorTarget, 'AUTO'>
  logicalSessionId: string
  runtimeConversationId: string | null
  conversationUrl: string | null
  state: ExecutionSessionBindingState
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export type ExecutionEventType =
  | 'task.created'
  | 'task.state_changed'
  | 'step.added'
  | 'step.state_changed'
  | 'assignment.created'
  | 'skill.preflight'
  | 'session.bound'
  | 'session.state_changed'
  | 'progress.updated'
  | 'artifact.produced'
  | 'completion.requested'
  | 'gate.passed'
  | 'gate.failed'
  | 'blocked'
  | 'waiting_human'
  | 'outcome_unknown'
  | 'task.completed'

export interface ExecutionEvent {
  contract: typeof ZERO3_EXECUTION_EVENT
  eventId: string
  sequence: number
  taskId: string
  stepId?: string
  assignmentId?: string
  type: ExecutionEventType
  payload?: Readonly<Record<string, unknown>>
  at: string
}

export interface ExecutionWorkflowDefinition {
  revision: number
  task: ExecutionTaskDefinition
  steps: readonly ExecutionStepDefinition[]
}

export interface ExecutionRuntimeState {
  task: ExecutionTaskRuntime
  steps: readonly ExecutionStepRuntime[]
  assignments: readonly ExecutionAssignment[]
  sessionBindings: readonly ExecutionSessionBinding[]
}

export interface ExecutionTaskSnapshot {
  definition: ExecutionWorkflowDefinition
  runtime: ExecutionRuntimeState
  events: readonly ExecutionEvent[]
}

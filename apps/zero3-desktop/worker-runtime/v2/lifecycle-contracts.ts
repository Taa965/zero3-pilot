export const ZERO3_AGENT_LIFECYCLE_PROTOCOL = 'zero3.pilot.agent-lifecycle.v1' as const

export type LifecycleAgentType = 'web_gpt' | 'codex' | 'claude' | 'hermes' | 'zero3' | 'antigravity' | 'other'
export type LifecycleSessionState = 'ACTIVE' | 'WAITING' | 'STALLED' | 'INTERRUPTED' | 'CLOSED'
export type LifecycleClaimMode = 'exclusive' | 'shared'
export type LifecycleClaimState = 'ACTIVE' | 'RELEASED' | 'INTERRUPTED'
export type LifecycleCompletionState = 'COMPLETION_REQUESTED' | 'COMPLETED_WITH_WARNINGS'
export type LifecycleEventType = 'decision' | 'progress' | 'warning' | 'error' | 'discovery' | 'user_instruction' | 'dependency'
export type LifecycleImportance = 'low' | 'normal' | 'high' | 'critical'

export type AutonomousDisposition = 'IGNORE' | 'OBSERVE' | 'DEFER' | 'PARALLEL' | 'INTERRUPT'
export type AutonomousSeverity = 'low' | 'normal' | 'high' | 'blocking'
export type AutonomousMainlineImpact = 'none' | 'defer' | 'parallel' | 'interrupt'
export type AutonomousAttentionCost = 'low' | 'medium' | 'high'
export type AutonomousParentResumeState = 'PENDING' | 'RESUMED' | 'WAITING_HUMAN'

export type AutonomousParentResumeReceipt = {
  childTaskId: string
  parentTaskId: string
  parentStepId: string | null
  state: AutonomousParentResumeState
  reason: string | null
  createdAt: string
  updatedAt: string
}

export type AgentLifecycleSession = {
  sessionId: string
  agentId: string
  agentType: LifecycleAgentType
  projectId: string
  taskId: string
  stepId: string | null
  assignmentId: string | null
  bindingId: string | null
  state: LifecycleSessionState
  startedAt: string
  lastActivityAt: string
}

export type AgentLifecycleClaim = {
  claimId: string
  taskId: string
  sessionId: string
  agentId: string
  mode: LifecycleClaimMode
  state: LifecycleClaimState
  stepId: string | null
  assignmentId: string | null
  bindingId: string | null
  startedAt: string
  lastActivityAt: string
}

export type LifecycleWorklogEntry = {
  worklogId: string
  sessionId: string
  agentId: string
  agentType: LifecycleAgentType
  projectId: string
  taskId: string
  eventType: string
  importance: LifecycleImportance
  content: Record<string, unknown>
  createdAt: string
}

export type ContextChange = {
  version: number
  type: string
  refId: string | null
  summary: string
  at: string
}

export type LifecycleTaskContext = {
  task: unknown
  projectMemory: unknown[]
  policies: unknown[]
  decisions: unknown[]
  upstreamResults: unknown[]
  artifacts: unknown[]
  worklog: LifecycleWorklogEntry[]
  warnings: unknown[]
  nextActions: unknown[]
  contextVersion: number
}

export type LifecycleMemoryCommitInput = {
  summary?: string
  projectMemory?: Array<string | Record<string, unknown>>
  decisions?: Array<string | Record<string, unknown>>
  discoveries?: Array<string | Record<string, unknown>>
  warnings?: Array<string | Record<string, unknown>>
  recommendedNextActions?: Array<string | Record<string, unknown>>
}

export type AutonomousTaskIntakeRecord = {
  sourceKey: string
  projectId: string
  entityType: string
  entityId: string
  sourceTaskId: string | null
  sourceVersion: number
  fingerprint: string
  taskId: string | null
  detail: Record<string, unknown>
  category?: string | null
  severity?: AutonomousSeverity | null
  confidence?: number | null
  affectedResources?: readonly string[]
  mainlineImpact?: AutonomousMainlineImpact | null
  disposition?: AutonomousDisposition | null
  decisionReason?: string | null
  rootTaskId?: string | null
  parentTaskId?: string | null
  attentionCost?: AutonomousAttentionCost | null
  sourceRefs?: readonly string[]
  resolvedAt?: string | null
  humanAttentionReason?: string | null
  firstSeenAt: string
  lastSeenAt: string
}

export type AutonomousTaskDispatchRecord = {
  dispatchKey: string
  projectId: string
  taskId: string
  stepId: string
  attempt: number
  state: 'RESERVED' | 'SESSION_CREATED' | 'CLAIMED' | 'WAKEUP_SENT' | 'ABORTED'
  sessionId: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

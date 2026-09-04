export const ZERO3_TASK_SPEC_V2 = 'zero3.pilot.task-spec.v2' as const
export const ZERO3_EXECUTION_RESULT_V2 = 'zero3.pilot.execution-result.v2' as const
export const ZERO3_REVIEW_PACKET_V1 = 'zero3.pilot.review-packet.v1' as const
export const ZERO3_REVIEW_DECISION_V1 = 'zero3.pilot.review-decision.v1' as const

export type Zero3AgentTarget = 'CODEX' | 'GEMINI' | 'AUTO'
export type Zero3TaskType = 'DESIGN' | 'IMPLEMENT' | 'VERIFY' | 'FIX' | 'REVIEW' | 'INTEGRATE' | 'RESEARCH'
export type Zero3ReviewDecisionKind = 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED' | 'ESCALATE_HUMAN'
export type Zero3ReviewState = 'DRAFT' | 'DISPATCHED' | 'RUNNING' | 'RESULT_READY' | 'REVIEW_PENDING' | 'REVIEWING' | 'FIX_DISPATCHED' | 'COMPLETE' | 'BLOCKED' | 'ESCALATE_HUMAN'
export type Zero3VerificationState = 'PASSED' | 'FAILED' | 'NOT_RUN' | 'BLOCKED'

export type Zero3ArtifactRef = {
  artifactId: string
  kind: string
  pathOrUri: string
  hash: string
  sourceProvider: 'CODEX' | 'GEMINI'
  sourceCycle: number
  createdAt: string
}

export type Zero3VerificationResult = {
  id: string
  state: Zero3VerificationState
  command?: string | null
  evidence?: string | null
  reason?: string | null
}

export type Zero3TaskSpecV2 = {
  protocol: typeof ZERO3_TASK_SPEC_V2
  taskId: string
  executionId: string
  projectId: string
  target: Zero3AgentTarget
  type: Zero3TaskType
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
  inputArtifacts: Zero3ArtifactRef[]
  expectedOutputs: Array<Record<string, unknown>>
  verification: Array<Record<string, unknown>>
  completionGate: string[]
  reviewPolicy: {
    required: boolean
    reviewer: 'GPT_WEB' | 'HUMAN' | 'CODEX'
    maxCycles?: number | null
  }
  createdBySessionId: string
  createdAt: string
}

export type Zero3ExecutionResultV2 = {
  protocol: typeof ZERO3_EXECUTION_RESULT_V2
  taskId: string
  executionId: string
  projectId: string
  provider: 'CODEX' | 'GEMINI'
  providerRuntime: 'CODEX_LOCAL' | 'GEMINI_AGENT'
  status: 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  contextVersion: number
  conversationId?: string | null
  summary: string
  changedFiles: string[]
  artifacts: Zero3ArtifactRef[]
  git?: {
    baseSha?: string | null
    headSha?: string | null
    commitSha?: string | null
    branch?: string | null
  } | null
  verification: Zero3VerificationResult[]
  knownIssues: string[]
  blockers: string[]
  recommendedAction: 'GPT_REVIEW' | 'HUMAN_REVIEW' | 'CODEX_IMPLEMENT' | 'RETRY'
  completedAt: string
}

export type Zero3ReviewPacket = {
  protocol: typeof ZERO3_REVIEW_PACKET_V1
  reviewId: string
  taskId: string
  executionId: string
  cycle: number
  originalGoal: string
  requirements: string[]
  constraints: string[]
  provider: 'CODEX' | 'GEMINI'
  resultSummary: string
  baseSha?: string | null
  headSha?: string | null
  diffSummary?: Record<string, unknown> | null
  changedFiles: string[]
  artifacts: Zero3ArtifactRef[]
  verification: Zero3VerificationResult[]
  knownIssues: string[]
  blockers: string[]
  createdAt: string
}

export type Zero3ReviewDecision = {
  protocol: typeof ZERO3_REVIEW_DECISION_V1
  reviewId: string
  taskId: string
  cycle: number
  decision: Zero3ReviewDecisionKind
  findings: Array<Record<string, unknown>>
  requiredFixes: string[]
  optionalSuggestions: string[]
  reviewerSessionId: string
  createdAt: string
}

export type Zero3FixRequest = {
  taskId: string
  reviewId: string
  cycle: number
  target: 'GEMINI' | 'CODEX'
  logicalSessionId: string
  runtimeConversationId?: string | null
  requiredFixes: string[]
  contextVersion: number
  createdAt: string
}

export type Zero3CrossAgentBinding = {
  projectId: string
  taskId: string
  originSessionId: string
  targetLogicalSessionId: string
  reviewSessionId?: string | null
  runtimeConversationId?: string | null
  createdAt: string
  updatedAt: string
}

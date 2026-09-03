export const ZERO3_DEVELOPMENT_GROUP_CONTRACT = 'zero3.pilot.development-group.v1' as const
export const ZERO3_DEVELOPMENT_SESSION_CONTRACT = 'zero3.pilot.development-session.v1' as const
export const ZERO3_DEVELOPMENT_DELIVERY_CONTRACT = 'zero3.pilot.development-delivery.v1' as const
export const ZERO3_GROUP_COMPLETION_PROOF = 'zero3.pilot.group-completion-proof.v1' as const
export const ZERO3_DEVELOPMENT_PROTOCOL = 'zero3.pilot.development-protocol.v1' as const

export type GroupId = string
export type SessionId = string
export type RequirementId = string
export type WaveId = string
export type IntegrationRunId = string
export type VerificationRunId = string
export type RepairTaskId = string

export type DevelopmentGroupStatus =
  | 'draft'
  | 'planning'
  | 'plan_review'
  | 'ready'
  | 'running'
  | 'integrating'
  | 'verifying'
  | 'repairing'
  | 'paused'
  | 'blocked'
  | 'waiting_approval'
  | 'waiting_human'
  | 'outcome_unknown'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type DevelopmentSessionStatus =
  | 'planned'
  | 'waiting_dependencies'
  | 'ready'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'delivering'
  | 'delivered'
  | 'integrating'
  | 'integrated'
  | 'verified'
  | 'paused'
  | 'blocked'
  | 'outcome_unknown'
  | 'failed'
  | 'cancelled'
  | 'superseded'

export type RequirementCoverageState =
  | 'planned'
  | 'assigned'
  | 'implemented'
  | 'tested'
  | 'integrated'
  | 'verified'
  | 'blocked'
  | 'waived'

export type DevelopmentFailureKind =
  | 'environment'
  | 'implementation'
  | 'integration_seam'
  | 'contract_mismatch'
  | 'dependency'
  | 'test_only'
  | 'permission'
  | 'outcome_unknown'
  | 'unknown'

export interface DevelopmentGroupPolicy {
  maxParallelSessions: number
  maxSessionAttempts: number
  maxRepairSessions: number
  maxRepairWaves: number
  maxSameFailureAttempts: number
  maxSessionSubagents: number
  permissionProfile: 'read_only' | 'standard' | 'elevated' | 'full_control'
  completionMode: 'strict' | 'allow_explicit_waiver'
  verificationPolicyRevision: string
  targetBranch: string
  protectedPaths: readonly string[]
  mandatoryTests: readonly string[]
}

export interface DevelopmentGroupDefinition {
  contract: typeof ZERO3_DEVELOPMENT_GROUP_CONTRACT
  groupId: GroupId
  repository: string
  masterGoal: string
  masterPrompt: string
  developmentPlan: string
  planHash: string
  baselineSha: string
  integrationRef: string
  requirementIds: readonly RequirementId[]
  waveIds: readonly WaveId[]
  sessionIds: readonly SessionId[]
  policy: DevelopmentGroupPolicy
  createdAt: string
}

export interface DevelopmentGroupRuntimeState {
  groupId: GroupId
  status: DevelopmentGroupStatus
  activeWaveId?: WaveId
  integrationSha?: string
  lastEventSequence: number
  unresolvedBlockers: readonly string[]
  outcomeUnknownCount: number
  repairWaveCount: number
  updatedAt: string
}

export interface DevelopmentRequirement {
  groupId: GroupId
  requirementId: RequirementId
  title: string
  description: string
  mandatory: boolean
  acceptanceCriteria: readonly string[]
  sourceAnchor: string
  proposedOwner?: SessionId
  dependencies: readonly RequirementId[]
}

export interface RequirementWaiver {
  approvedBy: string
  approvedAt: string
  reason: string
  evidence: readonly string[]
}

export interface RequirementCoverage {
  requirementId: RequirementId
  state: RequirementCoverageState
  sessionId?: SessionId
  deliveryHash?: string
  commitSha?: string
  testEvidenceIds: readonly string[]
  integrationRunId?: IntegrationRunId
  verificationRunId?: VerificationRunId
  waiver?: RequirementWaiver
}

export interface DevelopmentWave {
  groupId: GroupId
  waveId: WaveId
  ordinal: number
  sessionIds: readonly SessionId[]
  requiredSessionIds: readonly SessionId[]
  dependsOnWaveIds: readonly WaveId[]
}

export interface DevelopmentExecutorPolicy {
  executorId: string
  permissionProfile: DevelopmentGroupPolicy['permissionProfile']
  approvalRequired: boolean
}

export interface DevelopmentSubagentPolicy {
  allowed: boolean
  maxConcurrency: number
  recursiveGroupCreation: false
}

export interface DevelopmentDeliveryPolicy {
  requireCleanHead: boolean
  requireOwnershipValidation: boolean
  requireHandoff: boolean
  requireDeliveryHash: boolean
}

export interface DevelopmentSessionDefinition {
  contract: typeof ZERO3_DEVELOPMENT_SESSION_CONTRACT
  groupId: GroupId
  sessionId: SessionId
  executionId: string
  waveId: WaveId
  objective: string
  baselineSha: string
  integrationRef: string
  branch: string
  worktree: string
  ownedPaths: readonly string[]
  readOnlyPaths: readonly string[]
  forbiddenPaths: readonly string[]
  dependencies: readonly SessionId[]
  requirements: readonly RequirementId[]
  inputs: readonly string[]
  acceptanceCriteria: readonly string[]
  executorPolicy: DevelopmentExecutorPolicy
  subagentPolicy: DevelopmentSubagentPolicy
  deliveryPolicy: DevelopmentDeliveryPolicy
}

export interface DevelopmentSessionRuntime {
  groupId: GroupId
  sessionId: SessionId
  executionId: string
  status: DevelopmentSessionStatus
  attempt: number
  writerGeneration: number
  executorId?: string
  executorSessionId?: string
  executorGeneration?: number
  headSha?: string
  lastEventSequence: number
  blocker?: string
  updatedAt: string
}

export type DevelopmentDeliveryStatus = 'completed' | 'blocked' | 'failed' | 'cancelled' | 'outcome_unknown'

export interface DevelopmentDelivery {
  contract: typeof ZERO3_DEVELOPMENT_DELIVERY_CONTRACT
  groupId: GroupId
  sessionId: SessionId
  executionId: string
  status: DevelopmentDeliveryStatus
  baseSha: string
  headSha: string
  changedPaths: readonly string[]
  requirements: readonly RequirementId[]
  testsAdded: readonly string[]
  testsExecuted: readonly string[]
  artifacts: readonly string[]
  knownIssues: readonly string[]
  downstreamNotes: readonly string[]
  handoffCheckpoint?: string
  deliveryHash: string
  createdAt: string
}

export interface IntegrationMilestone {
  integrationRunId: IntegrationRunId
  groupId: GroupId
  baseSha: string
  headSha: string
  deliveryHashes: readonly string[]
  mergedSessionIds: readonly SessionId[]
  status: 'pending' | 'merged' | 'conflict' | 'failed'
  conflicts: readonly string[]
  createdAt: string
}

export interface VerificationCommand {
  id: string
  command: string
  cwd?: string
  platform: 'any' | 'windows' | 'linux' | 'macos'
  required: boolean
}

export interface VerificationResult {
  commandId: string
  status: 'passed' | 'failed' | 'not_run' | 'not_run_platform'
  exitCode?: number
  evidence: readonly string[]
}

export interface VerificationRun {
  verificationRunId: VerificationRunId
  groupId: GroupId
  integrationSha: string
  policyRevision: string
  commands: readonly VerificationCommand[]
  results: readonly VerificationResult[]
  environment: Readonly<Record<string, string>>
  startedAt: string
  finishedAt?: string
  status: 'pending' | 'running' | 'passed' | 'failed' | 'outcome_unknown'
}

export interface FailureRecord {
  failureId: string
  groupId: GroupId
  verificationRunId?: VerificationRunId
  sessionId?: SessionId
  kind: DevelopmentFailureKind
  message: string
  evidence: readonly string[]
  ownerSessionIds: readonly SessionId[]
  attempts: number
  unresolved: boolean
}

export interface RepairTask {
  repairTaskId: RepairTaskId
  groupId: GroupId
  waveOrdinal: number
  failureIds: readonly string[]
  ownerSessionIds: readonly SessionId[]
  objective: string
  status: 'planned' | 'running' | 'delivered' | 'verified' | 'waiting_human' | 'failed'
}

export interface SessionDeliveryCoverage {
  sessionId: SessionId
  deliveryHash: string
  valid: boolean
}

export interface GroupCompletionProof {
  contract: typeof ZERO3_GROUP_COMPLETION_PROOF
  groupId: GroupId
  requirementCoverage: readonly RequirementCoverage[]
  sessionDeliveryCoverage: readonly SessionDeliveryCoverage[]
  integrationStatus: 'clean' | 'conflict' | 'failed'
  verificationStatus: 'passed' | 'failed' | 'not_run'
  unresolvedBlockers: readonly string[]
  outcomeUnknownCount: number
  finalIntegrationSha: string
  verificationEvidence: readonly VerificationRunId[]
  completionPolicyRevision: string
  generatedAt: string
}

export type GroupEventType =
  | 'group.created'
  | 'plan.frozen'
  | 'wave.started'
  | 'session.created'
  | 'session.started'
  | 'session.blocked'
  | 'session.delivered'
  | 'delivery.rejected'
  | 'integration.started'
  | 'integration.merged'
  | 'verification.started'
  | 'verification.failed'
  | 'repair.created'
  | 'group.completed'

export interface GroupEvent {
  eventId: string
  sequence: number
  at: string
  groupId: GroupId
  type: GroupEventType
  sessionId?: SessionId
  waveId?: WaveId
  payloadHash?: string
  detail?: string
}

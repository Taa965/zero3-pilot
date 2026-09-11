export const ZERO3_WORKFLOW_MODULE = 'zero3.pilot.workflow-module.v1' as const
export const ZERO3_WORKFLOW_RUN = 'zero3.pilot.workflow-run.v1' as const
export const ZERO3_WORKFLOW_ARTIFACT = 'zero3.pilot.workflow-artifact.v1' as const

export type WorkflowExecutorTarget =
  | 'GPT_WEB'
  | 'GEMINI_WEB'
  | 'CODEX'
  | 'CLAUDE'
  | 'ANTIGRAVITY'
  | 'ZERO3'
  | 'REMOTE_COMPUTE'
  | 'HUMAN'

export type WorkflowRunStatus = 'READY' | 'RUNNING' | 'WAITING_HUMAN' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type WorkflowItemStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type WorkflowStageStatus =
  | 'WAITING_DEPENDENCY'
  | 'READY'
  | 'CLAIMED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'FIX_REQUIRED'
  | 'WAITING_HUMAN'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export type WorkflowArtifactState = 'PENDING' | 'AVAILABLE' | 'VERIFIED' | 'MISSING' | 'INVALID'
export type WorkflowArtifactStorageProvider = 'GOOGLE_DRIVE' | 'LOCAL' | 'REMOTE_COMPUTE' | 'URL'

export type WorkflowExternalJobState =
  | 'PENDING'
  | 'SUBMITTED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'OUTCOME_UNKNOWN'


export interface WorkflowArtifactLocator {
  provider: WorkflowArtifactStorageProvider
  fileId?: string
  path?: string
  uri?: string
  webUrl?: string
  parentFolderId?: string
}

export interface WorkflowExpectedArtifact {
  logicalName: string
  kind: string
  mimeType?: string
  required: boolean
  minCount?: number
  maxCount?: number
}

export interface WorkflowModuleManifest {
  contract: typeof ZERO3_WORKFLOW_MODULE
  id: string
  version: string
  name: string
  description: string
  uiKind: string
  requiredExecutors: readonly WorkflowExecutorTarget[]
  requiredSkills: readonly string[]
  requiredPlugins: readonly string[]
  requiredArtifactProviders: readonly WorkflowArtifactStorageProvider[]
}

export interface WorkflowWorkerDefinition {
  workerDefinitionId: string
  name: string
  executor: WorkflowExecutorTarget
  concurrency: number
  capability: string
  promptRevision: string
  skillId?: string
  maxItemsPerPhysicalSession?: number | null
  rotateOnContextRisk?: boolean
  rotateOnStall?: boolean
  metadata?: Readonly<Record<string, unknown>>
}

export interface WorkflowStageDefinition {
  stageId: string
  title: string
  executor: WorkflowExecutorTarget
  workerDefinitionId?: string | null
  dependsOn: readonly string[]
  expectedOutputs: readonly WorkflowExpectedArtifact[]
  completionGate: readonly string[]
  maxAttempts: number
  metadata?: Readonly<Record<string, unknown>>
}

export interface WorkflowItemSeed {
  itemId: string
  title: string
  metadata?: Readonly<Record<string, unknown>>
  initialArtifacts?: readonly WorkflowArtifactSeed[]
  completedStageIds?: readonly string[]
}

export interface WorkflowArtifactSeed {
  artifactId?: string
  stageId: string
  logicalName: string
  kind: string
  mimeType?: string
  storage: WorkflowArtifactLocator
  sha256?: string
  sizeBytes?: number
  state?: WorkflowArtifactState
  metadata?: Readonly<Record<string, unknown>>
}

export interface WorkflowArtifactRelocation {
  storage: WorkflowArtifactLocator
  sha256?: string | null
  sizeBytes?: number | null
  state?: WorkflowArtifactState
  metadataPatch?: Readonly<Record<string, unknown>>
}

export interface WorkflowRunPlan {
  contract: typeof ZERO3_WORKFLOW_RUN
  workflowRunId: string
  moduleId: string
  moduleVersion: string
  projectId: string
  title: string
  stages: readonly WorkflowStageDefinition[]
  workers: readonly WorkflowWorkerDefinition[]
  items: readonly WorkflowItemSeed[]
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
}

export interface WorkflowRunRecord {
  workflowRunId: string
  moduleId: string
  moduleVersion: string
  projectId: string
  title: string
  status: WorkflowRunStatus
  progress: number
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export interface WorkflowItemRecord {
  workflowRunId: string
  itemId: string
  ordinal: number
  title: string
  status: WorkflowItemStatus
  progress: number
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export interface WorkflowStageRunRecord {
  stageRunId: string
  workflowRunId: string
  itemId: string
  stageId: string
  title: string
  executor: WorkflowExecutorTarget
  workerDefinitionId: string | null
  status: WorkflowStageStatus
  progress: number
  currentActivity: string | null
  claimOwnerId: string | null
  attempt: number
  maxAttempts: number
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export interface WorkflowArtifactRecord {
  contract: typeof ZERO3_WORKFLOW_ARTIFACT
  artifactId: string
  workflowRunId: string
  itemId: string
  stageRunId: string
  stageId: string
  logicalName: string
  kind: string
  mimeType: string | null
  storage: WorkflowArtifactLocator
  sha256: string | null
  sizeBytes: number | null
  state: WorkflowArtifactState
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
}

export interface WorkflowExternalJobRecord {
  jobId: string
  workflowRunId: string
  itemId: string
  stageRunId: string
  provider: string
  requestKey: string
  externalId: string | null
  state: WorkflowExternalJobState
  metadata: Readonly<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export interface WorkflowEventRecord {
  sequence: number
  eventId: string
  workflowRunId: string
  itemId: string | null
  stageRunId: string | null
  type: string
  payload: Readonly<Record<string, unknown>>
  at: string
}

export interface WorkflowRunSnapshot {
  plan: WorkflowRunPlan
  run: WorkflowRunRecord
  items: readonly WorkflowItemRecord[]
  stages: readonly WorkflowStageRunRecord[]
  artifacts: readonly WorkflowArtifactRecord[]
  externalJobs: readonly WorkflowExternalJobRecord[]
  events: readonly WorkflowEventRecord[]
}

export interface WorkflowValidationResult {
  valid: boolean
  errors: readonly string[]
  warnings: readonly string[]
}

export interface WorkflowModule {
  manifest: WorkflowModuleManifest
  validateCreateInput(input: unknown): WorkflowValidationResult
  createRun(input: unknown): WorkflowRunPlan
}

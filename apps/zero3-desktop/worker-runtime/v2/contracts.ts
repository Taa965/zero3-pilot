export const ZERO3_WORKER_PROTOCOL_V2 = 'zero3.pilot.worker-protocol.v2' as const

export type WorkerProvider = 'GPT_WEB'
export type WorkerSlotState = 'IDLE' | 'ACTIVE' | 'WAITING' | 'ROTATING' | 'LOST' | 'CLOSED'
export type PhysicalWorkerSessionState = 'STARTING' | 'ACTIVE' | 'WAITING' | 'ROTATING' | 'LOST' | 'CLOSED'
export type ArtifactStorageProvider = 'GOOGLE_DRIVE' | 'LOCAL' | 'REMOTE_COMPUTE' | 'URL'
export type WorkerBlockedDisposition = 'BLOCKED_RETRYABLE' | 'WAITING_HUMAN' | 'BLOCKED_TERMINAL'

export type WorkerSessionPolicy = {
  maxItemsPerPhysicalSession: number | null
  rotateOnContextRisk: boolean
  rotateOnStall: boolean
}

export type WorkflowWorkerBinding = {
  workflowRunId: string
  moduleId: string
  moduleVersion: string
  workerDefinitionId: string
  workerSlotId: string
  provider: WorkerProvider
  requiredCapabilities: string[]
  maxBatchSize: number
  sessionPolicy: WorkerSessionPolicy
}

export type WorkerSlot = {
  workflowRunId: string
  workerDefinitionId: string
  workerSlotId: string
  provider: WorkerProvider
  generation: number
  state: WorkerSlotState
  activeWorkerSessionId?: string
}

export type PhysicalWorkerSession = {
  workerSlotId: string
  workerSessionId: string
  logicalSessionId: string
  conversationId?: string
  conversationUrl?: string
  generation: number
  state: PhysicalWorkerSessionState
  processedItemCount: number
  startedAt: string
}

export type ArtifactStorage = {
  provider: ArtifactStorageProvider
  fileId?: string
  path?: string
  uri?: string
  webUrl?: string
}

export type WorkflowArtifactRef = {
  artifactId: string
  workflowRunId: string
  workItemId: string
  stageRunId: string
  logicalName: string
  kind: string
  mimeType?: string
  storage: ArtifactStorage
  sha256?: string
  sizeBytes?: number
  producer: {
    workerDefinitionId: string
    workerSlotId: string
    workerSessionId: string
  }
}

export type ExpectedArtifact = {
  logicalName: string
  kind?: string
  mimeType?: string
  required: boolean
}

export type WorkflowWorkUnit = {
  workItemId: string
  stageRunId: string
  title: string
  instruction: string
  skill?: {
    id: string
    revision?: string
  }
  inputs: WorkflowArtifactRef[]
  expectedOutputs: ExpectedArtifact[]
  policy: {
    maxAttempts: number
    leaseSeconds: number
  }
  metadata: Record<string, unknown>
}

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
const SHA256_RE = /^[a-f0-9]{64}$/i
const SESSION_STATES = new Set<PhysicalWorkerSessionState>(['STARTING', 'ACTIVE', 'WAITING', 'ROTATING', 'LOST', 'CLOSED'])
const SLOT_STATES = new Set<WorkerSlotState>(['IDLE', 'ACTIVE', 'WAITING', 'ROTATING', 'LOST', 'CLOSED'])
const STORAGE_PROVIDERS = new Set<ArtifactStorageProvider>(['GOOGLE_DRIVE', 'LOCAL', 'REMOTE_COMPUTE', 'URL'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function text(value: unknown, label: string, max = 4096): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
  return value
}

function optionalText(value: unknown, label: string, max = 4096): string | undefined {
  if (value == null || value === '') return undefined
  return text(value, label, max)
}

function isoTimestamp(value: unknown, label: string): string {
  const raw = text(value, label, 128)
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an ISO timestamp`)
  return parsed.toISOString()
}

function uniqueIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error(`${label} must contain 1..64 items`)
  const values = value.map((entry, index) => id(entry, `${label}[${index}]`))
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`)
  return values
}

export function normalizeWorkflowWorkerBinding(value: unknown): WorkflowWorkerBinding {
  const input = record(value, 'WorkflowWorkerBinding')
  const provider = input.provider
  if (provider !== 'GPT_WEB') throw new Error('provider must be GPT_WEB')
  const policy = record(input.sessionPolicy, 'sessionPolicy')
  const maxItems = policy.maxItemsPerPhysicalSession == null
    ? null
    : integer(policy.maxItemsPerPhysicalSession, 'maxItemsPerPhysicalSession', 1, 100_000)
  if (typeof policy.rotateOnContextRisk !== 'boolean' || typeof policy.rotateOnStall !== 'boolean') {
    throw new Error('sessionPolicy rotation flags must be boolean')
  }
  return {
    workflowRunId: id(input.workflowRunId, 'workflowRunId'),
    moduleId: id(input.moduleId, 'moduleId'),
    moduleVersion: id(input.moduleVersion, 'moduleVersion'),
    workerDefinitionId: id(input.workerDefinitionId, 'workerDefinitionId'),
    workerSlotId: id(input.workerSlotId, 'workerSlotId'),
    provider,
    requiredCapabilities: uniqueIds(input.requiredCapabilities, 'requiredCapabilities'),
    maxBatchSize: integer(input.maxBatchSize, 'maxBatchSize', 1, 100),
    sessionPolicy: {
      maxItemsPerPhysicalSession: maxItems,
      rotateOnContextRisk: policy.rotateOnContextRisk,
      rotateOnStall: policy.rotateOnStall
    }
  }
}

export function normalizeWorkerSlot(value: unknown): WorkerSlot {
  const input = record(value, 'WorkerSlot')
  if (input.provider !== 'GPT_WEB') throw new Error('WorkerSlot provider must be GPT_WEB')
  if (typeof input.state !== 'string' || !SLOT_STATES.has(input.state as WorkerSlotState)) {
    throw new Error('WorkerSlot state is invalid')
  }
  return {
    workflowRunId: id(input.workflowRunId, 'workflowRunId'),
    workerDefinitionId: id(input.workerDefinitionId, 'workerDefinitionId'),
    workerSlotId: id(input.workerSlotId, 'workerSlotId'),
    provider: 'GPT_WEB',
    generation: integer(input.generation, 'generation', 1, Number.MAX_SAFE_INTEGER),
    state: input.state as WorkerSlotState,
    ...(input.activeWorkerSessionId == null ? {} : {
      activeWorkerSessionId: id(input.activeWorkerSessionId, 'activeWorkerSessionId')
    })
  }
}

export function normalizePhysicalWorkerSession(value: unknown): PhysicalWorkerSession {
  const input = record(value, 'PhysicalWorkerSession')
  if (typeof input.state !== 'string' || !SESSION_STATES.has(input.state as PhysicalWorkerSessionState)) {
    throw new Error('PhysicalWorkerSession state is invalid')
  }
  return {
    workerSlotId: id(input.workerSlotId, 'workerSlotId'),
    workerSessionId: id(input.workerSessionId, 'workerSessionId'),
    logicalSessionId: text(input.logicalSessionId, 'logicalSessionId', 512),
    ...(input.conversationId == null ? {} : { conversationId: text(input.conversationId, 'conversationId', 512) }),
    ...(input.conversationUrl == null ? {} : { conversationUrl: text(input.conversationUrl, 'conversationUrl', 4096) }),
    generation: integer(input.generation, 'generation', 1, Number.MAX_SAFE_INTEGER),
    state: input.state as PhysicalWorkerSessionState,
    processedItemCount: integer(input.processedItemCount, 'processedItemCount', 0, Number.MAX_SAFE_INTEGER),
    startedAt: isoTimestamp(input.startedAt, 'startedAt')
  }
}

function normalizeStorage(value: unknown): ArtifactStorage {
  const input = record(value, 'artifact storage')
  if (typeof input.provider !== 'string' || !STORAGE_PROVIDERS.has(input.provider as ArtifactStorageProvider)) {
    throw new Error('artifact storage provider is invalid')
  }
  const storage: ArtifactStorage = { provider: input.provider as ArtifactStorageProvider }
  if (input.fileId != null) storage.fileId = text(input.fileId, 'storage.fileId', 2048)
  if (input.path != null) storage.path = text(input.path, 'storage.path', 8192)
  if (input.uri != null) storage.uri = text(input.uri, 'storage.uri', 8192)
  if (input.webUrl != null) storage.webUrl = text(input.webUrl, 'storage.webUrl', 8192)

  if (storage.provider === 'GOOGLE_DRIVE' && !storage.fileId) throw new Error('GOOGLE_DRIVE storage requires fileId')
  if (storage.provider === 'LOCAL' && !storage.path) throw new Error('LOCAL storage requires path')
  if (storage.provider === 'REMOTE_COMPUTE' && !storage.path && !storage.uri) throw new Error('REMOTE_COMPUTE storage requires path or uri')
  if (storage.provider === 'URL' && !storage.uri && !storage.webUrl) throw new Error('URL storage requires uri or webUrl')
  return storage
}

export function normalizeWorkflowArtifactRef(value: unknown): WorkflowArtifactRef {
  const input = record(value, 'WorkflowArtifactRef')
  const producer = record(input.producer, 'artifact producer')
  const sha256 = optionalText(input.sha256, 'sha256', 64)
  if (sha256 && !SHA256_RE.test(sha256)) throw new Error('sha256 is invalid')
  return {
    artifactId: id(input.artifactId, 'artifactId'),
    workflowRunId: id(input.workflowRunId, 'workflowRunId'),
    workItemId: id(input.workItemId, 'workItemId'),
    stageRunId: id(input.stageRunId, 'stageRunId'),
    logicalName: text(input.logicalName, 'logicalName', 1024),
    kind: id(input.kind, 'kind'),
    ...(input.mimeType == null ? {} : { mimeType: text(input.mimeType, 'mimeType', 256) }),
    storage: normalizeStorage(input.storage),
    ...(sha256 ? { sha256 } : {}),
    ...(input.sizeBytes == null ? {} : { sizeBytes: integer(input.sizeBytes, 'sizeBytes', 0, Number.MAX_SAFE_INTEGER) }),
    producer: {
      workerDefinitionId: id(producer.workerDefinitionId, 'producer.workerDefinitionId'),
      workerSlotId: id(producer.workerSlotId, 'producer.workerSlotId'),
      workerSessionId: id(producer.workerSessionId, 'producer.workerSessionId')
    }
  }
}

function normalizeExpectedArtifact(value: unknown): ExpectedArtifact {
  const input = record(value, 'ExpectedArtifact')
  if (input.required != null && typeof input.required !== 'boolean') throw new Error('ExpectedArtifact.required must be boolean')
  return {
    logicalName: text(input.logicalName, 'expectedOutput.logicalName', 1024),
    ...(input.kind == null ? {} : { kind: id(input.kind, 'expectedOutput.kind') }),
    ...(input.mimeType == null ? {} : { mimeType: text(input.mimeType, 'expectedOutput.mimeType', 256) }),
    required: input.required !== false
  }
}

export function normalizeWorkflowWorkUnit(value: unknown): WorkflowWorkUnit {
  const input = record(value, 'WorkflowWorkUnit')
  const skill = input.skill == null ? null : record(input.skill, 'skill')
  const policy = record(input.policy, 'policy')
  const rawInputs = input.inputs ?? []
  const rawOutputs = input.expectedOutputs ?? []
  if (!Array.isArray(rawInputs) || rawInputs.length > 100) throw new Error('inputs must contain at most 100 artifacts')
  if (!Array.isArray(rawOutputs) || rawOutputs.length > 100) throw new Error('expectedOutputs must contain at most 100 items')
  const metadata = input.metadata == null ? {} : record(input.metadata, 'metadata')
  return {
    workItemId: id(input.workItemId, 'workItemId'),
    stageRunId: id(input.stageRunId, 'stageRunId'),
    title: text(input.title, 'title', 1024),
    instruction: text(input.instruction, 'instruction', 64_000),
    ...(skill ? {
      skill: {
        id: id(skill.id, 'skill.id'),
        ...(skill.revision == null ? {} : { revision: id(skill.revision, 'skill.revision') })
      }
    } : {}),
    inputs: rawInputs.map(normalizeWorkflowArtifactRef),
    expectedOutputs: rawOutputs.map(normalizeExpectedArtifact),
    policy: {
      maxAttempts: integer(policy.maxAttempts, 'policy.maxAttempts', 1, 100),
      leaseSeconds: integer(policy.leaseSeconds, 'policy.leaseSeconds', 1, 86_400)
    },
    metadata: { ...metadata }
  }
}

export function nextWorkerGeneration(current: number): number {
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('worker generation cannot advance')
  }
  return current + 1
}

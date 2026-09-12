export const ZERO3_REMOTE_CAPABILITY_PROTOCOL = 'zero3.remote-capability.v1' as const

export type Zero3CapabilityStatus = 'available' | 'unavailable' | 'degraded'
export type Zero3CapabilityApproval = 'none' | 'policy' | 'always'
export type Zero3OperationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'

export type JsonSchema = Record<string, unknown>

export type Zero3CapabilityDefinition = {
  protocol: typeof ZERO3_REMOTE_CAPABILITY_PROTOCOL
  id: string
  version: string
  name: string
  description: string
  category: string
  status: Zero3CapabilityStatus
  executionMode: 'local'
  supportsStreaming: boolean
  supportsCancellation: boolean
  requiresApproval: Zero3CapabilityApproval
  provider: 'zero3-local'
  nodeId: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
}

export type Zero3CapabilityContext = {
  projectId?: string
  taskId?: string
  sessionId?: string
}

export type Zero3InvokeCapabilityRequest = {
  capability: string
  input?: Record<string, unknown>
  context?: Zero3CapabilityContext
  idempotencyKey: string
}

export type Zero3OperationError = {
  code: string
  message: string
}

export type Zero3OperationRecord = {
  protocol: typeof ZERO3_REMOTE_CAPABILITY_PROTOCOL
  operationId: string
  capability: string
  nodeId: string
  status: Zero3OperationStatus
  input: Record<string, unknown>
  context?: Zero3CapabilityContext
  idempotencyKey: string
  inputFingerprint: string
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  progress: number
  result: unknown | null
  error: Zero3OperationError | null
}

export type Zero3CapabilityPolicyDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'require_confirmation'; reason: string }

export type Zero3CapabilityInvocation = {
  operationId: string
  definition: Zero3CapabilityDefinition
  input: Record<string, unknown>
  context?: Zero3CapabilityContext
  signal: AbortSignal
}

export type Zero3CapabilityHandler = (
  invocation: Zero3CapabilityInvocation
) => Promise<unknown>

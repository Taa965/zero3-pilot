export const ZERO3_EXECUTOR_CONTRACT = 'zero3.pilot.executor.v1' as const
export const ZERO3_HANDOFF_PROTOCOL = 'zero3.pilot.handoff.v1' as const

export type ExecutorId = string
export type ExecutorKind = 'native-codex' | 'external-agent' | 'api-provider'
export type ExecutorPermissionProfile = 'read_only' | 'standard' | 'elevated' | 'full_control'

export type ExecutorFailureCode =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'auth_required'
  | 'provider_overloaded'
  | 'provider_error'
  | 'context_exhausted'
  | 'budget_exhausted'
  | 'user_stopped'
  | 'permission_denied'
  | 'policy_denied'
  | 'bad_request'
  | 'unsupported'
  | 'transport_lost'
  | 'process_crash'
  | 'context_lost'
  | 'internal_error'

export type ExecutorFailoverDisposition = 'eligible' | 'conditional' | 'forbidden'
export type ExecutorPermissionDecision = 'approve_once' | 'approve_session' | 'deny'

export interface ExecutorControlIdentity {
  leaseId: string
  fencingToken: number
}

export interface ExecutorTaskIdentity {
  taskId: string
  executionId: string
  workspace: string
  repoIdentity?: string
  branch?: string
  objective: string
  constraints: readonly string[]
  acceptanceCriteria: readonly string[]
  control?: ExecutorControlIdentity
}

export interface ExecutorPolicyContext {
  permissionProfile: ExecutorPermissionProfile
  approvalRequired: boolean
}

export interface ExecutorHandoffCheckpointRef {
  protocol: typeof ZERO3_HANDOFF_PROTOCOL
  checkpointHash: string
  generation: number
  workspaceFingerprint: string
}

export interface ExecutorStartContext {
  contract: typeof ZERO3_EXECUTOR_CONTRACT
  identity: ExecutorTaskIdentity
  policy: ExecutorPolicyContext
  generation: number
  handoff?: ExecutorHandoffCheckpointRef
}

export interface ExecutorSessionRef {
  executorId: ExecutorId
  sessionId: string
  generation: number
}

export interface ExecutorSession extends ExecutorSessionRef {
  startedAt: string
}

export interface ExecutorInput {
  kind: 'prompt'
  clientRequestId: string
  text: string
}

export interface ExecutorPermissionResponse {
  requestId: string
  decision: ExecutorPermissionDecision
}

export type ExecutorProbeStatus = 'ready' | 'unavailable' | 'auth_required' | 'unsupported'

export interface ExecutorProbe {
  executorId: ExecutorId
  status: ExecutorProbeStatus
  detail?: string
}

export interface ExecutorFailure {
  code: ExecutorFailureCode
  message: string
  source: ExecutorId | 'executor-core'
}

export interface ExecutorFailurePolicy {
  retryable: boolean
  failover: ExecutorFailoverDisposition
}

export interface ExecutorUsage {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

interface ExecutorEventBase {
  sequence: number
  at: string
}

export type ExecutorEvent =
  | (ExecutorEventBase & { type: 'message'; text: string })
  | (ExecutorEventBase & { type: 'reasoning'; text: string })
  | (ExecutorEventBase & { type: 'plan'; text: string })
  | (ExecutorEventBase & { type: 'tool.started'; toolCallId: string; name: string })
  | (ExecutorEventBase & { type: 'tool.updated'; toolCallId: string; detail: string })
  | (ExecutorEventBase & { type: 'tool.completed'; toolCallId: string; success: boolean })
  | (ExecutorEventBase & { type: 'file.changed'; path: string })
  | (ExecutorEventBase & {
      type: 'permission.requested'
      requestId: string
      description: string
      allowSessionApproval?: boolean
    })
  | (ExecutorEventBase & { type: 'usage.updated'; usage: ExecutorUsage })
  | (ExecutorEventBase & { type: 'failure'; failure: ExecutorFailure })
  | (ExecutorEventBase & { type: 'completed'; outcome: 'succeeded' | 'cancelled' | 'failed' })

export interface ExecutorDescriptor {
  id: ExecutorId
  kind: ExecutorKind
  label: string
}

export interface Zero3Executor {
  readonly descriptor: ExecutorDescriptor
  probe(): Promise<ExecutorProbe>
  start(context: ExecutorStartContext): Promise<ExecutorSession>
  resume(ref: ExecutorSessionRef, checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession>
  prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent>
  respondPermission(session: ExecutorSession, response: ExecutorPermissionResponse): Promise<void>
  cancel(session: ExecutorSession): Promise<void>
  close(session: ExecutorSession): Promise<void>
}

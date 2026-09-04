export const ZERO3_REMOTE_TASK_PROTOCOL = 'zero3.pilot.remote-task.v1' as const
export const ZERO3_REMOTE_EXECUTION_RESULT_PROTOCOL = 'zero3.pilot.execution-result.v1' as const

export type Zero3RemotePermissionProfile = 'read_only' | 'standard' | 'elevated' | 'full_control'

export type Zero3RemoteTaskTarget = {
  workspace: string
  base_ref?: string
}

export type Zero3RemoteTaskExecution = {
  max_turns?: number
  timeout_seconds?: number
  require_clean_worktree?: boolean
  require_clean_worktree_on_success?: boolean
  require_remote_sync_on_success?: boolean
}

export type Zero3RemoteProjectContextRef = {
  project_id: string
  context_version?: number
  context_ref?: string
  source_entry_id?: string
  source_kind?: 'gpt_web' | 'codex'
}

export type Zero3RemoteHandoffRequest = {
  result_protocol?: typeof ZERO3_REMOTE_EXECUTION_RESULT_PROTOCOL
  return_entry_id?: string
  required_evidence?: string[]
}

export type Zero3RemoteTask = {
  protocol: typeof ZERO3_REMOTE_TASK_PROTOCOL
  task_id: string
  execution_id: string
  objective: string
  target: Zero3RemoteTaskTarget
  constraints?: string[]
  acceptance_criteria?: string[]
  permission_profile?: Zero3RemotePermissionProfile
  execution?: Zero3RemoteTaskExecution
  project_context?: Zero3RemoteProjectContextRef
  handoff?: Zero3RemoteHandoffRequest
}

export type Zero3RemoteLease = {
  lease_id: string
  fencing_token: number
  lease_expires_at?: string
  task: Zero3RemoteTask
}

export type Zero3RemoteCodexMapping = {
  taskId: string
  executionId: string
  taskFingerprint: string
  threadId: string
  turnIds: string[]
  workspace: string
  pendingTurnClientId?: string
}

export type Zero3RemoteTaskState =
  | 'leased'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'outcome_unknown'
  | 'quarantined'

export type Zero3RemoteTerminalState = Extract<
  Zero3RemoteTaskState,
  'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'outcome_unknown' | 'quarantined'
>

export type Zero3RemoteGitEvidence = {
  repository_root: string
  head_commit: string
  base_commit: string | null
  clean_worktree: boolean | null
  branch?: string | null
  upstream_commit?: string | null
  remote_synced?: boolean | null
}

export type Zero3RemoteExecutionResult = {
  protocol: typeof ZERO3_REMOTE_EXECUTION_RESULT_PROTOCOL
  task_id: string
  execution_id: string
  state: Zero3RemoteTaskState
  codex_thread_id: string
  codex_turn_id: string
  project_context?: Zero3RemoteProjectContextRef
  return_entry_id?: string
  agent_summary: string | null
  git_preflight: Zero3RemoteGitEvidence
  git_postflight?: Zero3RemoteGitEvidence
  evidence_methods: string[]
}

export type Zero3RemoteOutboxEventEnvelope = {
  schemaVersion: 1
  kind: 'event'
  deliveryId: string
  taskId: string
  executionId: string
  leaseId: string
  fencingToken: number
  createdAt: string
  eventSequence: number
  eventType: string
  payload: unknown
}

export type Zero3RemoteOutboxTerminalEnvelope = {
  schemaVersion: 1
  kind: 'terminal'
  deliveryId: string
  taskId: string
  executionId: string
  leaseId: string
  fencingToken: number
  createdAt: string
  state: Zero3RemoteTerminalState
  result: unknown
}

export type Zero3RemoteOutboxEnvelope = Zero3RemoteOutboxEventEnvelope | Zero3RemoteOutboxTerminalEnvelope

export type Zero3RemoteHostConfig = {
  enabled: boolean
  baseUrl: string | null
  tokenFile: string | null
  nodeId: string
  allowedWorkspaces: string[]
  developmentAllowHttp: boolean
  mappingStateFile: string
  outboxDir: string
}

export type Zero3RemoteHostStatus = {
  enabled: boolean
  connected: boolean
  nodeId: string
  activeTaskId: string | null
  pendingDeliveries: number
  lastError: string | null
  lastHeartbeatAt: string | null
}

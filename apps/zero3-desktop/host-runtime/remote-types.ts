export const ZERO3_REMOTE_TASK_PROTOCOL = 'zero3.pilot.remote-task.v1' as const

export type Zero3RemotePermissionProfile = 'read_only' | 'standard' | 'elevated' | 'full_control'

export type Zero3RemoteTaskTarget = {
  workspace: string
  base_ref?: string
}

export type Zero3RemoteTaskExecution = {
  max_turns?: number
  timeout_seconds?: number
  require_clean_worktree?: boolean
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
  threadId: string
  turnIds: string[]
  workspace: string
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

export type Zero3RemoteHostConfig = {
  enabled: boolean
  baseUrl: string | null
  tokenFile: string | null
  nodeId: string
  allowedWorkspaces: string[]
  developmentAllowHttp: boolean
}

export type Zero3RemoteHostStatus = {
  enabled: boolean
  connected: boolean
  nodeId: string
  activeTaskId: string | null
  lastError: string | null
  lastHeartbeatAt: string | null
}

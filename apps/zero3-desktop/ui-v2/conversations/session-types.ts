export type WorkspaceProvider = 'gpt' | 'gemini' | 'codex' | 'claude' | 'antigravity' | 'zero3'
export type WorkspaceExecutionHealth =
  | 'active'
  | 'idle'
  | 'stalled'
  | 'timeout_error'
  | 'connection_lost'
  | 'recovering'
  | 'recovery_failed'
  | 'rotating'
  | 'rotation_failed'

export type WorkspaceSession = {
  id: string
  provider: WorkspaceProvider
  title: string
  subtitle: string
  updatedAt: string
  projectId: string | null
  source: 'web' | 'local'
  archived?: boolean
  executing?: boolean
  executionHealth?: WorkspaceExecutionHealth | null
  lastProgressAt?: number | null
  executionIdleForMs?: number
  recoveryAttempt?: 0 | 1
  completionUnread?: boolean
}

export type LocalSessionProvider = Exclude<WorkspaceProvider, 'gpt' | 'gemini'>
export type LocalSessionThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type LocalSessionRuntimeConfig = {
  projectBinding?: import('../adapters/ProjectLinkAdapter').ProjectBinding | null
  model?: string | null
  thinkingEffort?: LocalSessionThinkingEffort | null
}

export type LocalSessionMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export type LocalSessionRecord = {
  nativeProjectAttached?: boolean
  projectBinding?: import('../adapters/ProjectLinkAdapter').ProjectBinding | null
  id: string
  provider: LocalSessionProvider
  projectId: string | null
  title: string
  createdAt: string
  updatedAt: string
  titleIsCustom?: boolean
  runtimeId: string | null
  zero3ProfileId: string | null
  model: string | null
  thinkingEffort: LocalSessionThinkingEffort | null
  archived?: boolean
  messages: LocalSessionMessage[]
}

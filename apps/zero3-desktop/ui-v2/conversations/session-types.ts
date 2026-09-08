export type WorkspaceProvider = 'gpt' | 'gemini' | 'codex' | 'claude' | 'antigravity' | 'zero3'

export type WorkspaceSession = {
  id: string
  provider: WorkspaceProvider
  title: string
  subtitle: string
  updatedAt: string
  projectId: string | null
  source: 'web' | 'local'
}

export type LocalSessionProvider = Exclude<WorkspaceProvider, 'gpt' | 'gemini'>

export type LocalSessionMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export type LocalSessionRecord = {
  id: string
  provider: LocalSessionProvider
  projectId: string | null
  title: string
  createdAt: string
  updatedAt: string
  titleIsCustom?: boolean
  runtimeId: string | null
  zero3ProfileId: string | null
  messages: LocalSessionMessage[]
}

export const ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION = 1 as const
export const ZERO3_GPT_WEB_PROFILE_ID = 'chatgpt-default' as const
export const ZERO3_GPT_WEB_HOME = 'https://chatgpt.com/' as const
export const ZERO3_GEMINI_WEB_PROFILE_ID = 'gemini-default' as const
export const ZERO3_GEMINI_WEB_HOME = 'https://gemini.google.com/' as const

export type Zero3WorkspaceEntryKind = 'gpt_web' | 'gemini_web'

export type Zero3WebWorkspaceEntryBase = {
  id: string
  projectId: string | null
  browserProfileId: string
  conversationUrl: string | null
  currentUrl: string
  pageTitle: string | null
  localDisplayTitle: string | null
  createdAt: string
  lastActiveAt: string
}

export type Zero3GptWebWorkspaceEntry = Zero3WebWorkspaceEntryBase & {
  kind: 'gpt_web'
}

export type Zero3GeminiWebWorkspaceEntry = Zero3WebWorkspaceEntryBase & {
  kind: 'gemini_web'
  logicalSessionId: string
}

export type Zero3WorkspaceEntry = Zero3GptWebWorkspaceEntry | Zero3GeminiWebWorkspaceEntry

export type Zero3WorkspaceEntryFile = {
  schemaVersion: typeof ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION
  entries: Record<string, Zero3WorkspaceEntry>
}

export type Zero3CreateGptWebEntryInput = {
  projectId?: string | null
}

export type Zero3CreateGeminiWebEntryInput = {
  projectId?: string | null
  logicalSessionId?: string | null
}

export type Zero3UpdateGptWebNavigationInput = {
  id: string
  currentUrl: string
  conversationUrl?: string | null
  pageTitle?: string | null
}

export type Zero3UpdateGeminiWebNavigationInput = Zero3UpdateGptWebNavigationInput

export type Zero3ResolveGptWebNavigationResult = {
  entry: Zero3GptWebWorkspaceEntry
  previousEntryId: string | null
}

export type Zero3ResolveGeminiWebNavigationResult = {
  entry: Zero3GeminiWebWorkspaceEntry
  previousEntryId: string | null
}

export type Zero3RenameWorkspaceEntryInput = {
  id: string
  title: string | null
}

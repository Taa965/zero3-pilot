export const ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION = 1 as const
export const ZERO3_GPT_WEB_PROFILE_ID = 'chatgpt-default' as const
export const ZERO3_GPT_WEB_HOME = 'https://chatgpt.com/' as const

export type Zero3WorkspaceEntryKind = 'gpt_web'

export type Zero3GptWebWorkspaceEntry = {
  id: string
  kind: 'gpt_web'
  projectId: string | null
  browserProfileId: string
  conversationUrl: string | null
  currentUrl: string
  pageTitle: string | null
  localDisplayTitle: string | null
  createdAt: string
  lastActiveAt: string
}

export type Zero3WorkspaceEntry = Zero3GptWebWorkspaceEntry

export type Zero3WorkspaceEntryFile = {
  schemaVersion: typeof ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION
  entries: Record<string, Zero3WorkspaceEntry>
}

export type Zero3CreateGptWebEntryInput = {
  projectId?: string | null
}

export type Zero3UpdateGptWebNavigationInput = {
  id: string
  currentUrl: string
  conversationUrl?: string | null
  pageTitle?: string | null
}

export type Zero3ResolveGptWebNavigationResult = {
  entry: Zero3GptWebWorkspaceEntry
  previousEntryId: string | null
}

export type Zero3RenameWorkspaceEntryInput = {
  id: string
  title: string | null
}

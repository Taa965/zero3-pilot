export const ZERO3_GPT_WEB_PARTITION = 'persist:zero3-chatgpt' as const

// Ten sessions are kept in the normal LRU warm pool. If the user has actively
// switched among more GPT sessions during the last five minutes, the provider
// temporarily expands the pool to the number of recent sessions, capped at 30.
export const ZERO3_GPT_WEB_BASE_LIVE_VIEWS = 10 as const
export const ZERO3_GPT_WEB_MAX_LIVE_VIEWS = 30 as const
export const ZERO3_GPT_WEB_ACTIVITY_WINDOW_MS = 5 * 60 * 1_000

export type Zero3GptWebBounds = {
  x: number
  y: number
  width: number
  height: number
}

// The lifecycle names below are the canonical states used by UI v2. The older
// names remain in the union for compatibility with the legacy provider sidebar
// while the application finishes converging on the unified lifecycle model.
export type Zero3GptWebState =
  | 'cold'
  | 'warming'
  | 'warm'
  | 'visible'
  | 'created'
  | 'loading'
  | 'ready'
  | 'shown'
  | 'hidden'
  | 'suspended'
  | 'error'

export type Zero3GptWebExecutionHealth = 'active' | 'idle' | 'stalled'
export type Zero3GptWebExecutionStatus = {
  executing: boolean
  health: Zero3GptWebExecutionHealth | null
  lastProgressAt: number | null
  idleForMs: number
}

export type Zero3GptWebEvent =
  | ({ kind: 'execution'; entryId: string } & Zero3GptWebExecutionStatus)
  | {
      kind: 'state'
      entryId: string
      state: Zero3GptWebState
      detail?: string
    }
  | {
      kind: 'navigation'
      entryId: string
      previousEntryId: string | null
      currentUrl: string
      conversationUrl: string | null
      pageTitle: string | null
    }

export type Zero3GptWebShowInput = {
  id: string
  bounds: Zero3GptWebBounds
}

export type Zero3GptWebNavigateInput = {
  id: string
  url: string
}

export type Zero3GptWebWarmResult = {
  state: 'warming' | 'warm' | 'visible'
}

export type Zero3GptWebSnapshotResult = {
  dataUrl: string | null
}

/**
 * A project as it exists on chatgpt.com. `id` is the gizmo id ChatGPT assigns
 * (`g-p-...`) and `url` is the project page a new conversation starts from, so
 * binding a Zero3 project only has to remember the URL.
 */
export type Zero3ChatGptRemoteProject = {
  id: string
  name: string
  url: string
}

export const ZERO3_GEMINI_WEB_PARTITION = 'persist:zero3-gemini' as const
export const ZERO3_GEMINI_WEB_MAX_LIVE_VIEWS = 3 as const

export type Zero3GeminiWebBounds = { x: number; y: number; width: number; height: number }

export type Zero3GeminiWebState = 'created' | 'loading' | 'ready' | 'shown' | 'hidden' | 'suspended' | 'error'

export type Zero3GeminiWebEvent =
  | { kind: 'state'; entryId: string; state: Zero3GeminiWebState; detail?: string }
  | {
      kind: 'navigation'
      entryId: string
      previousEntryId: string | null
      logicalSessionId: string
      currentUrl: string
      conversationUrl: string | null
      pageTitle: string | null
    }

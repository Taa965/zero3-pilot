export const ZERO3_GPT_WEB_PARTITION = 'persist:zero3-chatgpt' as const
export const ZERO3_GPT_WEB_MAX_LIVE_VIEWS = 3 as const

export type Zero3GptWebBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type Zero3GptWebState =
  | 'created'
  | 'loading'
  | 'ready'
  | 'shown'
  | 'hidden'
  | 'suspended'
  | 'error'

export type Zero3GptWebEvent =
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

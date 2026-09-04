import { useEffect } from 'react'

type JsonRecord = Record<string, unknown>
type CodexEvent =
  | { kind: 'request'; id: number | string; method: string; params: unknown }
  | { kind: 'notification' | 'lifecycle'; [key: string]: unknown }

type CodexBridge = {
  onEvent(callback: (event: CodexEvent) => void): () => void
  respondToServerRequest(response: { id: number | string; error: unknown }): Promise<{ ok: boolean }>
}

type Runtime = Window & { zero3Codex?: CodexBridge }

const runtime = window as Runtime
const UI_STATE_STORAGE_KEY = 'zero3.three-column-ui.v1'

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function activeEntryId(): string | null {
  try {
    const raw = window.localStorage.getItem(UI_STATE_STORAGE_KEY)
    if (!raw) return null
    return text(record(JSON.parse(raw)).activeId) || null
  } catch {
    return null
  }
}

function requestThreadId(params: unknown): string | null {
  const value = record(params)
  return text(value.threadId) || text(record(value.thread).id) || null
}

export function CodexBackgroundRequestGuard() {
  useEffect(() => {
    const bridge = runtime.zero3Codex
    if (!bridge?.onEvent) return

    return bridge.onEvent(event => {
      if (event.kind !== 'request') return
      const threadId = requestThreadId(event.params)
      const activeId = activeEntryId()
      if (!threadId || !activeId || threadId === activeId) return

      // A server request from a non-visible Codex Thread must not sit pending in
      // Electron main forever. The visible three-column workspace owns prompts
      // for its active Thread; background Threads are denied fail-closed until a
      // dedicated multi-thread prompt inbox exists.
      void bridge.respondToServerRequest({
        id: event.id,
        error: {
          code: -32004,
          message: `Zero3 denied background Codex request ${event.method}: thread ${threadId} is not the visible workspace.`
        }
      }).catch(() => {})
    })
  }, [])

  return null
}

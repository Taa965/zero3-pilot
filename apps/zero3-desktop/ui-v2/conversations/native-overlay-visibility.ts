import type { WorkspaceSession } from './session-types'

/**
 * Electron WebContentsView surfaces always sit above renderer DOM, regardless
 * of CSS z-index. Detach the active native view before opening a renderer
 * overlay so every control in the overlay remains visible and clickable.
 */
export async function hideNativeWebSession(session: WorkspaceSession | null): Promise<void> {
  if (!session || session.source !== 'web') return
  if (session.provider === 'gpt') {
    await window.zero3GptWeb.hide({ id: session.id })
    return
  }
  if (session.provider === 'gemini') {
    await window.zero3GeminiWeb.hide({ id: session.id })
  }
}

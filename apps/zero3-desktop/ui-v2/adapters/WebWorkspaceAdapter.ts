export type WebSessionProvider = 'gpt' | 'gemini'

export type WebSession = {
  id: string
  provider: WebSessionProvider
  title: string
  subtitle: string
  updatedAt: string
  projectId: string | null
}

// global.d.ts declares the entry union in module scope, so it is not visible by
// name here; deriving it from the bridge keeps this in step with that contract.
type WorkspaceEntry = Awaited<ReturnType<Window['zero3Workspace']['list']>>[number]

function bridgeAvailable(): boolean {
  return Boolean(window.zero3Workspace && window.zero3GptWeb)
}

function sessionTitle(entry: WorkspaceEntry): string {
  const explicit = entry.localDisplayTitle || entry.pageTitle
  if (explicit) return explicit
  return entry.kind === 'gpt_web' ? '新 GPT 网页会话' : '新 Gemini 网页会话'
}

// The workspace store keeps only the current URL, so the subtitle is the most
// specific location we can show: the conversation when ChatGPT has assigned one,
// the bare host before that.
function sessionSubtitle(entry: WorkspaceEntry): string {
  const target = entry.conversationUrl ?? entry.currentUrl
  try {
    const parsed = new URL(target)
    return parsed.pathname === '/' ? parsed.hostname : parsed.hostname + parsed.pathname
  } catch {
    return target
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const now = new Date()
  const sameDay = then.toDateString() === now.toDateString()
  if (sameDay) return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (then.toDateString() === yesterday.toDateString()) return '昨天'
  return then.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

function toSession(entry: WorkspaceEntry): WebSession {
  return {
    id: entry.id,
    provider: entry.kind === 'gpt_web' ? 'gpt' : 'gemini',
    title: sessionTitle(entry),
    subtitle: sessionSubtitle(entry),
    updatedAt: relativeTime(entry.lastActiveAt),
    projectId: entry.projectId
  }
}

export const WebWorkspaceAdapter = {
  available: bridgeAvailable,

  async list(): Promise<WebSession[]> {
    if (!bridgeAvailable()) return []
    const entries = await window.zero3Workspace.list()
    return entries
      .map(toSession)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  },

  async createGptWeb(projectId: string | null = null): Promise<string> {
    const entry = await window.zero3GptWeb.create({ projectId })
    return entry.id
  },

  async remove(id: string): Promise<void> {
    await window.zero3GptWeb.remove({ id }).catch(() => {})
    await window.zero3Workspace.remove({ id })
  },

  // Entry metadata (title, conversation URL, last-active) is written by main
  // while the page navigates, and the store emits nothing of its own. The
  // provider's navigation events are the signal that a re-list is worthwhile.
  subscribe(onChange: () => void): () => void {
    if (!bridgeAvailable()) return () => {}
    return window.zero3GptWeb.onEvent(event => {
      if (event.kind === 'navigation') onChange()
    })
  }
}

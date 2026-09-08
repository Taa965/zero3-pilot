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

/** A project as it exists on chatgpt.com, offered when binding a Zero3 project. */
export type ChatGptRemoteProject = Awaited<ReturnType<Window['zero3GptWeb']['listRemoteProjects']>>[number]

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

  // The projects that exist on chatgpt.com, for binding a Zero3 project to one
  // of them. Main reads them out of the signed-in ChatGPT page, so this rejects
  // when nobody is signed in yet.
  async listChatGptProjects(): Promise<ChatGptRemoteProject[]> {
    if (!bridgeAvailable()) throw new Error('Zero3 GPT 网页运行时尚未加载')
    return window.zero3GptWeb.listRemoteProjects()
  },

  // Removing an entry only drops Zero3's own record and its native view; the
  // conversation on chatgpt.com/gemini.google.com is untouched. Each provider
  // owns its live views, so the wrong bridge would leave one stranded above the
  // renderer after the workspace record is gone.
  async remove(session: Pick<WebSession, 'id' | 'provider'>): Promise<void> {
    const bridge = session.provider === 'gemini' ? window.zero3GeminiWeb : window.zero3GptWeb
    await bridge.remove({ id: session.id }).catch(() => {})
    await window.zero3Workspace.remove({ id: session.id })
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

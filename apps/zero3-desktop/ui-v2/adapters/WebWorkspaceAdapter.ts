import type { WorkspaceSession } from '../conversations/session-types'

// global.d.ts declares the entry union in module scope, so it is not visible by
// name here; deriving it from the bridge keeps this in step with that contract.
type WorkspaceEntry = Awaited<ReturnType<Window['zero3Workspace']['list']>>[number]

/** A project as it exists on chatgpt.com, offered when binding a Zero3 project. */
export type ChatGptRemoteProject = Awaited<ReturnType<Window['zero3GptWeb']['listRemoteProjects']>>[number]

function bridgeAvailable(): boolean {
  return Boolean(window.zero3Workspace && window.zero3GptWeb && window.zero3GeminiWeb)
}

function sessionTitle(entry: WorkspaceEntry): string {
  const explicit = entry.localDisplayTitle || entry.pageTitle
  if (explicit) return explicit
  return entry.kind === 'gpt_web' ? '新 GPT 网页会话' : '新 Gemini 网页会话'
}

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
  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (then.toDateString() === yesterday.toDateString()) return '昨天'
  return then.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

function toSession(entry: WorkspaceEntry): WorkspaceSession {
  return {
    id: entry.id,
    provider: entry.kind === 'gpt_web' ? 'gpt' : 'gemini',
    title: sessionTitle(entry),
    subtitle: sessionSubtitle(entry),
    updatedAt: relativeTime(entry.lastActiveAt),
    projectId: entry.projectId,
    source: 'web'
  }
}

export const WebWorkspaceAdapter = {
  available: bridgeAvailable,

  async list(): Promise<WorkspaceSession[]> {
    if (!bridgeAvailable()) return []
    const entries = await window.zero3Workspace.list()
    return entries
      .slice()
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
      .map(toSession)
  },

  async createGptWeb(projectId: string | null = null): Promise<string> {
    const entry = await window.zero3GptWeb.create({ projectId })
    return entry.id
  },

  async createGeminiWeb(projectId: string | null = null): Promise<string> {
    const entry = await window.zero3GeminiWeb.create({ projectId })
    return entry.id
  },

  async listChatGptProjects(): Promise<ChatGptRemoteProject[]> {
    if (!bridgeAvailable()) throw new Error('Zero3 GPT 网页运行时尚未加载')
    return window.zero3GptWeb.listRemoteProjects()
  },

  async remove(session: Pick<WorkspaceSession, 'id' | 'provider'>): Promise<void> {
    if (session.provider !== 'gpt' && session.provider !== 'gemini') return
    const bridge = session.provider === 'gemini' ? window.zero3GeminiWeb : window.zero3GptWeb
    await bridge.remove({ id: session.id }).catch(() => {})
    await window.zero3Workspace.remove({ id: session.id })
  },

  subscribe(onChange: () => void): () => void {
    if (!bridgeAvailable()) return () => {}
    const gpt = window.zero3GptWeb.onEvent(event => {
      if (event.kind === 'navigation') onChange()
    })
    const gemini = window.zero3GeminiWeb.onEvent(event => {
      if (event.kind === 'navigation') onChange()
    })
    return () => {
      gpt()
      gemini()
    }
  }
}

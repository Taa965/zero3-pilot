import { webSessionTitle } from './web-session-title'
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
  return webSessionTitle(entry)
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

function toSession(entry: WorkspaceEntry, execution: Awaited<ReturnType<Window['zero3GptWeb']['executionStatus']>>): WorkspaceSession {
  return {
    id: entry.id,
    provider: entry.kind === 'gpt_web' ? 'gpt' : 'gemini',
    title: sessionTitle(entry),
    subtitle: sessionSubtitle(entry),
    updatedAt: relativeTime(entry.lastActiveAt),
    projectId: entry.projectId,
    source: 'web',
    archived: entry.archived === true,
    executing: execution.executing === true,
    executionHealth: execution.health,
    lastProgressAt: execution.lastProgressAt,
    executionIdleForMs: execution.idleForMs
  }
}

async function executionState(entry: WorkspaceEntry): Promise<Awaited<ReturnType<Window['zero3GptWeb']['executionStatus']>>> {
  const bridge = entry.kind === 'gpt_web' ? window.zero3GptWeb : window.zero3GeminiWeb
  const probe = bridge.executionStatus
  const stopped = { executing: false, health: null, lastProgressAt: null, idleForMs: 0 } as const
  if (typeof probe !== 'function') return stopped
  return probe({ id: entry.id }).catch(() => stopped)
}

export const WebWorkspaceAdapter = {
  available: bridgeAvailable,

  async list(): Promise<WorkspaceSession[]> {
    if (!bridgeAvailable()) return []
    const entries = await window.zero3Workspace.list()
    const sorted = entries.slice().sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
    const execution = await Promise.all(sorted.map(executionState))
    return sorted.map((entry, index) => toSession(entry, execution[index]))
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

  async rename(session: Pick<WorkspaceSession, 'id' | 'provider'>, title: string): Promise<void> {
    const normalized = title.trim()
    if (!normalized || normalized.length > 200) throw new Error('名称需为 1–200 个字符')
    if (session.provider === 'gpt') {
      if (!window.zero3GptWeb.rename) throw new Error('名称同步功能尚未加载，请重启零三后重试')
      await window.zero3GptWeb.rename({ id: session.id, title: normalized })
    } else {
      await window.zero3Workspace.rename({ id: session.id, title: normalized })
    }
  },

  async setArchived(session: Pick<WorkspaceSession, 'id' | 'provider'>, archived: boolean): Promise<void> {
    if (session.provider === 'gpt') {
      if (!window.zero3GptWeb.setArchived) throw new Error('GPT web archive support is not loaded; restart Zero3 and retry')
      await window.zero3GptWeb.setArchived({ id: session.id, archived })
      return
    }
    if (session.provider === 'gemini') {
      await window.zero3Workspace.setArchived({ id: session.id, archived })
    }
  },

  async remove(session: Pick<WorkspaceSession, 'id' | 'provider'>): Promise<void> {
    if (session.provider !== 'gpt' && session.provider !== 'gemini') return
    const bridge = session.provider === 'gemini' ? window.zero3GeminiWeb : window.zero3GptWeb
    await bridge.remove({ id: session.id }).catch(() => {})
    await window.zero3Workspace.remove({ id: session.id })
  },

  subscribe(
    onChange: () => void,
    onExecutionChange?: (sessionId: string, status: Awaited<ReturnType<Window['zero3GptWeb']['executionStatus']>>) => void
  ): () => void {
    if (!bridgeAvailable()) return () => {}
    const gpt = window.zero3GptWeb.onEvent(event => {
      if (event.kind === 'execution') onExecutionChange?.(event.entryId, { executing: event.executing, health: event.health, lastProgressAt: event.lastProgressAt, idleForMs: event.idleForMs })
      else if (event.kind === 'navigation') onChange()
    })
    const gemini = window.zero3GeminiWeb.onEvent(event => {
      if (event.kind === 'execution') onExecutionChange?.(event.entryId, { executing: event.executing, health: event.health, lastProgressAt: event.lastProgressAt, idleForMs: event.idleForMs })
      else if (event.kind === 'navigation') onChange()
    })
    return () => {
      gpt()
      gemini()
    }
  }
}

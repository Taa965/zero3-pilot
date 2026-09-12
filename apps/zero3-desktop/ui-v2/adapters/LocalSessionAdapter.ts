import { localTurnMessageText } from '../conversations/local-turn-failure'
import type {
  LocalSessionMessage,
  LocalSessionProvider,
  LocalSessionRecord,
  LocalSessionRuntimeConfig,
  LocalSessionThinkingEffort,
  WorkspaceSession
} from '../conversations/session-types'

const STORAGE_KEY = 'zero3.local-sessions.v1'
const CHANGE_EVENT = 'zero3-local-sessions-changed'
const MAX_SESSIONS = 500
const MAX_MESSAGES = 120
const MAX_CONTENT = 20_000

function normalizeProjectBinding(value: unknown): LocalSessionRecord['projectBinding'] {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!['codex','claude','antigravity'].includes(String(raw.provider)) || typeof raw.rootPath !== 'string' || typeof raw.revision !== 'number') return null
  return { provider: raw.provider as 'codex' | 'claude' | 'antigravity', rootPath: raw.rootPath, revision: raw.revision,
    externalId: typeof raw.externalId === 'string' ? raw.externalId : null, ...(typeof raw.name === 'string' ? { name: raw.name } : {}) }
}

function now() {
  return new Date().toISOString()
}

function uid(prefix: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `${prefix}-${random}`
}

function providerLabel(provider: LocalSessionProvider) {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude Code'
  if (provider === 'antigravity') return 'Antigravity'
  if (provider === 'workbuddy') return 'WorkBuddy AI'
  return 'Zero3'
}

function normalizeModel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null
}

function normalizeThinkingEffort(value: unknown): LocalSessionThinkingEffort | null {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra'
    ? value
    : null
}

function normalizeServiceTier(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null
}

function normalizeMessage(value: unknown): LocalSessionMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.role !== 'user' && raw.role !== 'assistant') return null
  const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, MAX_CONTENT) : ''
  if (!content) return null
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : uid('msg'),
    role: raw.role,
    content,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt : now()
  }
}

function normalizeRecord(value: unknown): LocalSessionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const provider = raw.provider
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'antigravity' && provider !== 'workbuddy' && provider !== 'zero3') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(normalizeMessage).filter((item): item is LocalSessionMessage => Boolean(item)).slice(-MAX_MESSAGES)
    : []
  return {
    id,
    provider,
    projectBinding: normalizeProjectBinding(raw.projectBinding),
    nativeProjectAttached: raw.nativeProjectAttached === true,
    projectId: typeof raw.projectId === 'string' && raw.projectId.trim() ? raw.projectId.trim() : null,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 200) : `新 ${providerLabel(provider)} 会话`,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt : now(),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : now(),
    titleIsCustom: raw.titleIsCustom === true,
    runtimeId: typeof raw.runtimeId === 'string' && raw.runtimeId.trim() ? raw.runtimeId.trim() : null,
    zero3ProfileId: typeof raw.zero3ProfileId === 'string' && raw.zero3ProfileId.trim() ? raw.zero3ProfileId.trim() : null,
    model: normalizeModel(raw.model),
    thinkingEffort: normalizeThinkingEffort(raw.thinkingEffort),
    serviceTier: normalizeServiceTier(raw.serviceTier),
    archived: raw.archived === true,
    messages
  }
}

function read(): LocalSessionRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeRecord)
      .filter((item): item is LocalSessionRecord => Boolean(item))
      .slice(-MAX_SESSIONS)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

function write(records: LocalSessionRecord[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_SESSIONS)))
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

function mutate(id: string, update: (record: LocalSessionRecord) => LocalSessionRecord): LocalSessionRecord {
  const records = read()
  const index = records.findIndex(record => record.id === id)
  if (index < 0) throw new Error('本地会话不存在')
  const next = update(records[index])
  records[index] = next
  write(records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  return next
}

function relativeTime(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const current = new Date()
  if (then.toDateString() === current.toDateString()) {
    return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(current)
  yesterday.setDate(current.getDate() - 1)
  if (then.toDateString() === yesterday.toDateString()) return '昨天'
  return then.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

export const LocalSessionAdapter = {
  list(): LocalSessionRecord[] {
    return read()
  },

  toWorkspaceSession(record: LocalSessionRecord): WorkspaceSession {
    const lastMessage = record.messages.at(-1)
    const last = lastMessage ? localTurnMessageText(record.provider, lastMessage) : `${providerLabel(record.provider)} 本地会话`
    return {
      id: record.id,
      provider: record.provider,
      title: record.title,
      subtitle: last.replace(/\s+/g, ' ').slice(0, 120),
      updatedAt: relativeTime(record.updatedAt),
      projectId: record.projectId,
      source: 'local',
      archived: record.archived === true
    }
  },

  create(
    provider: LocalSessionProvider,
    projectId: string | null,
    zero3ProfileId: string | null = null,
    runtimeConfig: LocalSessionRuntimeConfig = {}
  ): LocalSessionRecord {
    const timestamp = now()
    const record: LocalSessionRecord = {
      id: uid(`local-${provider}`),
      provider,
      projectId,
      projectBinding: normalizeProjectBinding(runtimeConfig.projectBinding),
      title: `新 ${providerLabel(provider)} 会话`,
      createdAt: timestamp,
      updatedAt: timestamp,
      runtimeId: provider === 'antigravity' ? uid('agy-session') : null,
      zero3ProfileId: provider === 'zero3' ? zero3ProfileId : null,
      model: normalizeModel(runtimeConfig.model),
      thinkingEffort: normalizeThinkingEffort(runtimeConfig.thinkingEffort),
      serviceTier: normalizeServiceTier(runtimeConfig.serviceTier),
      archived: false,
      messages: []
    }
    write([record, ...read().filter(item => item.id !== record.id)])
    return record
  },

  get(id: string): LocalSessionRecord | null {
    return read().find(record => record.id === id) ?? null
  },

  remove(id: string): void {
    write(read().filter(record => record.id !== id))
  },

  rename(id: string, title: string): LocalSessionRecord {
    const normalized = title.trim()
    if (!normalized || normalized.length > 200) throw new Error('名称需为 1–200 个字符')
    return mutate(id, record => ({ ...record, title: normalized, titleIsCustom: true, updatedAt: now() }))
  },

  setArchived(id: string, archived: boolean): LocalSessionRecord {
    return mutate(id, record => ({ ...record, archived }))
  },

  setRuntimeId(id: string, runtimeId: string): LocalSessionRecord {
    const normalized = runtimeId.trim()
    if (!normalized) throw new Error('runtimeId 不能为空')
    return mutate(id, record => ({ ...record, runtimeId: normalized, updatedAt: now() }))
  },

  markNativeProjectAttached(id: string): LocalSessionRecord {
    return mutate(id, record => ({ ...record, nativeProjectAttached: true }))
  },

  resetRuntimeConfig(id: string): LocalSessionRecord {
    return mutate(id, record => ({ ...record, model: null, thinkingEffort: null, serviceTier: null, updatedAt: now() }))
  },

  setZero3RuntimeConfig(id: string, input: { profileId: string; model?: string | null; thinkingEffort?: LocalSessionThinkingEffort | null; serviceTier?: string | null }): LocalSessionRecord {
    const profileId = input.profileId.trim()
    if (!profileId) throw new Error('Zero3 API Profile 不能为空')
    return mutate(id, record => {
      if (record.provider !== 'zero3') throw new Error('只有 Zero3 本体会话可以切换 API Profile')
      return { ...record, zero3ProfileId: profileId, model: normalizeModel(input.model), thinkingEffort: normalizeThinkingEffort(input.thinkingEffort), serviceTier: normalizeServiceTier(input.serviceTier), updatedAt: now() }
    })
  },

  appendMessage(id: string, role: 'user' | 'assistant', content: string): LocalSessionRecord {
    const normalized = content.trim()
    if (!normalized) throw new Error('消息不能为空')
    const bounded = normalized.slice(0, MAX_CONTENT)
    return mutate(id, record => {
      const messages = [
        ...record.messages,
        { id: uid(`msg-${role}`), role, content: bounded, createdAt: now() } satisfies LocalSessionMessage
      ].slice(-MAX_MESSAGES)
      const firstUser = messages.find(message => message.role === 'user')?.content
      return {
        ...record,
        title: !record.titleIsCustom && firstUser ? firstUser.replace(/\s+/g, ' ').slice(0, 42) : record.title,
        messages,
        updatedAt: now()
      }
    })
  },

  subscribe(onChange: () => void): () => void {
    const local = () => onChange()
    const storage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) onChange()
    }
    window.addEventListener(CHANGE_EVENT, local)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, local)
      window.removeEventListener('storage', storage)
    }
  }
}

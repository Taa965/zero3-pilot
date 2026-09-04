import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Provider = 'codex' | 'gpt' | 'gemini'
type ProviderFilter = 'all' | Provider

type JsonRecord = Record<string, unknown>

type WorkspaceEntry = {
  id: string
  kind: 'gpt_web' | 'gemini_web'
  projectId: string | null
  logicalSessionId?: string
  conversationUrl: string | null
  currentUrl: string
  pageTitle: string | null
  localDisplayTitle: string | null
  createdAt: string
  lastActiveAt: string
}

type SessionRow = {
  id: string
  provider: Provider
  title: string
  subtitle: string
  status: string
  sortKey: number
  raw: unknown
}

type SurfaceBounds = { x: number; y: number; width: number; height: number }

type CodexEvent =
  | { kind: 'lifecycle'; state: 'started' | 'stopped' | 'error'; detail?: string }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: number | string; method: string; params: unknown }

type PendingPrompt = {
  id: number | string
  method: string
  params: JsonRecord
}

type CodexBridge = {
  status: () => Promise<unknown>
  start: () => Promise<unknown>
  thread: {
    start: (request?: unknown) => Promise<unknown>
    resume: (request: unknown) => Promise<unknown>
    list: (request?: unknown) => Promise<unknown>
    read: (request: unknown) => Promise<unknown>
    delete?: (request: unknown) => Promise<unknown>
    setName?: (request: unknown) => Promise<unknown>
  }
  turn: {
    start: (request: unknown) => Promise<unknown>
    interrupt: (request: unknown) => Promise<unknown>
  }
  respondToServerRequest: (response: unknown) => Promise<{ ok: boolean }>
  onEvent: (callback: (event: CodexEvent) => void) => () => void
}

type WorkspaceBridge = {
  list: () => Promise<WorkspaceEntry[]>
  rename: (request: { id: string; title: string | null }) => Promise<WorkspaceEntry>
  remove: (request: { id: string }) => Promise<{ removed: boolean }>
}

type WebBridge = {
  create: (request?: { projectId?: string | null }) => Promise<WorkspaceEntry>
  show: (request: { id: string; bounds: SurfaceBounds }) => Promise<WorkspaceEntry>
  hide: (request: { id: string }) => Promise<{ hidden: boolean }>
  setBounds: (request: { id: string; bounds: SurfaceBounds }) => Promise<{ ok: true }>
  reload: (request: { id: string }) => Promise<{ ok: true }>
  remove: (request: { id: string }) => Promise<{ removed: boolean }>
  openExternal: (request: { id: string }) => Promise<{ opened: boolean }>
  onEvent: (callback: (event: JsonRecord) => void) => () => void
}

type Zero3Window = Window & {
  zero3Codex?: CodexBridge
  zero3Workspace?: WorkspaceBridge
  zero3GptWeb?: WebBridge
  zero3GeminiWeb?: WebBridge
}

const PROVIDERS: Array<{ id: Provider; label: string; short: string }> = [
  { id: 'codex', label: 'Codex', short: 'C' },
  { id: 'gpt', label: 'GPT', short: 'G' },
  { id: 'gemini', label: 'Gemini', short: '✦' }
]

const APPROVAL_POLICY = 'on-request'
const SANDBOX_POLICY = 'workspace-write'

function zero3Window(): Zero3Window {
  return window as Zero3Window
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function dateValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function threadFrom(value: unknown): JsonRecord | null {
  const thread = record(record(value).thread)
  return text(thread.id) ? thread : null
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(part => {
      const item = record(part)
      return text(item.text) ?? text(item.content) ?? ''
    })
    .filter(Boolean)
    .join('\n')
}

function itemText(item: JsonRecord): string {
  return (
    text(item.text) ??
    contentText(item.content) ??
    text(item.summary) ??
    text(item.message) ??
    text(item.command) ??
    ''
  )
}

function providerFromEntry(entry: WorkspaceEntry): Provider {
  return entry.kind === 'gemini_web' ? 'gemini' : 'gpt'
}

function workspaceTitle(entry: WorkspaceEntry): string {
  const fallback = entry.kind === 'gemini_web' ? 'Gemini 网页会话' : 'GPT 网页会话'
  return entry.localDisplayTitle || entry.pageTitle || fallback
}

function codexStatus(thread: JsonRecord): string {
  const status = record(thread.status)
  const type = text(status.type) ?? text(thread.status)
  if (type === 'active' || type === 'inProgress') return '执行中'
  if (type === 'error') return '异常'
  return '就绪'
}

function codexRow(raw: unknown): SessionRow | null {
  const thread = record(raw)
  const id = text(thread.id)
  if (!id || thread.parentThreadId != null || thread.ephemeral === true) return null
  const title = text(thread.name) ?? text(thread.preview) ?? '新 Codex 会话'
  const cwd = text(thread.cwd)
  return {
    id,
    provider: 'codex',
    title,
    subtitle: cwd ? cwd.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ') : 'Codex Local',
    status: codexStatus(thread),
    sortKey: Math.max(dateValue(thread.recencyAt), dateValue(thread.updatedAt), dateValue(thread.createdAt)),
    raw: thread
  }
}

function workspaceRow(entry: WorkspaceEntry): SessionRow {
  const provider = providerFromEntry(entry)
  return {
    id: entry.id,
    provider,
    title: workspaceTitle(entry),
    subtitle: entry.projectId || (provider === 'gemini' ? 'Gemini Web' : 'ChatGPT Web'),
    status: entry.conversationUrl ? '已连接' : '就绪',
    sortKey: dateValue(entry.lastActiveAt) || dateValue(entry.createdAt),
    raw: entry
  }
}

function surfaceBounds(element: HTMLElement | null): SurfaceBounds | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(2, Math.round(rect.width)),
    height: Math.max(2, Math.round(rect.height))
  }
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 172_800) return '昨天'
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function providerLabel(provider: Provider): string {
  return PROVIDERS.find(item => item.id === provider)?.label ?? provider
}

function providerGlyph(provider: Provider): string {
  return PROVIDERS.find(item => item.id === provider)?.short ?? '?'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return '未知错误'
}

function Icon({ name }: { name: 'chat' | 'refresh' | 'settings' | 'search' | 'plus' | 'panel' | 'send' | 'trash' | 'external' | 'reload' }) {
  const paths: Record<string, string> = {
    chat: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4h-1A2.5 2.5 0 0 1 4 12.5z',
    refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7',
    settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm8-3.5 2-1-2-3-2.3.2L16.4 6 17 3h-4l-1 2-2-2-3 2 .2 2.3L5 8.6 2 8v4l2 1 1 3-1 2 3 2 2-1 3 1 1 2h4l1-2 2-1-1-3 1-2z',
    search: 'M10.5 18a7.5 7.5 0 1 1 5.3-2.2L21 21',
    plus: 'M12 5v14M5 12h14',
    panel: 'M4 5h16v14H4zm10 0v14',
    send: 'M3 20 21 12 3 4l2.5 6L15 12l-9.5 2z',
    trash: 'M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13',
    external: 'M14 4h6v6m0-6-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5',
    reload: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7'
  }
  return (
    <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24">
      <path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  )
}

function ProviderBadge({ provider }: { provider: Provider }) {
  return <span className={`provider-badge provider-${provider}`}>{providerGlyph(provider)}</span>
}

function ThreadTimeline({ thread, events }: { thread: JsonRecord | null; events: Array<{ key: string; label: string; detail: string }> }) {
  if (!thread) return <div className="empty-detail">选择或新建一个 Codex 会话。</div>
  const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : []
  const rows: Array<{ key: string; type: string; item: JsonRecord; turn: JsonRecord }> = []
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items.map(record) : []
    items.forEach((item, index) => {
      rows.push({ key: text(item.id) ?? `${text(turn.id) ?? 'turn'}-${index}`, type: text(item.type) ?? 'item', item, turn })
    })
  }

  if (rows.length === 0 && events.length === 0) {
    return <div className="empty-detail">这个会话还没有消息。可以在下方直接向 Codex 发送任务。</div>
  }

  return (
    <div className="timeline">
      {rows.map(row => {
        const value = itemText(row.item)
        if (row.type === 'userMessage') {
          return (
            <article className="message user-message" key={row.key}>
              <div className="avatar user-avatar">你</div>
              <div><div className="message-title">用户</div><div className="message-text">{value}</div></div>
            </article>
          )
        }
        if (row.type === 'agentMessage') {
          return (
            <article className="message assistant-message" key={row.key}>
              <div className="avatar codex-avatar">C</div>
              <div className="message-body"><div className="message-title">Codex 本地</div><div className="message-text markdown-like">{value || '正在生成…'}</div></div>
            </article>
          )
        }
        const state = text(row.item.status) ?? text(row.turn.status) ?? '记录'
        return (
          <article className="tool-card" key={row.key}>
            <div className="tool-dot" />
            <div className="tool-content">
              <div className="tool-head"><span>{row.type}</span><span className="tool-state">{state}</span></div>
              {value ? <pre>{value}</pre> : <div className="tool-muted">Codex 原生 Item</div>}
            </div>
          </article>
        )
      })}
      {events.slice(-8).map(event => (
        <article className="runtime-event" key={event.key}>
          <span className="runtime-check">✓</span>
          <span>{event.label}</span>
          {event.detail ? <span className="runtime-event-detail">{event.detail}</span> : null}
        </article>
      ))}
    </div>
  )
}

function PromptOverlay({ prompt, onClose }: { prompt: PendingPrompt; onClose: () => void }) {
  const bridge = zero3Window().zero3Codex
  const [submitting, setSubmitting] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const isApproval = prompt.method === 'item/commandExecution/requestApproval' || prompt.method === 'item/fileChange/requestApproval'
  const questions = Array.isArray(prompt.params.questions) ? prompt.params.questions.map(record) : []

  const respond = async (result: unknown) => {
    if (!bridge || submitting) return
    setSubmitting(true)
    try {
      await bridge.respondToServerRequest({ id: prompt.id, result })
      onClose()
    } catch {
      setSubmitting(false)
    }
  }

  const decline = async () => {
    if (!bridge || submitting) return
    setSubmitting(true)
    try {
      if (isApproval) await bridge.respondToServerRequest({ id: prompt.id, result: { decision: 'decline' } })
      else await bridge.respondToServerRequest({ id: prompt.id, error: { code: -32002, message: 'User cancelled the request.' } })
      onClose()
    } catch {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-modal="true" className="modal" role="dialog">
        <h3>{isApproval ? 'Codex 请求执行权限' : 'Codex 需要你的输入'}</h3>
        {isApproval ? (
          <>
            <p>{text(prompt.params.reason) ?? (prompt.method.includes('fileChange') ? 'Codex 请求修改工作区文件。' : 'Codex 请求执行命令。')}</p>
            {text(prompt.params.cwd) ? <div className="modal-meta">工作目录：{text(prompt.params.cwd)}</div> : null}
            {text(prompt.params.command) ? <pre className="approval-command">{text(prompt.params.command)}</pre> : null}
            {text(prompt.params.grantRoot) ? <pre className="approval-command">{text(prompt.params.grantRoot)}</pre> : null}
          </>
        ) : (
          <div className="questions">
            {questions.map((question, index) => {
              const id = text(question.id) ?? `q-${index}`
              const options = Array.isArray(question.options) ? question.options.map(record) : []
              return (
                <label className="question" key={id}>
                  <span>{text(question.header) ?? `问题 ${index + 1}`}</span>
                  <small>{text(question.question) ?? ''}</small>
                  {options.length ? (
                    <select onChange={event => setAnswers(current => ({ ...current, [id]: event.target.value }))} value={answers[id] ?? ''}>
                      <option value="">请选择</option>
                      {options.map((option, optionIndex) => <option key={`${id}-${optionIndex}`} value={text(option.label) ?? ''}>{text(option.label) ?? ''}</option>)}
                    </select>
                  ) : (
                    <input onChange={event => setAnswers(current => ({ ...current, [id]: event.target.value }))} type={question.isSecret === true ? 'password' : 'text'} value={answers[id] ?? ''} />
                  )}
                </label>
              )
            })}
          </div>
        )}
        <div className="modal-actions">
          <button className="button secondary" disabled={submitting} onClick={() => void decline()} type="button">拒绝 / 取消</button>
          {isApproval ? <button className="button secondary" disabled={submitting} onClick={() => void respond({ decision: 'acceptForSession' })} type="button">本会话允许</button> : null}
          <button className="button primary" disabled={submitting} onClick={() => void respond(isApproval ? { decision: 'accept' } : { answers: Object.fromEntries(questions.map((question, index) => {
            const id = text(question.id) ?? `q-${index}`
            return [id, { answers: [(answers[id] ?? '').trim()] }]
          })) })} type="button">{isApproval ? '仅本次允许' : '继续'}</button>
        </div>
      </section>
    </div>
  )
}

export function App() {
  const bridges = zero3Window()
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeProvider, setActiveProvider] = useState<Provider>('codex')
  const [filter, setFilter] = useState<ProviderFilter>('all')
  const [query, setQuery] = useState('')
  const [newMenu, setNewMenu] = useState(false)
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  const [codexThread, setCodexThread] = useState<JsonRecord | null>(null)
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const [runtimeEvents, setRuntimeEvents] = useState<Array<{ key: string; label: string; detail: string }>>([])
  const webHostRef = useRef<HTMLDivElement | null>(null)
  const visibleWebRef = useRef<{ provider: Provider; id: string } | null>(null)
  const refreshTimerRef = useRef<number | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const activeProviderRef = useRef<Provider>('codex')

  const selected = useMemo(() => sessions.find(row => row.id === selectedId) ?? null, [sessions, selectedId])
  const filteredSessions = useMemo(() => sessions.filter(row => {
    if (filter !== 'all' && row.provider !== filter) return false
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return true
    return `${row.title} ${row.subtitle} ${providerLabel(row.provider)}`.toLocaleLowerCase().includes(needle)
  }), [filter, query, sessions])

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  useEffect(() => { activeProviderRef.current = activeProvider }, [activeProvider])
  useEffect(() => { setRenameTitle(selected?.title ?? '') }, [selected])

  const loadCodexThread = useCallback(async (threadId: string) => {
    const codex = zero3Window().zero3Codex
    if (!codex) return
    try {
      await codex.start()
      try {
        await codex.thread.resume({ threadId, approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX_POLICY })
      } catch {
        // thread/read is still authoritative for presentation when resume is not required.
      }
      const response = await codex.thread.read({ threadId, includeTurns: true })
      const thread = threadFrom(response)
      if (thread && selectedIdRef.current === threadId) setCodexThread(thread)
    } catch (error) {
      setNotice(`Codex 会话读取失败：${errorMessage(error)}`)
    }
  }, [])

  const refreshSessions = useCallback(async (preferId?: string | null) => {
    setLoading(true)
    const rows: SessionRow[] = []
    const current = zero3Window()
    try {
      if (current.zero3Codex) {
        try {
          await current.zero3Codex.start()
          const result = record(await current.zero3Codex.thread.list({ archived: false, limit: 100 }))
          const data = Array.isArray(result.data) ? result.data : []
          data.forEach(value => {
            const row = codexRow(value)
            if (row) rows.push(row)
          })
        } catch (error) {
          setNotice(`Codex 暂不可用：${errorMessage(error)}`)
        }
      }
      if (current.zero3Workspace) {
        try {
          const entries = await current.zero3Workspace.list()
          entries.forEach(entry => rows.push(workspaceRow(entry)))
        } catch (error) {
          setNotice(`网页会话列表读取失败：${errorMessage(error)}`)
        }
      }
      rows.sort((a, b) => b.sortKey - a.sortKey)
      setSessions(rows)
      const wanted = preferId ?? selectedIdRef.current
      const next = (wanted && rows.some(row => row.id === wanted) ? wanted : null) ?? rows[0]?.id ?? null
      setSelectedId(next)
      if (next) {
        const row = rows.find(candidate => candidate.id === next)
        if (row) setActiveProvider(row.provider)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const hideWebSurface = useCallback(async () => {
    const visible = visibleWebRef.current
    if (!visible) return
    visibleWebRef.current = null
    try {
      if (visible.provider === 'gpt') await zero3Window().zero3GptWeb?.hide({ id: visible.id })
      if (visible.provider === 'gemini') await zero3Window().zero3GeminiWeb?.hide({ id: visible.id })
    } catch {}
  }, [])

  const showWebSurface = useCallback(async (provider: Provider, id: string) => {
    if (provider === 'codex') return
    const bounds = surfaceBounds(webHostRef.current)
    if (!bounds) return
    const bridge = provider === 'gpt' ? zero3Window().zero3GptWeb : zero3Window().zero3GeminiWeb
    if (!bridge) {
      setNotice(`${providerLabel(provider)} Provider 尚未装载。`)
      return
    }
    const current = visibleWebRef.current
    if (current && (current.provider !== provider || current.id !== id)) await hideWebSurface()
    try {
      await bridge.show({ id, bounds })
      visibleWebRef.current = { provider, id }
    } catch (error) {
      setNotice(`${providerLabel(provider)} 页面显示失败：${errorMessage(error)}`)
    }
  }, [hideWebSurface])

  const selectSession = useCallback((row: SessionRow) => {
    setSelectedId(row.id)
    setActiveProvider(row.provider)
    setNewMenu(false)
  }, [])

  const createSession = useCallback(async (provider: Provider): Promise<string | null> => {
    setNewMenu(false)
    setNotice(null)
    setLoading(true)
    try {
      if (provider === 'codex') {
        const codex = zero3Window().zero3Codex
        if (!codex) throw new Error('Codex app-server bridge 不可用')
        await hideWebSurface()
        await codex.start()
        const result = await codex.thread.start({ approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX_POLICY })
        const thread = threadFrom(result)
        const id = thread ? text(thread.id) : null
        if (!id) throw new Error('thread/start 未返回有效 Thread')
        setActiveProvider('codex')
        setSelectedId(id)
        setCodexThread(thread)
        await refreshSessions(id)
        return id
      }
      const bridge = provider === 'gpt' ? zero3Window().zero3GptWeb : zero3Window().zero3GeminiWeb
      if (!bridge) throw new Error(`${providerLabel(provider)} Provider 不可用`)
      const entry = await bridge.create({ projectId: null })
      setActiveProvider(provider)
      setSelectedId(entry.id)
      await refreshSessions(entry.id)
      window.requestAnimationFrame(() => void showWebSurface(provider, entry.id))
      return entry.id
    } catch (error) {
      setNotice(`新建会话失败：${errorMessage(error)}`)
      return null
    } finally {
      setLoading(false)
    }
  }, [hideWebSurface, refreshSessions, showWebSurface])

  const chooseProviderTab = useCallback((provider: Provider) => {
    setActiveProvider(provider)
    const candidate = sessions.find(row => row.provider === provider)
    setSelectedId(candidate?.id ?? null)
    if (provider === 'codex') void hideWebSurface()
  }, [hideWebSurface, sessions])

  const sendCodex = useCallback(async () => {
    const value = composer.trim()
    if (!value || sending) return
    const codex = zero3Window().zero3Codex
    if (!codex) {
      setNotice('Codex app-server bridge 不可用。')
      return
    }
    setSending(true)
    setComposer('')
    try {
      let threadId = activeProviderRef.current === 'codex' ? selectedIdRef.current : null
      if (!threadId) threadId = await createSession('codex')
      if (!threadId) throw new Error('无法创建 Codex Thread')
      await codex.turn.start({ threadId, text: value, approvalPolicy: APPROVAL_POLICY })
      await loadCodexThread(threadId)
      await refreshSessions(threadId)
    } catch (error) {
      setComposer(value)
      setNotice(`发送失败：${errorMessage(error)}`)
    } finally {
      setSending(false)
    }
  }, [composer, createSession, loadCodexThread, refreshSessions, sending])

  const renameSelected = useCallback(async () => {
    if (!selected || !renameTitle.trim()) return
    try {
      if (selected.provider === 'codex') {
        const codex = zero3Window().zero3Codex
        if (!codex?.thread.setName) throw new Error('当前 Codex bridge 尚未暴露 thread/name/set')
        await codex.thread.setName({ threadId: selected.id, name: renameTitle.trim() })
      } else {
        if (!zero3Window().zero3Workspace) throw new Error('Workspace bridge 不可用')
        await zero3Window().zero3Workspace?.rename({ id: selected.id, title: renameTitle.trim() })
      }
      await refreshSessions(selected.id)
    } catch (error) {
      setNotice(`重命名失败：${errorMessage(error)}`)
    }
  }, [refreshSessions, renameTitle, selected])

  const removeSelected = useCallback(async () => {
    if (!selected || !window.confirm(`确定删除“${selected.title}”吗？`)) return
    try {
      if (selected.provider === 'codex') {
        const codex = zero3Window().zero3Codex
        if (!codex?.thread.delete) throw new Error('当前 Codex bridge 尚未暴露 thread/delete')
        await codex.thread.delete({ threadId: selected.id })
      } else if (selected.provider === 'gpt') {
        await zero3Window().zero3GptWeb?.remove({ id: selected.id })
      } else {
        await zero3Window().zero3GeminiWeb?.remove({ id: selected.id })
      }
      setSelectedId(null)
      await hideWebSurface()
      await refreshSessions(null)
    } catch (error) {
      setNotice(`删除失败：${errorMessage(error)}`)
    }
  }, [hideWebSurface, refreshSessions, selected])

  useEffect(() => { void refreshSessions() }, [refreshSessions])

  useEffect(() => {
    if (!selectedId || activeProvider !== 'codex') {
      setCodexThread(null)
      return
    }
    void hideWebSurface()
    void loadCodexThread(selectedId)
  }, [activeProvider, hideWebSurface, loadCodexThread, selectedId])

  useEffect(() => {
    if (!selectedId || activeProvider === 'codex') return
    const frame = window.requestAnimationFrame(() => void showWebSurface(activeProvider, selectedId))
    return () => window.cancelAnimationFrame(frame)
  }, [activeProvider, selectedId, showWebSurface])

  useEffect(() => {
    if (!selectedId || activeProvider === 'codex') return
    const provider = activeProvider
    const id = selectedId
    const bridge = provider === 'gpt' ? zero3Window().zero3GptWeb : zero3Window().zero3GeminiWeb
    if (!bridge) return
    const update = () => {
      const bounds = surfaceBounds(webHostRef.current)
      if (bounds) void bridge.setBounds({ id, bounds })
    }
    const observer = typeof ResizeObserver === 'undefined' || !webHostRef.current ? null : new ResizeObserver(update)
    if (observer && webHostRef.current) observer.observe(webHostRef.current)
    window.addEventListener('resize', update)
    update()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [activeProvider, propertiesOpen, selectedId])

  useEffect(() => {
    const codex = zero3Window().zero3Codex
    if (!codex) return
    return codex.onEvent(event => {
      if (event.kind === 'lifecycle') {
        if (event.state === 'error') setNotice(event.detail || 'Codex app-server 异常')
        return
      }
      if (event.kind === 'request') {
        const params = record(event.params)
        const method = event.method
        const supported = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'item/tool/requestUserInput'
        if (supported) {
          setPendingPrompt({ id: event.id, method, params })
        } else {
          void codex.respondToServerRequest({ id: event.id, error: { code: -32001, message: `Zero3 three-column renderer does not support server request ${method}` } })
        }
        return
      }
      const params = record(event.params)
      const threadId = text(params.threadId)
      if (activeProviderRef.current !== 'codex') return
      if (threadId && threadId !== selectedIdRef.current) return
      const detail = text(params.itemId) ?? text(params.turnId) ?? ''
      setRuntimeEvents(current => [...current.slice(-31), { key: `${Date.now()}-${event.method}-${Math.random()}`, label: event.method, detail }])
      if (refreshTimerRef.current != null) window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = window.setTimeout(() => {
        const currentId = selectedIdRef.current
        if (currentId) void loadCodexThread(currentId)
      }, 90)
    })
  }, [loadCodexThread])

  useEffect(() => {
    const refresh = () => void refreshSessions(selectedIdRef.current)
    const disposers = [zero3Window().zero3GptWeb?.onEvent(refresh), zero3Window().zero3GeminiWeb?.onEvent(refresh)].filter(Boolean) as Array<() => void>
    return () => disposers.forEach(dispose => dispose())
  }, [refreshSessions])

  useEffect(() => () => {
    if (refreshTimerRef.current != null) window.clearTimeout(refreshTimerRef.current)
    void hideWebSurface()
  }, [hideWebSurface])

  const selectedWorkspace = selected && selected.provider !== 'codex' ? (selected.raw as WorkspaceEntry) : null
  const threadBusy = codexThread ? codexStatus(codexThread) === '执行中' : false

  return (
    <div className="zero3-app" data-zero3-owned-renderer="three-column-v1">
      <header className="titlebar">
        <div className="titlebar-brand"><span className="brand-mini">Z</span><strong>Zero3 Pilot</strong></div>
        <div className="titlebar-search no-drag"><Icon name="search" /><input aria-label="全局搜索" onChange={event => setQuery(event.target.value)} placeholder="搜索或跳转到…" value={query} /></div>
      </header>

      <div className="app-grid">
        <aside className="rail">
          <button aria-label="工作台" className="rail-logo" onClick={() => { setFilter('all'); setQuery('') }} type="button">Z</button>
          <button aria-label="会话工作台" className="rail-button active" type="button"><Icon name="chat" /></button>
          <button aria-label="刷新真实数据" className="rail-button" disabled={loading} onClick={() => void refreshSessions(selectedId)} type="button"><Icon name="refresh" /></button>
          <div className="rail-spacer" />
          <button aria-label="显示属性面板" className={`rail-button ${propertiesOpen ? 'active' : ''}`} onClick={() => setPropertiesOpen(value => !value)} type="button"><Icon name="settings" /></button>
        </aside>

        <aside className="session-column">
          <div className="column-heading"><h1>工作台</h1></div>
          <div className="session-tools">
            <label className="session-search"><Icon name="search" /><input onChange={event => setQuery(event.target.value)} placeholder="搜索会话" value={query} /></label>
            <div className="new-wrap">
              <button aria-label="新建会话" className="square-button" onClick={() => setNewMenu(open => !open)} type="button"><Icon name="plus" /></button>
              {newMenu ? <div className="new-menu">{PROVIDERS.map(provider => <button key={provider.id} onClick={() => void createSession(provider.id)} type="button"><ProviderBadge provider={provider.id} /><span><strong>{provider.label}</strong><small>{provider.id === 'codex' ? '本地 Codex app-server' : provider.id === 'gpt' ? 'ChatGPT 网页会话' : 'Gemini 网页会话'}</small></span></button>)}</div> : null}
            </div>
          </div>
          <div className="filters">
            {(['all', 'codex', 'gpt', 'gemini'] as ProviderFilter[]).map(value => <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)} type="button">{value === 'all' ? '全部' : providerLabel(value)}</button>)}
          </div>
          <div className="session-list">
            {filteredSessions.length ? filteredSessions.map(row => (
              <button className={`session-row ${selectedId === row.id ? 'selected' : ''}`} key={`${row.provider}:${row.id}`} onClick={() => selectSession(row)} type="button">
                <ProviderBadge provider={row.provider} />
                <span className="session-copy"><span className="session-title"><strong>{row.title}</strong><time>{relativeTime(row.sortKey)}</time></span><span className="session-subtitle">{row.subtitle}</span><span className="session-status"><i className={row.status === '异常' ? 'danger' : row.status === '执行中' ? 'running' : ''} />{row.status}</span></span>
              </button>
            )) : <div className="empty-list">{loading ? '正在读取真实会话…' : '没有匹配的会话'}</div>}
          </div>
        </aside>

        <main className={`workspace ${propertiesOpen ? 'with-properties' : ''}`}>
          <section className="workspace-main">
            <div className="workspace-heading">
              <div className="workspace-tabs"><span className="workspace-label">主工作区</span>{PROVIDERS.map(provider => <button className={activeProvider === provider.id ? 'active' : ''} key={provider.id} onClick={() => chooseProviderTab(provider.id)} type="button">{provider.id}</button>)}</div>
              <button className="panel-toggle" onClick={() => setPropertiesOpen(value => !value)} type="button"><Icon name="panel" />{propertiesOpen ? '隐藏属性面板' : '显示属性面板'}</button>
            </div>

            {notice ? <div className="notice"><span>{notice}</span><button onClick={() => setNotice(null)} type="button">×</button></div> : null}

            {activeProvider === 'codex' ? (
              <>
                <div className="content-scroll"><ThreadTimeline events={runtimeEvents} thread={codexThread} /></div>
                <div className="composer-area">
                  <div className="composer-meta"><span>模式：Codex Local</span><span>· workspace-write</span><span>· 按需审批</span>{threadBusy ? <strong>正在执行</strong> : null}</div>
                  <div className="composer-box">
                    <textarea aria-label="给 Codex 发送消息" disabled={sending} onChange={event => setComposer(event.target.value)} onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void sendCodex()
                      }
                    }} placeholder="给 Codex 发送消息…" value={composer} />
                    <button aria-label="发送" className="send-button" disabled={sending || !composer.trim()} onClick={() => void sendCodex()} type="button"><Icon name="send" /></button>
                  </div>
                </div>
              </>
            ) : selectedId ? (
              <div className="web-workspace">
                <div className="web-host" data-zero3-web-host ref={webHostRef}><div className="web-placeholder"><ProviderBadge provider={activeProvider} /><strong>正在连接 {providerLabel(activeProvider)} Web…</strong><span>网页内容由隔离的 Electron WebContentsView 直接呈现，不经过模拟数据。</span></div></div>
              </div>
            ) : (
              <div className="provider-empty"><ProviderBadge provider={activeProvider} /><h2>还没有 {providerLabel(activeProvider)} 会话</h2><p>创建后会直接接入真实 Provider。</p><button className="button primary" onClick={() => void createSession(activeProvider)} type="button">新建 {providerLabel(activeProvider)} 会话</button></div>
            )}
          </section>

          {propertiesOpen ? (
            <aside className="properties-panel">
              <div className="properties-head"><h2>属性</h2><button onClick={() => setPropertiesOpen(false)} type="button">×</button></div>
              {selected ? <div className="properties-body">
                <div className="property-provider"><ProviderBadge provider={selected.provider} /><div><strong>{providerLabel(selected.provider)}</strong><span>{selected.status}</span></div></div>
                <label className="property-field"><span>会话名称</span><input onChange={event => setRenameTitle(event.target.value)} value={renameTitle} /></label>
                <button className="button secondary wide" onClick={() => void renameSelected()} type="button">保存名称</button>
                <dl className="property-list"><div><dt>ID</dt><dd>{selected.id}</dd></div><div><dt>来源</dt><dd>{selected.provider === 'codex' ? 'open-source Codex app-server' : selected.provider === 'gpt' ? 'ChatGPT WebContentsView' : 'Gemini WebContentsView'}</dd></div>{selectedWorkspace?.projectId ? <div><dt>项目</dt><dd>{selectedWorkspace.projectId}</dd></div> : null}{selectedWorkspace?.conversationUrl ? <div><dt>会话地址</dt><dd>{selectedWorkspace.conversationUrl}</dd></div> : null}</dl>
                {selected.provider !== 'codex' ? <div className="property-actions"><button className="button secondary" onClick={() => void (selected.provider === 'gpt' ? zero3Window().zero3GptWeb : zero3Window().zero3GeminiWeb)?.reload({ id: selected.id })} type="button"><Icon name="reload" />刷新网页</button><button className="button secondary" onClick={() => void (selected.provider === 'gpt' ? zero3Window().zero3GptWeb : zero3Window().zero3GeminiWeb)?.openExternal({ id: selected.id })} type="button"><Icon name="external" />外部打开</button></div> : null}
                <button className="button danger-button wide" onClick={() => void removeSelected()} type="button"><Icon name="trash" />删除会话</button>
              </div> : <div className="empty-detail">未选择会话。</div>}
            </aside>
          ) : null}
        </main>
      </div>

      {pendingPrompt ? <PromptOverlay onClose={() => setPendingPrompt(null)} prompt={pendingPrompt} /> : null}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

type Provider = 'codex' | 'gpt' | 'gemini'
type ListFilter = 'all' | Provider

type JsonRecord = Record<string, unknown>

type RuntimeRow = {
  id: string
  provider: Provider
  title: string
  subtitle: string
  status: string
  updatedAt: number
  raw: JsonRecord
}

type TimelineItem = {
  id: string
  kind: 'user' | 'assistant' | 'reasoning' | 'command' | 'file' | 'tool' | 'plan' | 'search' | 'status' | 'error'
  title?: string
  text: string
  state?: string
}

type PendingCodexRequest = {
  id: number | string
  method: string
  params: JsonRecord
}

type CoreStatus = {
  running: boolean
  initialized: boolean
  pid: number | null
  stderrTail: string | null
}

type ModelSelection = {
  provider: 'deepseek' | 'glm' | 'ollama'
  model: string
}

const MODEL_STORAGE_KEY = 'zero3.ollama.selected-model'
const UI_STATE_STORAGE_KEY = 'zero3.three-column-ui.v1'

const runtime = window as Window & Record<string, any>

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function errorMessage(error: unknown, fallback = '操作失败'): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  const message = text(record(error).message)
  return message || fallback
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function secondsToMs(value: unknown): number {
  const raw = number(value)
  if (!raw) return 0
  return raw < 10_000_000_000 ? raw * 1000 : raw
}

function formatClock(value: number): string {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
  } catch {
    return ''
  }
}

function displayTitleFromWorkspace(entry: JsonRecord): string {
  return (
    text(entry.localDisplayTitle) ||
    text(entry.pageTitle) ||
    (entry.kind === 'gemini_web' ? 'Gemini 会话' : 'GPT 会话')
  )
}

function loadModelSelection(): ModelSelection | null {
  try {
    const stored = window.localStorage.getItem(MODEL_STORAGE_KEY)?.trim() ?? ''
    if (!stored) return null
    if (!stored.startsWith('{')) return { provider: 'ollama', model: stored }
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const provider = parsed.provider
    const model = text(parsed.model)
    if ((provider === 'deepseek' || provider === 'glm' || provider === 'ollama') && model) {
      return { provider, model }
    }
  } catch {}
  return null
}

function persistModelSelection(selection: ModelSelection | null): void {
  try {
    if (selection) window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(selection))
    else window.localStorage.removeItem(MODEL_STORAGE_KEY)
  } catch {}
}

function loadUiState(): {
  activeId: string | null
  filter: ListFilter
  propertiesOpen: boolean
  sandbox: string
  approvalPolicy: string
  cwd: string
} {
  try {
    const stored = window.localStorage.getItem(UI_STATE_STORAGE_KEY)
    if (stored) {
      const value = JSON.parse(stored) as Record<string, unknown>
      const filter = value.filter
      return {
        activeId: text(value.activeId) || null,
        filter: filter === 'codex' || filter === 'gpt' || filter === 'gemini' ? filter : 'all',
        propertiesOpen: value.propertiesOpen !== false,
        sandbox: text(value.sandbox) || 'danger-full-access',
        approvalPolicy: text(value.approvalPolicy) || 'never',
        cwd: text(value.cwd)
      }
    }
  } catch {}
  return {
    activeId: null,
    filter: 'all',
    propertiesOpen: true,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    cwd: ''
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      const item = record(part)
      return text(item.text) || text(item.content)
    })
    .filter(Boolean)
    .join('\n')
}

function reasoningText(item: JsonRecord): string {
  const direct = text(item.text) || text(item.summary)
  if (direct) return direct
  if (Array.isArray(item.summary)) {
    return item.summary
      .map(value => {
        const part = record(value)
        return text(part.text) || text(part.summary)
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function commandText(item: JsonRecord): string {
  const command = Array.isArray(item.command) ? item.command.map(String).join(' ') : text(item.command)
  const output = text(item.aggregatedOutput) || text(item.output) || text(item.stdout) || text(item.stderr)
  return [command, output].filter(Boolean).join('\n\n')
}

function fileChangeText(item: JsonRecord): string {
  const changes = item.changes
  if (Array.isArray(changes)) {
    return changes
      .map(change => {
        const value = record(change)
        const path = text(value.path) || text(value.filePath)
        const kind = text(value.kind) || text(value.type)
        const diff = text(value.diff)
        return [kind && path ? `${kind}: ${path}` : path || kind, diff].filter(Boolean).join('\n')
      })
      .filter(Boolean)
      .join('\n\n')
  }
  return pretty(changes || item)
}

function itemToTimeline(raw: unknown, turnId: string, index: number): TimelineItem | null {
  const item = record(raw)
  const type = text(item.type)
  const id = text(item.id) || `${turnId}-item-${index}`
  const state = text(item.status) || undefined

  if (type === 'userMessage') {
    const value = contentText(item.content)
    return value ? { id, kind: 'user', text: value, state } : null
  }
  if (type === 'agentMessage') {
    const value = text(item.text) || contentText(item.content)
    return value || state === 'inProgress' ? { id, kind: 'assistant', text: value, state } : null
  }
  if (type === 'reasoning') {
    const value = reasoningText(item)
    return value ? { id, kind: 'reasoning', title: '推理摘要', text: value, state } : null
  }
  if (type === 'commandExecution') {
    const value = commandText(item)
    return { id, kind: 'command', title: '命令执行', text: value || '正在执行命令…', state }
  }
  if (type === 'fileChange') {
    return { id, kind: 'file', title: '文件修改', text: fileChangeText(item), state }
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const name = text(item.tool) || text(item.name) || text(item.server)
    const body = item.result ?? item.output ?? item.arguments ?? item.input
    return { id, kind: 'tool', title: name ? `工具 · ${name}` : '工具调用', text: pretty(body), state }
  }
  if (type === 'plan') {
    return { id, kind: 'plan', title: '执行计划', text: pretty(item.plan ?? item.items ?? item), state }
  }
  if (type === 'webSearch') {
    return { id, kind: 'search', title: '网页搜索', text: text(item.query) || pretty(item), state }
  }

  if (!type) return null
  return { id, kind: 'tool', title: type, text: pretty(item), state }
}

function timelineFromThread(value: unknown): TimelineItem[] {
  const response = record(value)
  const thread = record(response.thread ?? response)
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const result: TimelineItem[] = []
  turns.forEach((rawTurn, turnIndex) => {
    const turn = record(rawTurn)
    const turnId = text(turn.id) || `turn-${turnIndex}`
    const items = Array.isArray(turn.items) ? turn.items : []
    items.forEach((item, itemIndex) => {
      const mapped = itemToTimeline(item, turnId, itemIndex)
      if (mapped) result.push(mapped)
    })
    const turnError = record(turn.error)
    const message = text(turnError.message)
    if (message) result.push({ id: `${turnId}-error`, kind: 'error', title: 'Turn 错误', text: message })
  })
  return result
}

function threadFromResponse(value: unknown): JsonRecord {
  const response = record(value)
  return record(response.thread ?? response)
}

function turnIdFromEvent(params: JsonRecord): string | null {
  return text(params.turnId) || text(record(params.turn).id) || null
}

function threadIdFromEvent(params: JsonRecord): string | null {
  return text(params.threadId) || text(record(params.thread).id) || null
}

function upsertTimeline(items: TimelineItem[], incoming: TimelineItem, appendDelta = false): TimelineItem[] {
  const index = items.findIndex(item => item.id === incoming.id)
  if (index < 0) return [...items, incoming]
  const next = [...items]
  const previous = next[index]
  next[index] = {
    ...previous,
    ...incoming,
    text: appendDelta ? previous.text + incoming.text : incoming.text || previous.text
  }
  return next
}

function providerLabel(provider: Provider): string {
  if (provider === 'codex') return 'Codex 本地'
  if (provider === 'gpt') return 'GPT 网页'
  return 'Gemini 网页'
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const paths: Record<string, ReactNode> = {
    chat: <><path d="M4 5h16v11H8l-4 3V5Z"/><path d="M8 9h8M8 12h5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></>,
    stop: <rect x="7" y="7" width="10" height="10" rx="1"/>,
    send: <><path d="m4 4 17 8-17 8 3-8-3-8Z"/><path d="M7 12h14"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 9A7 7 0 0 1 18 6l2 6M18 15a7 7 0 0 1-12 3l-2-6"/></>,
    external: <><path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M18 13v6H5V6h6"/></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,
    cpu: <><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></>,
    spark: <><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z"/></>,
    chevron: <path d="m9 7 5 5-5 5"/>,
    trash: <><path d="M4 7h16"/><path d="M9 7V4h6v3M7 7l1 13h8l1-13"/></>
  }
  return <svg {...common}>{paths[name] ?? paths.chat}</svg>
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="z3-empty"><div className="z3-empty-mark">Z</div><strong>{title}</strong><span>{detail}</span>{action}</div>
}

function CodexRequestCard({ request, onDone }: { request: PendingCodexRequest; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const params = request.params
  const questions = Array.isArray(params.questions) ? params.questions.map(record) : []
  const approval = request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval'

  const respond = async (result: unknown, error?: unknown) => {
    if (busy) return
    setBusy(true)
    try {
      await runtime.zero3Codex.respondToServerRequest(error ? { id: request.id, error } : { id: request.id, result })
      onDone()
    } catch {
      setBusy(false)
    }
  }

  if (approval) {
    const detail = text(params.command) || text(params.grantRoot) || text(params.reason) || 'Codex 请求继续执行当前操作。'
    return <div className="z3-request-card"><div><b>{request.method.includes('fileChange') ? '需要文件修改授权' : '需要命令执行授权'}</b><p>{detail}</p></div><div className="z3-request-actions"><button disabled={busy} onClick={() => void respond({ decision: 'decline' })}>拒绝</button><button disabled={busy} onClick={() => void respond({ decision: 'acceptForSession' })}>本会话允许</button><button className="primary" disabled={busy} onClick={() => void respond({ decision: 'accept' })}>仅本次允许</button></div></div>
  }

  if (request.method === 'item/tool/requestUserInput' && questions.length > 0) {
    const complete = questions.every(question => text(answers[text(question.id)]))
    return <div className="z3-request-card"><div><b>Codex 需要你的输入</b><p>回答会直接返回当前 app-server Turn。</p></div><div className="z3-question-list">{questions.map((question, index) => {
      const id = text(question.id) || `q-${index}`
      const options = Array.isArray(question.options) ? question.options.map(record) : []
      return <label key={id}><span>{text(question.header) || text(question.question) || `问题 ${index + 1}`}</span>{text(question.header) && text(question.question) ? <small>{text(question.question)}</small> : null}{options.length ? <select value={answers[id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [id]: event.target.value }))}><option value="">请选择</option>{options.map((option, optionIndex) => <option key={`${id}-${optionIndex}`} value={text(option.label)}>{text(option.label)}{text(option.description) ? ` — ${text(option.description)}` : ''}</option>)}</select> : <input type={question.isSecret === true ? 'password' : 'text'} value={answers[id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [id]: event.target.value }))} />}</label>
    })}</div><div className="z3-request-actions"><button disabled={busy} onClick={() => void respond(null, { code: -32002, message: 'User cancelled the Codex request_user_input prompt.' })}>取消</button><button className="primary" disabled={busy || !complete} onClick={() => void respond({ answers: Object.fromEntries(questions.map((question, index) => { const id = text(question.id) || `q-${index}`; return [id, { answers: [answers[id]?.trim() ?? ''] }] })) })}>继续</button></div></div>
  }

  return <div className="z3-request-card"><div><b>Codex 请求确认</b><pre>{pretty({ method: request.method, params })}</pre></div><div className="z3-request-actions"><button disabled={busy} onClick={() => void respond(null, { code: -32002, message: 'Unsupported request declined by user.' })}>拒绝</button></div></div>
}

export function Zero3Shell() {
  const initial = useMemo(loadUiState, [])
  const [filter, setFilter] = useState<ListFilter>(initial.filter)
  const [query, setQuery] = useState('')
  const [propertiesOpen, setPropertiesOpen] = useState(initial.propertiesOpen)
  const [rows, setRows] = useState<RuntimeRow[]>([])
  const [activeId, setActiveId] = useState<string | null>(initial.activeId)
  const [activeProvider, setActiveProvider] = useState<Provider>('codex')
  const [activeThread, setActiveThread] = useState<JsonRecord>({})
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [composer, setComposer] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingRequest, setPendingRequest] = useState<PendingCodexRequest | null>(null)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [coreStatus, setCoreStatus] = useState<CoreStatus>({ running: false, initialized: false, pid: null, stderrTail: null })
  const [workspaceEvents, setWorkspaceEvents] = useState<Record<string, string>>({})
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(() => loadModelSelection())
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [sandbox, setSandbox] = useState(initial.sandbox)
  const [approvalPolicy, setApprovalPolicy] = useState(initial.approvalPolicy)
  const [cwd, setCwd] = useState(initial.cwd)
  const [modelProviderDraft, setModelProviderDraft] = useState<ModelSelection['provider']>(modelSelection?.provider ?? 'ollama')
  const [modelDraft, setModelDraft] = useState(modelSelection?.model ?? '')
  const webHostRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const activeIdRef = useRef<string | null>(activeId)
  const activeProviderRef = useRef<Provider>(activeProvider)

  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => { activeProviderRef.current = activeProvider }, [activeProvider])

  useEffect(() => {
    try {
      window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify({ activeId, filter, propertiesOpen, sandbox, approvalPolicy, cwd }))
    } catch {}
  }, [activeId, filter, propertiesOpen, sandbox, approvalPolicy, cwd])

  const refreshRows = useCallback(async () => {
    const next: RuntimeRow[] = []
    const failures: string[] = []

    if (runtime.zero3Codex) {
      try {
        await runtime.zero3Codex.start()
        const status = record(await runtime.zero3Codex.status())
        setCoreStatus({
          running: status.running === true,
          initialized: status.initialized === true,
          pid: typeof status.pid === 'number' ? status.pid : null,
          stderrTail: text(status.stderrTail) || null
        })
        const response = record(await runtime.zero3Codex.thread.list({ archived: false, limit: 100 }))
        const threads = Array.isArray(response.data) ? response.data.map(record) : []
        threads.filter(thread => text(thread.id) && thread.parentThreadId == null && thread.ephemeral !== true).forEach(thread => {
          const title = text(thread.name) || text(thread.preview) || '新 Codex 会话'
          const updatedAt = secondsToMs(thread.recencyAt || thread.updatedAt || thread.createdAt)
          next.push({
            id: text(thread.id),
            provider: 'codex',
            title,
            subtitle: text(thread.cwd) || 'Codex 本地',
            status: record(thread.status).type === 'active' ? '执行中' : '待命',
            updatedAt,
            raw: thread
          })
        })
      } catch (cause) {
        failures.push(`Codex: ${errorMessage(cause)}`)
      }
    } else failures.push('Codex: preload bridge 未加载')

    if (runtime.zero3Workspace) {
      try {
        const entries = await runtime.zero3Workspace.list()
        if (Array.isArray(entries)) {
          entries.map(record).forEach(entry => {
            if (!text(entry.id)) return
            const provider: Provider | null = entry.kind === 'gpt_web' ? 'gpt' : entry.kind === 'gemini_web' ? 'gemini' : null
            if (!provider) return
            next.push({
              id: text(entry.id),
              provider,
              title: displayTitleFromWorkspace(entry),
              subtitle: provider === 'gpt' ? 'ChatGPT Web' : 'Gemini Web',
              status: workspaceEvents[text(entry.id)] || '待命',
              updatedAt: Date.parse(text(entry.lastActiveAt) || text(entry.createdAt)) || 0,
              raw: entry
            })
          })
        }
      } catch (cause) {
        failures.push(`Web 会话: ${errorMessage(cause)}`)
      }
    }

    next.sort((a, b) => b.updatedAt - a.updatedAt)
    setRows(next)
    setError(failures.length ? failures.join('；') : null)
    setLoading(false)
    return next
  }, [workspaceEvents])

  const loadCodexThread = useCallback(async (id: string) => {
    if (!runtime.zero3Codex) return
    setBusy(true)
    try {
      const model = modelSelection?.model
      const modelProvider = modelSelection?.provider
      const resumeRequest: JsonRecord = { threadId: id, approvalPolicy, sandbox }
      if (cwd.trim()) resumeRequest.cwd = cwd.trim()
      if (model) resumeRequest.model = model
      if (modelProvider) resumeRequest.modelProvider = modelProvider
      await runtime.zero3Codex.thread.resume(resumeRequest)
      const response = await runtime.zero3Codex.thread.read({ threadId: id, includeTurns: true })
      const thread = threadFromResponse(response)
      setActiveThread(thread)
      setTimeline(timelineFromThread(response))
      const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : []
      const live = [...turns].reverse().find(turn => turn.status === 'inProgress' && text(turn.id))
      setActiveTurnId(live ? text(live.id) : null)
      setBusy(Boolean(live))
      if (!cwd.trim() && text(thread.cwd)) setCwd(text(thread.cwd))
    } catch (cause) {
      setError(errorMessage(cause, 'Codex 会话加载失败'))
      setBusy(false)
    }
  }, [approvalPolicy, cwd, modelSelection, sandbox])

  const hideWebViews = useCallback(async (except?: Provider) => {
    const id = activeIdRef.current
    const provider = activeProviderRef.current
    if (!id || provider === 'codex' || provider === except) return
    const bridge = provider === 'gpt' ? runtime.zero3GptWeb : runtime.zero3GeminiWeb
    try { await bridge?.hide?.({ id }) } catch {}
  }, [])

  const showWebView = useCallback(async (provider: 'gpt' | 'gemini', id: string) => {
    const host = webHostRef.current
    const bridge = provider === 'gpt' ? runtime.zero3GptWeb : runtime.zero3GeminiWeb
    if (!host || !bridge) {
      setError(`${providerLabel(provider)} bridge 未加载`)
      return
    }
    const rect = host.getBoundingClientRect()
    const bounds = {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
    try {
      await bridge.show({ id, bounds })
    } catch (cause) {
      setError(errorMessage(cause, `${providerLabel(provider)} 显示失败`))
    }
  }, [])

  const selectRow = useCallback(async (row: RuntimeRow) => {
    await hideWebViews()
    setActiveId(row.id)
    setActiveProvider(row.provider)
    setPendingRequest(null)
    setError(null)
    if (row.provider === 'codex') {
      await loadCodexThread(row.id)
      return
    }
    setTimeline([])
    setActiveThread(row.raw)
    requestAnimationFrame(() => void showWebView(row.provider, row.id))
  }, [hideWebViews, loadCodexThread, showWebView])

  const createSession = useCallback(async (provider: Provider = activeProvider) => {
    setError(null)
    try {
      if (provider === 'codex') {
        const request: JsonRecord = { approvalPolicy, sandbox }
        if (cwd.trim()) request.cwd = cwd.trim()
        if (modelSelection?.model) request.model = modelSelection.model
        if (modelSelection?.provider) request.modelProvider = modelSelection.provider
        const response = await runtime.zero3Codex.thread.start(request)
        const thread = threadFromResponse(response)
        const id = text(thread.id)
        if (!id) throw new Error('thread/start 未返回 Thread ID')
        setActiveId(id)
        setActiveProvider('codex')
        setActiveThread(thread)
        setTimeline(timelineFromThread(response))
        await refreshRows()
        return id
      }

      const bridge = provider === 'gpt' ? runtime.zero3GptWeb : runtime.zero3GeminiWeb
      if (!bridge) throw new Error(`${providerLabel(provider)} bridge 未加载`)
      const entry = record(await bridge.create({ projectId: null }))
      const id = text(entry.id)
      if (!id) throw new Error('创建 Web 会话后未返回 ID')
      await hideWebViews()
      setActiveId(id)
      setActiveProvider(provider)
      setActiveThread(entry)
      await refreshRows()
      requestAnimationFrame(() => void showWebView(provider, id))
      return id
    } catch (cause) {
      setError(errorMessage(cause, '创建会话失败'))
      return null
    }
  }, [activeProvider, approvalPolicy, cwd, hideWebViews, modelSelection, refreshRows, sandbox, showWebView])

  const sendCodex = useCallback(async (event?: FormEvent) => {
    event?.preventDefault()
    const value = composer.trim()
    if (!value || busy) return
    let threadId = activeProvider === 'codex' ? activeId : null
    if (!threadId) threadId = await createSession('codex')
    if (!threadId) return

    setComposer('')
    setBusy(true)
    setTimeline(current => [...current, { id: `local-user-${Date.now()}`, kind: 'user', text: value }])
    try {
      const request: JsonRecord = { threadId, text: value, approvalPolicy }
      if (cwd.trim()) request.cwd = cwd.trim()
      if (modelSelection?.model) request.model = modelSelection.model
      const response = record(await runtime.zero3Codex.turn.start(request))
      const turn = record(response.turn)
      if (text(turn.id)) setActiveTurnId(text(turn.id))
      await refreshRows()
    } catch (cause) {
      setBusy(false)
      setTimeline(current => [...current, { id: `send-error-${Date.now()}`, kind: 'error', title: '发送失败', text: errorMessage(cause) }])
    }
  }, [activeId, activeProvider, approvalPolicy, busy, composer, createSession, cwd, modelSelection, refreshRows])

  const interrupt = useCallback(async () => {
    if (!activeId || !activeTurnId || activeProvider !== 'codex') return
    try {
      await runtime.zero3Codex.turn.interrupt({ threadId: activeId, turnId: activeTurnId })
    } catch (cause) {
      setError(errorMessage(cause, '停止 Turn 失败'))
    }
  }, [activeId, activeProvider, activeTurnId])

  useEffect(() => {
    void refreshRows().then(next => {
      if (!next.length) return
      const remembered = initial.activeId ? next.find(row => row.id === initial.activeId) : undefined
      const chosen = remembered ?? next[0]
      void selectRow(chosen)
    })
  }, [])

  useEffect(() => {
    if (!runtime.zero3Codex?.onEvent) return
    return runtime.zero3Codex.onEvent((event: any) => {
      const envelope = record(event)
      if (envelope.kind === 'lifecycle') {
        const state = text(envelope.state)
        setCoreStatus(current => ({ ...current, running: state === 'started' ? true : state === 'stopped' || state === 'error' ? false : current.running }))
        if (state === 'error') setError(text(envelope.detail) || 'Codex app-server 发生错误')
        return
      }
      if (envelope.kind === 'request') {
        const params = record(envelope.params)
        const eventThread = threadIdFromEvent(params)
        if (!eventThread || eventThread === activeIdRef.current) setPendingRequest({ id: envelope.id as string | number, method: text(envelope.method), params })
        return
      }
      if (envelope.kind !== 'notification') return
      const method = text(envelope.method)
      const params = record(envelope.params)
      const eventThread = threadIdFromEvent(params)
      const currentId = activeIdRef.current
      if (eventThread && currentId && eventThread !== currentId) {
        if (method === 'turn/completed' || method === 'thread/started') void refreshRows()
        return
      }

      if (method === 'turn/started') {
        setBusy(true)
        setActiveTurnId(turnIdFromEvent(params))
        return
      }
      if (method === 'turn/completed' || method === 'turn/failed' || method === 'turn/interrupted') {
        setBusy(false)
        setActiveTurnId(null)
        setPendingRequest(null)
        const id = currentId
        if (id && activeProviderRef.current === 'codex') void loadCodexThread(id)
        void refreshRows()
        return
      }

      const item = record(params.item)
      const itemId = text(params.itemId) || text(item.id)
      const itemType = text(item.type)
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (method.includes('agentMessage') && delta && itemId) {
        setTimeline(current => upsertTimeline(current, { id: itemId, kind: 'assistant', text: delta, state: 'inProgress' }, true))
        return
      }
      if (method.includes('reasoning') && delta && itemId) {
        setTimeline(current => upsertTimeline(current, { id: itemId, kind: 'reasoning', title: '推理摘要', text: delta, state: 'inProgress' }, true))
        return
      }
      if (method.includes('commandExecution') && delta && itemId) {
        setTimeline(current => upsertTimeline(current, { id: itemId, kind: 'command', title: '命令执行', text: delta, state: 'inProgress' }, true))
        return
      }
      if ((method === 'item/started' || method === 'item/completed') && (itemType || itemId)) {
        const mapped = itemToTimeline(item, turnIdFromEvent(params) || 'live', 0)
        if (mapped) setTimeline(current => upsertTimeline(current, mapped))
      }
    })
  }, [loadCodexThread, refreshRows])

  useEffect(() => {
    const subscriptions: Array<() => void> = []
    const bind = (bridge: any, provider: Provider) => {
      if (!bridge?.onEvent) return
      const unsubscribe = bridge.onEvent((event: any) => {
        const value = record(event)
        const id = text(value.entryId)
        if (!id) return
        if (value.kind === 'state') {
          const state = text(value.state)
          setWorkspaceEvents(current => ({ ...current, [id]: state === 'ready' ? '就绪' : state === 'loading' ? '加载中' : state === 'shown' ? '已显示' : state === 'error' ? '错误' : state }))
          if (state === 'error') setError(text(value.detail) || `${providerLabel(provider)} 发生错误`)
        }
        if (value.kind === 'navigation') void refreshRows()
      })
      if (typeof unsubscribe === 'function') subscriptions.push(unsubscribe)
    }
    bind(runtime.zero3GptWeb, 'gpt')
    bind(runtime.zero3GeminiWeb, 'gemini')
    return () => subscriptions.forEach(unsubscribe => unsubscribe())
  }, [refreshRows])

  useEffect(() => {
    if (activeProvider === 'codex' || !activeId || !webHostRef.current) return
    const host = webHostRef.current
    const bridge = activeProvider === 'gpt' ? runtime.zero3GptWeb : runtime.zero3GeminiWeb
    if (!bridge) return
    const update = () => {
      const rect = host.getBoundingClientRect()
      const bounds = { x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.top)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) }
      void bridge.setBounds({ id: activeId, bounds }).catch(() => {})
    }
    const observer = new ResizeObserver(update)
    observer.observe(host)
    window.addEventListener('resize', update)
    update()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [activeId, activeProvider, propertiesOpen])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape' && busy && activeProviderRef.current === 'codex') void interrupt()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, interrupt])

  useEffect(() => {
    if (!runtime.zero3Codex?.ollama?.listModels) return
    void runtime.zero3Codex.ollama.listModels().then((response: any) => {
      const models = Array.isArray(record(response).models) ? (record(response).models as unknown[]).map(record).map(model => text(model.name)).filter(Boolean) : []
      setOllamaModels(models)
    }).catch(() => {})
  }, [])

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter(row => (filter === 'all' || row.provider === filter) && (!needle || `${row.title} ${row.subtitle} ${row.id}`.toLowerCase().includes(needle)))
  }, [filter, query, rows])

  const activeRow = rows.find(row => row.id === activeId) ?? null

  const saveModel = () => {
    const model = modelDraft.trim()
    const selection = model ? { provider: modelProviderDraft, model } as ModelSelection : null
    setModelSelection(selection)
    persistModelSelection(selection)
  }

  const webAction = async (action: 'reload' | 'external' | 'suspend') => {
    if (!activeId || activeProvider === 'codex') return
    const bridge = activeProvider === 'gpt' ? runtime.zero3GptWeb : runtime.zero3GeminiWeb
    try {
      if (action === 'reload') await bridge.reload({ id: activeId })
      if (action === 'external') await bridge.openExternal({ id: activeId })
      if (action === 'suspend') await bridge.suspend({ id: activeId })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return <div className="z3-app">
    <header className="z3-titlebar"><div className="z3-title">Zero3 Pilot</div><button className="z3-jump" onClick={() => searchRef.current?.focus()}>搜索或跳转… <kbd>Ctrl K</kbd></button></header>

    <aside className="z3-rail">
      <button className="z3-logo" onClick={() => setFilter('all')} aria-label="Zero3 Pilot">Z</button>
      <nav>
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')} title="全部会话"><Icon name="chat" /></button>
        <button className={filter === 'codex' ? 'active' : ''} onClick={() => setFilter('codex')} title="Codex 本地"><Icon name="cpu" /></button>
        <button className={filter === 'gpt' ? 'active' : ''} onClick={() => setFilter('gpt')} title="GPT 网页"><Icon name="globe" /></button>
        <button className={filter === 'gemini' ? 'active' : ''} onClick={() => setFilter('gemini')} title="Gemini 网页"><Icon name="spark" /></button>
      </nav>
      <div className="z3-rail-bottom"><span className={`z3-core-dot ${coreStatus.running ? 'ok' : 'off'}`} title={coreStatus.running ? `Codex PID ${coreStatus.pid ?? '-'}` : 'Codex 未运行'} /><button onClick={() => setPropertiesOpen(value => !value)} title="属性面板"><Icon name="settings" /></button></div>
    </aside>

    <aside className="z3-sidebar">
      <div className="z3-sidebar-head"><span>工作台</span><button onClick={() => void createSession(filter === 'all' ? activeProvider : filter)} aria-label="新建会话"><Icon name="plus" size={22} /></button></div>
      <div className="z3-search"><Icon name="search" size={18} /><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话" /></div>
      <div className="z3-filters"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button><button className={filter === 'codex' ? 'active' : ''} onClick={() => setFilter('codex')}>Codex</button><button className={filter === 'gpt' ? 'active' : ''} onClick={() => setFilter('gpt')}>GPT</button><button className={filter === 'gemini' ? 'active' : ''} onClick={() => setFilter('gemini')}>Gemini</button></div>
      <div className="z3-session-list">{loading ? <div className="z3-list-note">正在读取真实会话…</div> : visibleRows.length ? visibleRows.map(row => <button key={`${row.provider}:${row.id}`} className={`z3-session ${activeId === row.id ? 'active' : ''}`} onClick={() => void selectRow(row)}><div className="z3-session-title"><span className={`z3-provider-dot ${row.provider}`} /> <b>{row.title}</b><time>{formatClock(row.updatedAt)}</time></div><div className="z3-session-sub">{row.subtitle}</div><div className="z3-session-status"><span className={row.status.includes('执行') || row.status.includes('加载') ? 'busy' : ''} />{row.status}</div></button>) : <div className="z3-list-note">没有匹配的真实会话</div>}</div>
    </aside>

    <main className="z3-main">
      <div className="z3-workbar"><div><strong>主工作区</strong><div className="z3-provider-tabs"><button className={activeProvider === 'codex' ? 'active' : ''} onClick={() => { const row = rows.find(value => value.provider === 'codex'); if (row) void selectRow(row); else void createSession('codex') }}>codex</button><button className={activeProvider === 'gpt' ? 'active' : ''} onClick={() => { const row = rows.find(value => value.provider === 'gpt'); if (row) void selectRow(row); else void createSession('gpt') }}>gpt</button><button className={activeProvider === 'gemini' ? 'active' : ''} onClick={() => { const row = rows.find(value => value.provider === 'gemini'); if (row) void selectRow(row); else void createSession('gemini') }}>gemini</button></div></div><button className="z3-panel-toggle" onClick={() => setPropertiesOpen(value => !value)}><Icon name="panel" size={17} />{propertiesOpen ? '隐藏属性面板' : '显示属性面板'}</button></div>

      {error ? <div className="z3-error-banner"><span>{error}</span><button onClick={() => { setError(null); void refreshRows() }}>重试</button></div> : null}

      <div className={`z3-workspace ${propertiesOpen ? 'with-properties' : ''}`}>
        <section className="z3-center">
          {activeProvider === 'codex' ? <>
            <div className="z3-thread-head"><div className="z3-avatar codex"><Icon name="cpu" size={18} /></div><div><strong>{activeRow?.title || 'Codex 本地'}</strong><span>{activeId ? `Thread · ${activeId.slice(0, 12)}…` : '尚未创建 Thread'}</span></div><div className={`z3-live ${busy ? 'busy' : ''}`}>{busy ? '执行中' : coreStatus.running ? '已连接' : '未连接'}</div></div>
            <div className="z3-timeline">{timeline.length ? timeline.map(item => <article key={item.id} className={`z3-item ${item.kind}`}><div className="z3-item-meta"><span>{item.kind === 'user' ? '用户' : item.kind === 'assistant' ? 'Codex' : item.title || item.kind}</span>{item.state ? <em>{item.state}</em> : null}</div>{item.title && item.kind !== 'user' && item.kind !== 'assistant' ? <h4>{item.title}</h4> : null}<pre>{item.text || (item.state === 'inProgress' ? '处理中…' : '')}</pre></article>) : <EmptyState title="真实 Codex 工作区" detail="这里不再显示演示卡片。新建 Thread 或发送第一条消息后，会直接显示 app-server 的 Turn / Item / 工具事件。" action={<button className="z3-primary-action" onClick={() => void createSession('codex')}>新建 Codex Thread</button>} />}</div>
            {pendingRequest ? <CodexRequestCard request={pendingRequest} onDone={() => setPendingRequest(null)} /> : null}
            <form className="z3-composer" onSubmit={sendCodex}><div className="z3-mode">模式: Codex Local · {modelSelection ? `${modelSelection.provider}/${modelSelection.model}` : '默认模型'}</div><div className="z3-compose-row"><textarea value={composer} onChange={event => setComposer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendCodex() } }} placeholder="给 Codex 发送消息…" /><button type="button" className="stop" disabled={!busy || !activeTurnId} onClick={() => void interrupt()} title="停止 Turn"><Icon name="stop" /></button><button type="submit" className="send" disabled={!composer.trim() || busy} title="发送"><Icon name="send" /></button></div></form>
          </> : <div className="z3-web-shell"><div className="z3-web-toolbar"><div><span className={`z3-provider-dot ${activeProvider}`} /><strong>{activeRow?.title || providerLabel(activeProvider)}</strong><small>{activeProvider === 'gpt' ? 'ChatGPT.com 持久会话' : 'Gemini 持久会话'}</small></div><div><button onClick={() => void webAction('reload')} title="刷新"><Icon name="refresh" size={17} /></button><button onClick={() => void webAction('external')} title="在浏览器打开"><Icon name="external" size={17} /></button></div></div><div className="z3-web-host" ref={webHostRef}><span>正在挂载真实 {providerLabel(activeProvider)} WebContentsView…</span></div></div>}
        </section>

        {propertiesOpen ? <aside className="z3-properties"><div className="z3-properties-title">属性</div><section><h4>当前会话</h4><dl><dt>来源</dt><dd>{providerLabel(activeProvider)}</dd><dt>ID</dt><dd className="mono">{activeId || '未创建'}</dd><dt>状态</dt><dd>{activeRow?.status || (busy ? '执行中' : '待命')}</dd></dl></section>{activeProvider === 'codex' ? <><section><h4>执行环境</h4><label>工作目录<input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="默认使用 ZERO3_CODEX_CWD" /></label><label>Sandbox<select value={sandbox} onChange={event => setSandbox(event.target.value)}><option value="danger-full-access">danger-full-access</option><option value="workspace-write">workspace-write</option><option value="read-only">read-only</option></select></label><label>审批策略<select value={approvalPolicy} onChange={event => setApprovalPolicy(event.target.value)}><option value="never">never</option><option value="on-request">on-request</option><option value="untrusted">untrusted</option></select></label></section><section><h4>模型</h4><label>Provider<select value={modelProviderDraft} onChange={event => setModelProviderDraft(event.target.value as ModelSelection['provider'])}><option value="ollama">Ollama 本地</option><option value="deepseek">DeepSeek</option><option value="glm">GLM</option></select></label><label>Model{modelProviderDraft === 'ollama' && ollamaModels.length ? <select value={modelDraft} onChange={event => setModelDraft(event.target.value)}><option value="">默认模型</option>{ollamaModels.map(model => <option key={model} value={model}>{model}</option>)}</select> : <input value={modelDraft} onChange={event => setModelDraft(event.target.value)} placeholder="留空使用 Codex 默认模型" />}</label><div className="z3-inline-actions"><button onClick={() => { setModelDraft(''); setModelSelection(null); persistModelSelection(null) }}>清除</button><button className="primary" onClick={saveModel}>应用</button></div></section><section><h4>Codex Core</h4><dl><dt>运行</dt><dd>{coreStatus.running ? '是' : '否'}</dd><dt>初始化</dt><dd>{coreStatus.initialized ? '是' : '否'}</dd><dt>PID</dt><dd>{coreStatus.pid ?? '-'}</dd></dl>{coreStatus.stderrTail ? <pre className="z3-stderr">{coreStatus.stderrTail}</pre> : null}</section></> : <section><h4>Web 会话</h4><div className="z3-stack-actions"><button onClick={() => void webAction('reload')}><Icon name="refresh" size={16} />刷新页面</button><button onClick={() => void webAction('external')}><Icon name="external" size={16} />浏览器打开</button><button onClick={() => void webAction('suspend')}><Icon name="stop" size={16} />挂起 WebContentsView</button></div></section>}</aside> : null}
      </div>
    </main>
  </div>
}

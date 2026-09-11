type Bridge = Window['zero3Codex']
type Event = Parameters<Bridge['onEvent']>[0] extends (event: infer E) => void ? E : never
export type InstallRequest = Extract<Event, { kind: 'request' }>
export type InstallSnapshot = {
  status: 'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'interrupted'
  threadId: string | null
  turnId: string | null
  source: string
  destination: string
  output: string
  error: string | null
  requests: InstallRequest[]
}
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}

// One controller per renderer keeps the live installation and approval requests
// reachable when the user switches modules. No Skill files or registry are copied.
export class SkillInstallController {
  private snapshot: InstallSnapshot = { status: 'idle', threadId: null, turnId: null, source: '', destination: '', output: '', error: null, requests: [] }
  private listeners = new Set<() => void>()
  private disconnect: (() => void) | null = null
  private earlyEvents: Event[] = []
  private streamedItems = new Set<string>()
  constructor(private bridge: Bridge) {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(value: Partial<InstallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value }
    for (const listener of this.listeners) listener()
  }
  private finish(status: InstallSnapshot['status'], error: string | null = null) {
    this.earlyEvents = []
    this.update({ status, error, requests: [] })
    this.disconnect?.()
    this.disconnect = null
  }
  private receive = (event: Event) => {
    if (event.kind === 'lifecycle') {
      if (event.state === 'stopped' || event.state === 'error') this.finish('failed', event.detail || 'Codex 连接已断开，请重新安装。')
      return
    }
    if (!this.snapshot.threadId) { this.earlyEvents.push(event); return }
    const params = record(event.params)
    if (params.threadId !== this.snapshot.threadId) return
    if (event.kind === 'request') {
      this.update({ requests: [...this.snapshot.requests.filter(request => request.id !== event.id), event] })
      return
    }
    if (event.method === 'serverRequest/resolved') {
      this.update({ requests: this.snapshot.requests.filter(request => request.id !== params.requestId) })
    } else if (event.method === 'turn/started') {
      this.update({ turnId: record(params.turn).id ?? this.snapshot.turnId })
    } else if (event.method === 'item/agentMessage/delta' || event.method === 'item/commandExecution/outputDelta') {
      if (typeof params.itemId === 'string') this.streamedItems.add(params.itemId)
      this.update({ output: (this.snapshot.output + String(params.delta ?? '')).slice(-32_000) })
    } else if (event.method === 'item/completed') {
      const item = record(params.item)
      if (item.type === 'agentMessage' && !this.streamedItems.has(item.id) && typeof item.text === 'string') {
        this.update({ output: (this.snapshot.output + '\n' + item.text).slice(-32_000) })
      }
    } else if (event.method === 'item/started') {
      const item = record(params.item)
      if (item.type === 'commandExecution') this.update({ output: (this.snapshot.output + '\n$ ' + String(item.command ?? '') + '\n').slice(-32_000) })
    } else if (event.method === 'error' && !params.willRetry) {
      this.finish('failed', record(params.error).message || '安装任务执行失败')
    } else if (event.method === 'turn/completed') {
      const turn = record(params.turn)
      this.finish(turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed', record(turn.error).message ?? null)
      // A successful Turn means the installer finished speaking, not necessarily
      // that a Skill was installed. UI exposes its actual report and live catalog.
      void this.bridge.skills.list({ forceReload: true }).catch(() => {})
    }
  }
  async install(source: string, cwd?: string | null) {
    if (['starting', 'running'].includes(this.snapshot.status)) return
    const value = source.trim()
    if (!value || value.length > 4096) throw new Error('安装来源须为 1–4096 个字符')
    this.earlyEvents = []
    this.streamedItems.clear()
    this.update({ status: 'starting', source: value, destination: '', threadId: null, turnId: null, output: '', error: null, requests: [] })
    this.disconnect = this.bridge.onEvent(this.receive)
    try {
      const result = await this.bridge.skills.install({ source: value, ...(cwd ? { cwd } : {}) })
      // Lifecycle failure may have arrived before the RPC response.
      if (this.snapshot.status !== 'starting') return
      this.update({ status: 'running', threadId: result.threadId, destination: result.destination, turnId: record(record(result.turn).turn).id ?? null })
      const events = this.earlyEvents
      this.earlyEvents = []
      for (const event of events) {
        if (this.getSnapshot().status !== 'running') break
        this.receive(event)
      }
      const turn = record(record(result.turn).turn)
      if (this.getSnapshot().status === 'running' && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
        this.receive({ kind: 'notification', method: 'turn/completed', params: { threadId: result.threadId, turn } })
      }
    } catch (error) {
      this.earlyEvents = []
      this.finish('failed', error instanceof Error ? error.message : String(error))
    }
  }
  async respond(request: InstallRequest, result: unknown) {
    await this.bridge.respondToServerRequest({ id: request.id, result })
    this.update({ requests: this.snapshot.requests.filter(item => item.id !== request.id) })
  }
  async reject(request: InstallRequest) {
    await this.bridge.respondToServerRequest({ id: request.id, error: { code: -32002, message: 'User declined this installer request' } })
    this.update({ requests: this.snapshot.requests.filter(item => item.id !== request.id) })
  }
  async cancel() {
    const { threadId, turnId } = this.snapshot
    if (!threadId || !turnId || this.snapshot.status !== 'running') return
    await Promise.allSettled(this.snapshot.requests.map(request => this.reject(request)))
    await this.bridge.turn.interrupt({ threadId, turnId })
    this.finish('interrupted')
  }
}

let controller: SkillInstallController | undefined
export function skillInstallController() {
  return controller ??= new SkillInstallController(window.zero3Codex)
}

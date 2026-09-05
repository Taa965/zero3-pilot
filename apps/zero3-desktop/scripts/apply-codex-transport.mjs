import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')

  for (const replacement of replacements) {
    if (replacement.appliedMarkers?.every(marker => source.includes(marker))) continue
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Codex transport drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source changed; review the R1 transport overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const mainTransport = String.raw`
type Zero3CodexRpcId = number | string

type Zero3CodexPendingRequest = {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timer: NodeJS.Timeout
}

type Zero3CodexEvent =
  | { kind: 'lifecycle'; state: 'started' | 'stopped' | 'error'; detail?: string }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: Zero3CodexRpcId; method: string; params: unknown }

type Zero3CodexEventListener = (event: Zero3CodexEvent) => void

type Zero3CodexAppServerOptions = {
  env?: NodeJS.ProcessEnv
  cwd?: string
}

const ZERO3_CODEX_REQUEST_TIMEOUT_MS = 30_000
const ZERO3_CODEX_TURN_TIMEOUT_MS = 10 * 60_000
const ZERO3_CODEX_MAX_LINE_BYTES = 8 * 1024 * 1024
const ZERO3_CODEX_MAX_REPLY_BYTES = 256 * 1024
const ZERO3_CODEX_MAX_SERVER_REQUESTS = 128
const ZERO3_OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags'
const ZERO3_OLLAMA_LIST_TIMEOUT_MS = 5_000

function zero3CodexRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function zero3CodexRequiredString(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(label + ' is required and must be at most ' + String(max) + ' characters')
  return text
}

function zero3CodexOptionalString(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(label + ' must be a string')
  const text = value.trim()
  if (!text || text.length > max) throw new Error(label + ' must be at most ' + String(max) + ' characters')
  return text
}

function zero3CodexOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value == null) return undefined
  if (typeof value !== 'boolean') throw new Error(label + ' must be a boolean')
  return value
}

function zero3CodexOptionalPositiveInt(value: unknown, label: string, max: number): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(label + ' must be an integer between 1 and ' + String(max))
  }
  return value
}

function zero3CodexApprovalPolicy(value: unknown): string | undefined {
  const policy = zero3CodexOptionalString(value, 'approvalPolicy', 32)
  if (policy == null) return undefined
  if (!['untrusted', 'on-request', 'never'].includes(policy)) {
    throw new Error('approvalPolicy must be untrusted, on-request, or never')
  }
  return policy
}

function zero3CodexSandbox(value: unknown): string | undefined {
  const sandbox = zero3CodexOptionalString(value, 'sandbox', 32)
  if (sandbox == null) return undefined
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
    throw new Error('sandbox must be read-only, workspace-write, or danger-full-access')
  }
  return sandbox
}

function zero3CodexIdKey(id: Zero3CodexRpcId): string {
  return typeof id + ':' + String(id)
}

function zero3CodexErrorMessage(value: unknown): string {
  const error = zero3CodexRecord(value)
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  const code = typeof error.code === 'number' || typeof error.code === 'string' ? String(error.code) : ''
  return message ? (code ? '[' + code + '] ' + message : message) : 'Codex app-server returned an unknown error'
}

type Zero3OllamaModel = {
  aliasCount: number
  name: string
  sizeBytes: number | null
  modifiedAt: string | null
}

function zero3OllamaModels(value: unknown): Zero3OllamaModel[] {
  const input = zero3CodexRecord(value)
  const rawModels = Array.isArray(input.models) ? input.models : []
  const byDigest = new Map<string, Zero3OllamaModel>()

  for (const rawModel of rawModels) {
    const model = zero3CodexRecord(rawModel)
    const name = typeof model.name === 'string' ? model.name.trim() : ''
    const digest = typeof model.digest === 'string' ? model.digest.trim() : ''
    const remoteModel = typeof model.remote_model === 'string' ? model.remote_model.trim() : ''
    const capabilities = Array.isArray(model.capabilities) ? model.capabilities : []
    const supportsCompletion = capabilities.some(capability => capability === 'completion')
    // The local tags endpoint includes cloud entries, embedding-only entries and aliases that
    // share a digest. The desktop model picker must offer only a distinct local
    // chat-capable model, not every manifest label in the local store.
    if (!name || name.length > 256 || !digest || digest.length > 128 || remoteModel || !supportsCompletion) continue
    const sizeBytes = typeof model.size === 'number' && Number.isFinite(model.size) && model.size >= 0 ? model.size : null
    const modifiedAt = typeof model.modified_at === 'string' && model.modified_at.length <= 128 ? model.modified_at : null
    const current = byDigest.get(digest)
    if (!current) {
      byDigest.set(digest, { aliasCount: 1, name, sizeBytes, modifiedAt })
      continue
    }

    current.aliasCount += 1
    const currentIsBackup = current.name.includes('.bak.')
    const candidateIsBackup = name.includes('.bak.')
    const currentIsNamespaceAlias = current.name.includes('/')
    const candidateIsNamespaceAlias = name.includes('/')
    if ((currentIsBackup && !candidateIsBackup) || (currentIsNamespaceAlias && !candidateIsNamespaceAlias)) {
      current.name = name
      current.sizeBytes = sizeBytes
      current.modifiedAt = modifiedAt
    }
  }

  return [...byDigest.values()]
}

async function zero3ListOllamaModels(): Promise<{ models: Zero3OllamaModel[]; provider: 'ollama' }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ZERO3_OLLAMA_LIST_TIMEOUT_MS)
  try {
    const response = await fetch(ZERO3_OLLAMA_TAGS_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error('Ollama 本机模型服务返回 HTTP ' + String(response.status))
    return { models: zero3OllamaModels(await response.json()), provider: 'ollama' }
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message.trim() : '未知错误'
    throw new Error('无法读取 Ollama 本机模型列表：' + message)
  } finally {
    clearTimeout(timeout)
  }
}

const ZERO3_GLM_ADAPTER_HOST = '127.0.0.1'
const ZERO3_GLM_ADAPTER_PORT = 8788
const ZERO3_GLM_CHAT_COMPLETIONS_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const ZERO3_GLM_MAX_BODY_BYTES = 8 * 1024 * 1024
const ZERO3_GLM_REQUEST_TIMEOUT_MS = 10 * 60_000

function zero3GlmText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(part => {
      const item = zero3CodexRecord(part)
      return typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : ''
    })
    .filter(Boolean)
    .join('\n')
}

function zero3GlmToolOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return zero3GlmText(value)
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function zero3GlmMessageContent(value: unknown): Array<Record<string, unknown>> {
  const content = Array.isArray(value) ? value : typeof value === 'string' ? [{ type: 'input_text', text: value }] : []
  const converted: Array<Record<string, unknown>> = []
  for (const rawPart of content) {
    const part = zero3CodexRecord(rawPart)
    const type = typeof part.type === 'string' ? part.type : ''
    if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof part.text === 'string') {
      converted.push({ type: 'text', text: part.text })
      continue
    }
    if ((type === 'input_image' || type === 'image_url') && typeof part.image_url === 'string') {
      converted.push({ type: 'image_url', image_url: { url: part.image_url } })
    }
  }
  return converted
}

function zero3GlmRole(value: unknown): 'assistant' | 'system' | 'tool' | 'user' {
  // GLM Chat Completions accepts only these four roles. Codex emits developer
  // messages for its instruction layer, which have the same precedence intent as
  // GLM system role and must never be forwarded verbatim.
  if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') return value
  return value === 'developer' ? 'system' : 'user'
}

function zero3GlmMessages(input: unknown, instructions: unknown): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  if (typeof instructions === 'string' && instructions.trim()) messages.push({ role: 'system', content: instructions })
  const items = Array.isArray(input) ? input : typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : []
  for (const rawItem of items) {
    const item = zero3CodexRecord(rawItem)
    const type = typeof item.type === 'string' ? item.type : 'message'
    if (type === 'message') {
      const content = zero3GlmMessageContent(item.content)
      if (content.length) messages.push({ role: zero3GlmRole(item.role), content })
      continue
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      const name = typeof item.name === 'string' ? item.name : ''
      const callId = typeof item.call_id === 'string' ? item.call_id : ''
      const argumentsText = typeof item.arguments === 'string' ? item.arguments : typeof item.input === 'string' ? item.input : '{}'
      if (name && callId) {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name, arguments: argumentsText } }]
        })
      }
      continue
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'mcp_tool_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : ''
      if (callId) messages.push({ role: 'tool', tool_call_id: callId, content: zero3GlmToolOutput(item.output) })
    }
  }
  return messages
}

function zero3GlmTools(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  const tools: Array<Record<string, unknown>> = []
  for (const rawTool of value) {
    const tool = zero3CodexRecord(rawTool)
    if (tool.type !== 'function') continue
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (!name) continue
    const description = typeof tool.description === 'string' ? tool.description : ''
    const parameters = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} }
    tools.push({ type: 'function', function: { name, description, parameters } })
  }
  return tools
}

function zero3GlmResponseUsage(value: unknown) {
  const usage = zero3CodexRecord(value)
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : inputTokens + outputTokens
  return {
    input_tokens: inputTokens,
    input_tokens_details: null,
    output_tokens: outputTokens,
    output_tokens_details: null,
    total_tokens: totalTokens
  }
}

function zero3GlmResponseItems(value: unknown): Array<Record<string, unknown>> {
  const payload = zero3CodexRecord(value)
  const choice = Array.isArray(payload.choices) ? zero3CodexRecord(payload.choices[0]) : {}
  const message = zero3CodexRecord(choice.message)
  const items: Array<Record<string, unknown>> = []
  const text = zero3GlmText(message.content)
  if (text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const rawToolCall of toolCalls) {
    const toolCall = zero3CodexRecord(rawToolCall)
    const functionValue = zero3CodexRecord(toolCall.function)
    const name = typeof functionValue.name === 'string' ? functionValue.name : ''
    const callId = typeof toolCall.id === 'string' ? toolCall.id : ''
    const argumentsText = typeof functionValue.arguments === 'string' ? functionValue.arguments : '{}'
    if (name && callId) items.push({ type: 'function_call', call_id: callId, name, arguments: argumentsText })
  }
  return items
}

function zero3GlmSseEvent(kind: string, payload: Record<string, unknown>): string {
  return 'event: ' + kind + '\ndata: ' + JSON.stringify({ type: kind, ...payload }) + '\n\n'
}

async function zero3GlmReadJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > ZERO3_GLM_MAX_BODY_BYTES) throw new Error('GLM 适配请求超过大小限制')
    chunks.push(buffer)
  }
  try {
    return zero3CodexRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch {
    throw new Error('GLM 适配请求不是有效 JSON')
  }
}

class Zero3GlmResponsesAdapter {
  private server: http.Server | null = null
  private starting: Promise<void> | null = null
  private sequence = 0

  async ensureStarted() {
    if (this.server?.listening) return
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handle(request, response)
      })
      const fail = (error: Error) => {
        server.close()
        reject(new Error('无法启动 GLM 本机适配器：' + error.message))
      }
      server.once('error', fail)
      server.listen(ZERO3_GLM_ADAPTER_PORT, ZERO3_GLM_ADAPTER_HOST, () => {
        server.removeListener('error', fail)
        this.server = server
        resolve()
      })
    })
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  stop() {
    const server = this.server
    this.server = null
    if (server?.listening) server.close()
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const requestUrl = new URL(request.url ?? '/', 'http://' + ZERO3_GLM_ADAPTER_HOST)
    if (request.method !== 'POST' || requestUrl.pathname !== '/v1/responses') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { message: 'Not found' } }))
      return
    }
    const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization.trim() : ''
    if (!authorization.startsWith('Bearer ') || authorization.length <= 7) {
      response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { message: 'GLM API key is required' } }))
      return
    }

    try {
      const body = await zero3GlmReadJson(request)
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      const messages = zero3GlmMessages(body.input, body.instructions)
      if (!model || !messages.length) throw new Error('GLM 请求必须包含模型和可转换的消息内容')
      const tools = zero3GlmTools(body.tools)
      const upstreamBody: Record<string, unknown> = {
        model,
        messages,
        stream: false,
        thinking: { type: 'enabled' }
      }
      if (tools.length) upstreamBody.tools = tools
      if (typeof body.temperature === 'number') upstreamBody.temperature = body.temperature
      if (typeof body.max_output_tokens === 'number') upstreamBody.max_tokens = body.max_output_tokens

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), ZERO3_GLM_REQUEST_TIMEOUT_MS)
      let upstream: Response
      try {
        upstream = await fetch(ZERO3_GLM_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(upstreamBody),
          signal: controller.signal
        })
      } finally {
        clearTimeout(timeout)
      }
      const rawResponse = await upstream.text()
      if (!upstream.ok) {
        response.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(rawResponse || JSON.stringify({ error: { message: 'GLM 请求失败' } }))
        return
      }
      const upstreamResponse = zero3CodexRecord(JSON.parse(rawResponse))
      const responseId = typeof upstreamResponse.id === 'string' ? upstreamResponse.id : 'glm-resp-' + String(++this.sequence)
      const items = zero3GlmResponseItems(upstreamResponse)
      const completed = { id: responseId, usage: zero3GlmResponseUsage(upstreamResponse.usage) }

      if (body.stream === true) {
        response.writeHead(200, {
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8'
        })
        response.write(zero3GlmSseEvent('response.created', { response: { id: responseId } }))
        for (const item of items) response.write(zero3GlmSseEvent('response.output_item.done', { item }))
        response.end(zero3GlmSseEvent('response.completed', { response: completed }))
        return
      }

      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ id: responseId, object: 'response', status: 'completed', output: items, usage: completed.usage }))
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'GLM 适配器内部错误'
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { message } }))
    }
  }
}

const zero3GlmResponsesAdapter = new Zero3GlmResponsesAdapter()

function broadcastZero3CodexEvent(event: Zero3CodexEvent) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('zero3:codex:event', event)
    }
  }
}

class Zero3CodexAppServer {
  private child: ReturnType<typeof spawn> | null = null
  private initialization: Record<string, unknown> | null = null
  private ready: Promise<Record<string, unknown>> | null = null
  private nextRequestId = 1
  private stdoutBuffer = ''
  private stderrTail = ''
  private pending = new Map<number, Zero3CodexPendingRequest>()
  private serverRequests = new Map<string, Zero3CodexRpcId>()
  private listeners = new Set<Zero3CodexEventListener>()
  private readonly launchEnv: NodeJS.ProcessEnv
  private readonly launchCwd?: string

  constructor(options: Zero3CodexAppServerOptions = {}) {
    this.launchEnv = options.env ?? process.env
    this.launchCwd = options.cwd?.trim() || undefined
  }

  subscribe(listener: Zero3CodexEventListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: Zero3CodexEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('Zero3 Codex app-server listener failed', error)
      }
    }
    broadcastZero3CodexEvent(event)
  }

  status() {
    return {
      core: 'openai-codex-app-server',
      running: this.child != null && this.child.exitCode == null && !this.child.killed,
      initialized: this.initialization != null,
      pid: this.child?.pid ?? null,
      codexHome: typeof this.initialization?.codexHome === 'string' ? this.initialization.codexHome : null,
      platformFamily:
        typeof this.initialization?.platformFamily === 'string' ? this.initialization.platformFamily : null,
      platformOs: typeof this.initialization?.platformOs === 'string' ? this.initialization.platformOs : null,
      pendingRequests: this.serverRequests.size,
      stderrTail: this.stderrTail || null
    }
  }

  async ensureStarted() {
    if (this.child && this.initialization) return this.status()
    if (this.ready) {
      await this.ready
      return this.status()
    }

    this.ready = this.start()
    try {
      await this.ready
      return this.status()
    } finally {
      this.ready = null
    }
  }

  private async start(): Promise<Record<string, unknown>> {
    const executable = this.launchEnv.ZERO3_CODEX_BIN?.trim()
    if (!executable) {
      throw new Error(
        'ZERO3_CODEX_BIN is not configured. Zero3 must launch the pinned open-source Codex build, not an implicit external Agent.'
      )
    }

    this.stop('restart')
    this.stdoutBuffer = ''
    this.stderrTail = ''
    const configuredCwd = this.launchCwd || this.launchEnv.ZERO3_CODEX_CWD?.trim()

    const child = spawn(executable, ['app-server', '--stdio'], {
      cwd: configuredCwd || process.cwd(),
      env: this.launchEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => this.consumeStdout(String(chunk)))
    child.stderr.on('data', chunk => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-32_768)
    })
    child.once('error', error => this.handleExit('spawn error: ' + error.message))
    child.once('exit', (code, signal) => {
      this.handleExit('exit code=' + String(code ?? 'null') + ' signal=' + String(signal ?? 'none'))
    })

    try {
      const result = await this.requestStarted(
        'initialize',
        {
          clientInfo: {
            name: 'zero3_pilot',
            title: 'Zero3 Pilot',
            version: app.getVersion()
          },
          capabilities: {
            experimentalApi: true
          }
        },
        ZERO3_CODEX_REQUEST_TIMEOUT_MS
      )
      this.initialization = zero3CodexRecord(result)
      this.writeLine({ method: 'initialized' })
      this.emit({ kind: 'lifecycle', state: 'started' })
      return this.initialization
    } catch (error) {
      this.stop(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  stop(detail = 'desktop shutdown') {
    const child = this.child
    this.child = null
    this.initialization = null
    this.serverRequests.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server stopped: ' + detail))
    }
    this.pending.clear()
    if (child && child.exitCode == null && !child.killed) child.kill()
  }

  private handleExit(detail: string) {
    if (!this.child && this.pending.size === 0) return
    this.child = null
    this.initialization = null
    this.serverRequests.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server stopped: ' + detail))
    }
    this.pending.clear()
    this.emit({ kind: 'lifecycle', state: 'stopped', detail })
  }

  private writeLine(message: unknown) {
    if (!this.child?.stdin || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error('Codex app-server stdin is unavailable')
    }
    const line = JSON.stringify(message)
    if (Buffer.byteLength(line, 'utf8') > ZERO3_CODEX_MAX_LINE_BYTES) {
      throw new Error('Codex app-server message exceeds the Zero3 transport limit')
    }
    this.child.stdin.write(line + '\n')
  }

  private consumeStdout(chunk: string) {
    this.stdoutBuffer += chunk
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > ZERO3_CODEX_MAX_LINE_BYTES * 2) {
      this.stop('stdout frame exceeded Zero3 transport limit')
      this.emit({
        kind: 'lifecycle',
        state: 'error',
        detail: 'Codex app-server stdout frame exceeded the Zero3 transport limit'
      })
      return
    }

    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.emit({
        kind: 'lifecycle',
        state: 'error',
        detail: 'Codex app-server emitted invalid JSONL'
      })
      return
    }

    const message = zero3CodexRecord(parsed)
    const id = message.id
    const hasId = typeof id === 'number' || typeof id === 'string'
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error')

    if (hasId && (hasResult || hasError) && typeof id === 'number') {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (hasError && message.error != null) pending.reject(new Error(zero3CodexErrorMessage(message.error)))
      else pending.resolve(message.result)
      return
    }

    const method = typeof message.method === 'string' ? message.method : ''
    if (!method) return

    if (hasId) {
      if (this.serverRequests.size >= ZERO3_CODEX_MAX_SERVER_REQUESTS) {
        this.stop('too many pending Codex server requests')
        this.emit({
          kind: 'lifecycle',
          state: 'error',
          detail: 'Codex app-server exceeded the pending server-request limit'
        })
        return
      }
      const rpcId = id as Zero3CodexRpcId
      this.serverRequests.set(zero3CodexIdKey(rpcId), rpcId)
      this.emit({
        kind: 'request',
        id: rpcId,
        method,
        params: message.params ?? null
      })
      return
    }

    this.emit({
      kind: 'notification',
      method,
      params: message.params ?? null
    })
  }

  private requestStarted(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex app-server request timed out: ' + method))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.writeLine({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async request(method: string, params: unknown, timeoutMs = ZERO3_CODEX_REQUEST_TIMEOUT_MS) {
    await this.ensureStarted()
    return this.requestStarted(method, params, timeoutMs)
  }

  async respondToServerRequest(value: unknown) {
    await this.ensureStarted()
    const payload = zero3CodexRecord(value)
    const id = payload.id
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('Codex server response id is invalid')
    const key = zero3CodexIdKey(id)
    if (!this.serverRequests.has(key)) throw new Error('Codex server request is not pending or was already answered')

    const hasResult = Object.prototype.hasOwnProperty.call(payload, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(payload, 'error')
    if (hasResult === hasError) throw new Error('Codex server response must contain exactly one of result or error')

    const response = hasResult ? { id, result: payload.result } : { id, error: payload.error }
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > ZERO3_CODEX_MAX_REPLY_BYTES) {
      throw new Error('Codex server response exceeds the Zero3 reply limit')
    }

    this.serverRequests.delete(key)
    this.writeLine(response)
    return { ok: true }
  }
}

function createZero3CodexAppServer(options: Zero3CodexAppServerOptions = {}) {
  return new Zero3CodexAppServer(options)
}

const zero3CodexAppServer = createZero3CodexAppServer()

function zero3CodexThreadStartParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const params: Record<string, unknown> = {}
  const cwd = zero3CodexOptionalString(input.cwd, 'cwd', 4096)
  const model = zero3CodexOptionalString(input.model, 'model', 256)
  const modelProvider = zero3CodexOptionalString(input.modelProvider, 'modelProvider', 128)
  const approvalPolicy = zero3CodexApprovalPolicy(input.approvalPolicy)
  const sandbox = zero3CodexSandbox(input.sandbox)
  const ephemeral = zero3CodexOptionalBoolean(input.ephemeral, 'ephemeral')
  if (cwd) params.cwd = cwd
  if (model) params.model = model
  if (modelProvider) params.modelProvider = modelProvider
  if (approvalPolicy) params.approvalPolicy = approvalPolicy
  if (sandbox) params.sandbox = sandbox
  if (ephemeral != null) params.ephemeral = ephemeral
  return params
}

function zero3CodexThreadResumeParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const params: Record<string, unknown> = {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256)
  }
  const cwd = zero3CodexOptionalString(input.cwd, 'cwd', 4096)
  const model = zero3CodexOptionalString(input.model, 'model', 256)
  const modelProvider = zero3CodexOptionalString(input.modelProvider, 'modelProvider', 128)
  const approvalPolicy = zero3CodexApprovalPolicy(input.approvalPolicy)
  const sandbox = zero3CodexSandbox(input.sandbox)
  if (cwd) params.cwd = cwd
  if (model) params.model = model
  if (modelProvider) params.modelProvider = modelProvider
  if (approvalPolicy) params.approvalPolicy = approvalPolicy
  if (sandbox) params.sandbox = sandbox
  return params
}

function zero3CodexThreadListParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const params: Record<string, unknown> = {}
  const cursor = zero3CodexOptionalString(input.cursor, 'cursor', 4096)
  const limit = zero3CodexOptionalPositiveInt(input.limit, 'limit', 100)
  const archived = zero3CodexOptionalBoolean(input.archived, 'archived')
  if (cursor) params.cursor = cursor
  if (limit != null) params.limit = limit
  if (archived != null) params.archived = archived
  return params
}

function zero3CodexThreadReadParams(value: unknown) {
  const input = zero3CodexRecord(value)
  return {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    includeTurns: zero3CodexOptionalBoolean(input.includeTurns, 'includeTurns') ?? true
  }
}

function zero3CodexTurnStartParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const text = zero3CodexRequiredString(input.text, 'text', 100_000)
  const params: Record<string, unknown> = {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    input: [{ type: 'text', text, textElements: [] }]
  }
  const cwd = zero3CodexOptionalString(input.cwd, 'cwd', 4096)
  const model = zero3CodexOptionalString(input.model, 'model', 256)
  const approvalPolicy = zero3CodexApprovalPolicy(input.approvalPolicy)
  if (cwd) params.cwd = cwd
  if (model) params.model = model
  if (approvalPolicy) params.approvalPolicy = approvalPolicy
  return params
}

function zero3CodexTurnInterruptParams(value: unknown) {
  const input = zero3CodexRecord(value)
  return {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    turnId: zero3CodexRequiredString(input.turnId, 'turnId', 256)
  }
}

ipcMain.handle('zero3:codex:status', () => zero3CodexAppServer.status())
ipcMain.handle('zero3:codex:start', () => zero3CodexAppServer.ensureStarted())
ipcMain.handle('zero3:ollama:list-models', () => zero3ListOllamaModels())
ipcMain.handle('zero3:codex:thread:start', async (_event, request: unknown) => {
  const params = zero3CodexThreadStartParams(request)
  if (params.modelProvider === 'glm') await zero3GlmResponsesAdapter.ensureStarted()
  return zero3CodexAppServer.request('thread/start', params)
})
ipcMain.handle('zero3:codex:thread:resume', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/resume', zero3CodexThreadResumeParams(request))
)
ipcMain.handle('zero3:codex:thread:list', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/list', zero3CodexThreadListParams(request))
)
ipcMain.handle('zero3:codex:thread:read', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/read', zero3CodexThreadReadParams(request))
)
ipcMain.handle('zero3:codex:turn:start', (_event, request: unknown) =>
  zero3CodexAppServer.request('turn/start', zero3CodexTurnStartParams(request), ZERO3_CODEX_TURN_TIMEOUT_MS)
)
ipcMain.handle('zero3:codex:turn:interrupt', (_event, request: unknown) =>
  zero3CodexAppServer.request('turn/interrupt', zero3CodexTurnInterruptParams(request))
)
ipcMain.handle('zero3:codex:server:respond', (_event, request: unknown) =>
  zero3CodexAppServer.respondToServerRequest(request)
)

app.on('before-quit', () => {
  zero3CodexAppServer.stop()
  zero3GlmResponsesAdapter.stop()
})
`

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3Codex', {
  status: () => ipcRenderer.invoke('zero3:codex:status'),
  start: () => ipcRenderer.invoke('zero3:codex:start'),
  ollama: {
    listModels: () => ipcRenderer.invoke('zero3:ollama:list-models')
  },
  thread: {
    start: request => ipcRenderer.invoke('zero3:codex:thread:start', request),
    resume: request => ipcRenderer.invoke('zero3:codex:thread:resume', request),
    list: request => ipcRenderer.invoke('zero3:codex:thread:list', request),
    read: request => ipcRenderer.invoke('zero3:codex:thread:read', request)
  },
  turn: {
    start: request => ipcRenderer.invoke('zero3:codex:turn:start', request),
    interrupt: request => ipcRenderer.invoke('zero3:codex:turn:interrupt', request)
  },
  respondToServerRequest: response => ipcRenderer.invoke('zero3:codex:server:respond', response),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('zero3:codex:event', listener)
    return () => ipcRenderer.removeListener('zero3:codex:event', listener)
  }
})

contextBridge.exposeInMainWorld('hermesDesktop', {`

const globalTypes = String.raw`interface Window {
    zero3Codex: {
      status: () => Promise<Zero3CodexStatus>
      start: () => Promise<Zero3CodexStatus>
      ollama: {
        listModels: () => Promise<Zero3OllamaModelsResponse>
      }
      thread: {
        start: (request?: Zero3CodexThreadStartRequest) => Promise<unknown>
        resume: (request: Zero3CodexThreadResumeRequest) => Promise<unknown>
        list: (request?: Zero3CodexThreadListRequest) => Promise<unknown>
        read: (request: Zero3CodexThreadReadRequest) => Promise<unknown>
      }
      turn: {
        start: (request: Zero3CodexTurnStartRequest) => Promise<unknown>
        interrupt: (request: Zero3CodexTurnInterruptRequest) => Promise<unknown>
      }
      respondToServerRequest: (response: Zero3CodexServerResponse) => Promise<{ ok: boolean }>
      onEvent: (callback: (event: Zero3CodexEvent) => void) => () => void
    }
    hermesDesktop:`

const globalTypeDefinitions = String.raw`
type Zero3CodexStatus = {
  core: 'openai-codex-app-server'
  running: boolean
  initialized: boolean
  pid: null | number
  codexHome: null | string
  platformFamily: null | string
  platformOs: null | string
  pendingRequests: number
  stderrTail: null | string
}

type Zero3CodexApprovalPolicy = 'never' | 'on-request' | 'untrusted'
type Zero3CodexSandbox = 'danger-full-access' | 'read-only' | 'workspace-write'

type Zero3OllamaModel = {
  aliasCount: number
  name: string
  sizeBytes: number | null
  modifiedAt: string | null
}

type Zero3OllamaModelsResponse = { models: Zero3OllamaModel[]; provider: 'ollama' }

type Zero3CodexThreadStartRequest = {
  approvalPolicy?: Zero3CodexApprovalPolicy
  cwd?: string
  ephemeral?: boolean
  model?: string
  modelProvider?: string
  sandbox?: Zero3CodexSandbox
}

type Zero3CodexThreadResumeRequest = {
  approvalPolicy?: Zero3CodexApprovalPolicy
  cwd?: string
  model?: string
  modelProvider?: string
  sandbox?: Zero3CodexSandbox
  threadId: string
}

type Zero3CodexThreadListRequest = { archived?: boolean; cursor?: string; limit?: number }
type Zero3CodexThreadReadRequest = { includeTurns?: boolean; threadId: string }

type Zero3CodexTurnStartRequest = {
  approvalPolicy?: Zero3CodexApprovalPolicy
  cwd?: string
  model?: string
  text: string
  threadId: string
}

type Zero3CodexTurnInterruptRequest = { threadId: string; turnId: string }
type Zero3CodexServerResponse =
  | { id: number | string; result: unknown; error?: never }
  | { id: number | string; error: unknown; result?: never }

type Zero3CodexEvent =
  | { kind: 'lifecycle'; state: 'started' | 'stopped' | 'error'; detail?: string }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: number | string; method: string; params: unknown }
`

export function applyZero3CodexTransport() {
  patchFile('electron/main.ts', [
    {
      label: 'Codex app-server transport before Hermes compatibility API',
      from: "ipcMain.handle('hermes:api', async (_event, request) => {",
      to: mainTransport + "\nipcMain.handle('hermes:api', async (_event, request) => {"
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'typed Zero3 Codex preload surface',
      from: "contextBridge.exposeInMainWorld('hermesDesktop', {",
      to: preloadBridge
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Zero3 Codex renderer type definitions',
      from: 'export {}\n\ndeclare global {',
      to: 'export {}\n' + globalTypeDefinitions + '\ndeclare global {',
      appliedMarkers: ['type Zero3CodexStatus = {', 'type Zero3CodexServerResponse =']
    },
    {
      label: 'Zero3 Codex window surface',
      from: 'interface Window {\n    hermesDesktop:',
      to: globalTypes,
      appliedMarkers: ['    zero3Codex: {', '      onEvent: (callback: (event: Zero3CodexEvent) => void) => () => void']
    }
  ])
}

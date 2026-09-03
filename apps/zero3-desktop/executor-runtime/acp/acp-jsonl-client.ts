import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type {
  AcpInitializeSnapshot,
  AcpJsonRecord,
  AcpJsonRpcId,
  AcpPermissionOption,
  AcpPermissionRequest,
  ResolvedAcpAdapter
} from './acp-types.ts'

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface QueueWaiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export type AcpInbound =
  | { type: 'session.update'; sessionId: string; update: AcpJsonRecord }
  | { type: 'permission.request'; request: AcpPermissionRequest }

export class AcpProcessCrashedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpProcessCrashedError'
  }
}

export class AcpTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpTransportError'
  }
}

function record(value: unknown): AcpJsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AcpJsonRecord : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value)
  if (!result) throw new AcpTransportError(`${label} must be non-empty`)
  return result
}

function rpcKey(id: AcpJsonRpcId): string {
  return `${typeof id}:${String(id)}`
}

function permissionOptions(value: unknown): AcpPermissionOption[] {
  if (!Array.isArray(value)) return []
  return value.map(record).flatMap(option => {
    const optionId = optionalString(option.optionId)
    if (!optionId) return []
    return [{ optionId, name: optionalString(option.name), kind: optionalString(option.kind) }]
  })
}

function permissionDescription(params: AcpJsonRecord): string {
  const toolCall = record(params.toolCall)
  const title = optionalString(toolCall.title)
  const name = optionalString(toolCall.name)
  const rawInput = toolCall.rawInput
  const details = rawInput == null ? '' : JSON.stringify(rawInput).slice(0, 2000)
  return [title ?? name ?? 'ACP permission request', details].filter(Boolean).join(' | ')
}

class AsyncQueue<T> {
  readonly #values: T[] = []
  readonly #waiters: QueueWaiter<T>[] = []
  #failed?: Error

  push(value: T): void {
    if (this.#failed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve(value)
    else this.#values.push(value)
  }

  next(): Promise<T> {
    if (this.#values.length) return Promise.resolve(this.#values.shift()!)
    if (this.#failed) return Promise.reject(this.#failed)
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }

  fail(error: Error): void {
    this.#failed = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
    this.#values.length = 0
  }
}

export class AcpJsonlClient {
  #inbound = new AsyncQueue<AcpInbound>()
  readonly #pending = new Map<number, PendingRequest>()
  readonly #permissions = new Map<string, { id: AcpJsonRpcId; request: AcpPermissionRequest }>()
  #child?: ChildProcessWithoutNullStreams
  #nextId = 1
  #buffer = ''
  #stderr = ''
  #initialized?: AcpInitializeSnapshot
  #starting?: Promise<AcpInitializeSnapshot>

  constructor(
    readonly adapter: ResolvedAcpAdapter,
    readonly requestTimeoutMs = 30_000
  ) {}

  initialized(): AcpInitializeSnapshot | undefined {
    return this.#initialized ? { ...this.#initialized } : undefined
  }

  async initialize(): Promise<AcpInitializeSnapshot> {
    if (this.#initialized && this.#child && this.#child.exitCode == null && !this.#child.killed) return { ...this.#initialized }
    if (this.#starting) return this.#starting
    this.#starting = this.startAndInitialize().finally(() => { this.#starting = undefined })
    return this.#starting
  }

  private async startAndInitialize(): Promise<AcpInitializeSnapshot> {
    this.stop('restart')
    this.#inbound = new AsyncQueue<AcpInbound>()
    this.#buffer = ''
    this.#stderr = ''
    const child = spawn(this.adapter.command, [...this.adapter.args], {
      cwd: this.adapter.cwd,
      env: this.adapter.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    })
    this.#child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => this.consume(String(chunk)))
    child.stderr.on('data', chunk => { this.#stderr = (this.#stderr + String(chunk)).slice(-16_000) })
    child.once('error', error => this.processExit(`spawn error: ${error.message}`))
    child.once('exit', (code, signal) => this.processExit(`exit code=${String(code)} signal=${String(signal)}`))

    const response = record(await this.requestStarted('initialize', {
      protocolVersion: 1,
      clientCapabilities: {}
    }))
    const protocolVersion = Number(response.protocolVersion)
    if (protocolVersion !== 1) {
      this.stop(`unsupported ACP protocol version ${String(response.protocolVersion)}`)
      throw new AcpTransportError('external adapter did not negotiate ACP v1')
    }
    const capabilities = record(response.agentCapabilities)
    const agentInfo = record(response.agentInfo)
    this.#initialized = {
      protocolVersion,
      loadSession: capabilities.loadSession === true,
      agentName: optionalString(agentInfo.name)
    }
    return { ...this.#initialized }
  }

  async request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    await this.initialize()
    return this.requestStarted(method, params, timeoutMs)
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  nextInbound(): Promise<AcpInbound> {
    return this.#inbound.next()
  }

  permission(requestKey: string): AcpPermissionRequest | undefined {
    const stored = this.#permissions.get(requestKey)?.request
    return stored ? { ...stored, options: stored.options.map(option => ({ ...option })) } : undefined
  }

  respondPermission(requestKey: string, optionId?: string): void {
    const stored = this.#permissions.get(requestKey)
    if (!stored) throw new AcpTransportError('ACP permission request is not pending')
    this.#permissions.delete(requestKey)
    this.write({
      jsonrpc: '2.0',
      id: stored.id,
      result: optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } }
    })
  }

  stop(detail = 'stopped'): void {
    const child = this.#child
    this.#child = undefined
    this.#initialized = undefined
    this.#permissions.clear()
    const error = new AcpProcessCrashedError(`ACP adapter stopped: ${detail}; ${this.#stderr.slice(-1000)}`)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    if (child && child.exitCode == null && !child.killed) child.kill()
  }

  private requestStarted(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new AcpTransportError(`ACP request timed out: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { method, resolve, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private write(message: unknown): void {
    const child = this.#child
    if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) throw new AcpTransportError('ACP adapter stdin is unavailable')
    const line = JSON.stringify(message)
    if (Buffer.byteLength(line, 'utf8') > 8 * 1024 * 1024) throw new AcpTransportError('ACP JSON-RPC message exceeds transport limit')
    child.stdin.write(`${line}\n`)
  }

  private consume(chunk: string): void {
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer, 'utf8') > 16 * 1024 * 1024) {
      this.stop('stdout frame exceeded transport limit')
      return
    }
    while (true) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      let message: AcpJsonRecord
      try {
        message = record(JSON.parse(line))
      } catch {
        this.stop('adapter emitted invalid JSONL')
        return
      }
      this.handleMessage(message)
    }
  }

  private handleMessage(message: AcpJsonRecord): void {
    const id = message.id
    const hasId = typeof id === 'number' || typeof id === 'string'
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error')
    if (typeof id === 'number' && (hasResult || hasError)) {
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      if (hasError && message.error != null) pending.reject(new AcpTransportError(`${pending.method} failed: ${JSON.stringify(message.error)}`))
      else pending.resolve(message.result)
      return
    }

    const method = optionalString(message.method)
    if (!method) return
    const params = record(message.params)
    if (hasId && method === 'session/request_permission') {
      const rpcId = id as AcpJsonRpcId
      const requestKey = rpcKey(rpcId)
      const request: AcpPermissionRequest = {
        rpcId,
        requestKey,
        sessionId: requiredString(params.sessionId, 'ACP permission sessionId'),
        description: permissionDescription(params),
        options: permissionOptions(params.options)
      }
      this.#permissions.set(requestKey, { id: rpcId, request })
      this.#inbound.push({ type: 'permission.request', request })
      return
    }
    if (!hasId && method === 'session/update') {
      this.#inbound.push({
        type: 'session.update',
        sessionId: requiredString(params.sessionId, 'ACP update sessionId'),
        update: record(params.update)
      })
      return
    }

    if (hasId) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Zero3 Pilot does not expose ACP client method ${method}` } })
    }
  }

  private processExit(detail: string): void {
    if (!this.#child && this.#pending.size === 0) return
    this.#child = undefined
    this.#initialized = undefined
    this.#permissions.clear()
    const error = new AcpProcessCrashedError(`ACP adapter process exited: ${detail}; ${this.#stderr.slice(-1000)}`)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#inbound.fail(error)
  }
}

import { randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import {
  ZERO3_GEMINI_EXECUTION_RESULT_SCHEMA,
  type Zero3AntigravityAuthState,
  type Zero3AntigravityMappedEvent,
  type Zero3AntigravitySessionBinding,
  type Zero3AntigravityTurnInput,
  type Zero3AntigravityTurnResult
} from './antigravity-types'

type EventSink = (event: Zero3AntigravityMappedEvent) => void

type PendingTurn = {
  turnId: string
  taskId: string | null
  resolve: (result: Zero3AntigravityTurnResult) => void
  reject: (error: Error) => void
}

type RuntimeHandle = {
  binding: Zero3AntigravitySessionBinding
  child: ChildProcessWithoutNullStreams
  pending: PendingTurn | null
  terminalSeenForCurrentTurn: boolean
  stderrTail: string[]
}

const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_STDERR_LINES = 100
const START_TIMEOUT_MS = 30_000
const RESULT_TIMEOUT_MS = 60 * 60 * 1000

function now() { return new Date().toISOString() }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function required(value: unknown, label: string, max: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return text
}
function isDirectory(value: string) {
  try { return fs.statSync(value).isDirectory() } catch { return false }
}
function executableExists(value: string) {
  try { return fs.statSync(value).isFile() } catch { return false }
}
function authDiagnostic(value: string): Zero3AntigravityAuthState | null {
  const lower = value.toLowerCase()
  if (lower.includes('authentication required') || lower.includes('please sign in') || lower.includes('not authenticated')) {
    return 'AUTH_REQUIRED'
  }
  if (
    lower.includes('expired') &&
    (lower.includes('authentication') || lower.includes('credential') || lower.includes('session') || lower.includes('token'))
  ) {
    return 'AUTH_EXPIRED'
  }
  return null
}
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function discoverAntigravityBinary(): string | null {
  const configured = process.env.ZERO3_ANTIGRAVITY_BIN?.trim()
  if (configured) {
    if (!path.isAbsolute(configured) || !executableExists(configured)) {
      throw new Error('ZERO3_ANTIGRAVITY_BIN must point to an existing absolute executable')
    }
    return configured
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.cmd') : ''
      ].filter(Boolean)
    : [path.join(os.homedir(), '.local', 'bin', 'agy')]
  for (const candidate of candidates) if (executableExists(candidate)) return candidate

  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(finder, ['agy'], { encoding: 'utf8', windowsHide: true })
  if (result.status === 0) {
    const first = String(result.stdout ?? '').split(/\r?\n/).map(value => value.trim()).find(Boolean)
    if (first) return first
  }
  return null
}

class BindingStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}

  async get(logicalSessionId: string): Promise<Zero3AntigravitySessionBinding | null> {
    const all = await this.read()
    return all[logicalSessionId] ? { ...all[logicalSessionId] } : null
  }

  put(binding: Zero3AntigravitySessionBinding): Promise<void> {
    const task = this.tail.then(async () => {
      const all = await this.read()
      all[binding.logicalSessionId] = binding
      await fsp.mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`
      await fsp.writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await fsp.rename(temporary, this.file)
    })
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  private async read(): Promise<Record<string, Zero3AntigravitySessionBinding>> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
}

export class Zero3AntigravityAdapter {
  private readonly handles = new Map<string, RuntimeHandle>()
  private readonly listeners = new Set<EventSink>()
  private readonly turns = new Map<string, Promise<Zero3AntigravityTurnResult>>()
  private readonly store: BindingStore
  private readonly binary: string | null

  constructor(stateFile: string) {
    this.binary = discoverAntigravityBinary()
    this.store = new BindingStore(stateFile)
  }

  status() {
    return {
      available: Boolean(this.binary),
      binary: this.binary,
      activeSessions: [...this.handles.keys()]
    }
  }

  subscribe(listener: EventSink) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async binding(logicalSessionIdValue: unknown) {
    return this.store.get(required(logicalSessionIdValue, 'logicalSessionId', 256))
  }

  async startTurn(inputValue: Zero3AntigravityTurnInput): Promise<{ turnId: string }> {
    if (!this.binary) throw new Error('Antigravity CLI (agy) was not found. Install/authenticate the official CLI first.')
    const logicalSessionId = required(inputValue.logicalSessionId, 'logicalSessionId', 256)
    const cwd = path.resolve(required(inputValue.cwd, 'cwd', 4096))
    const prompt = required(inputValue.prompt, 'prompt', 128_000)
    if (!isDirectory(cwd)) throw new Error(`Antigravity cwd does not exist: ${cwd}`)

    const handle = await this.ensureRuntime(logicalSessionId, cwd, inputValue.projectId ?? null)
    if (handle.binding.authState === 'AUTH_REQUIRED' || handle.binding.authState === 'AUTH_EXPIRED') {
      throw new Error(`Antigravity ${handle.binding.authState.toLowerCase()}; authenticate with the official interactive agy client and retry`)
    }
    if (handle.pending) throw new Error('Antigravity logical session already has an active turn')

    const turnId = `agy-turn-${randomUUID()}`
    const taskId = inputValue.taskId?.trim() || null
    handle.terminalSeenForCurrentTurn = false
    handle.binding.state = 'RUNNING'
    handle.binding.updatedAt = now()
    await this.store.put(handle.binding)

    let resolveResult!: (result: Zero3AntigravityTurnResult) => void
    let rejectResult!: (error: Error) => void
    const promise = new Promise<Zero3AntigravityTurnResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    handle.pending = { turnId, taskId, resolve: resolveResult, reject: rejectResult }
    this.turns.set(turnId, promise)
    this.emit(handle, 'agent.turn.started', { cwd, contextVersion: inputValue.contextVersion ?? null }, turnId, taskId)

    const envelope = { event: 'user', message: { content: prompt } }
    handle.child.stdin.write(`${JSON.stringify(envelope)}\n`, error => {
      if (error && handle.pending?.turnId === turnId) {
        const pending = handle.pending
        handle.pending = null
        pending.reject(error)
      }
    })
    return { turnId }
  }

  async waitTurn(turnIdValue: unknown): Promise<Zero3AntigravityTurnResult> {
    const turnId = required(turnIdValue, 'turnId', 256)
    const promise = this.turns.get(turnId)
    if (!promise) throw new Error('Antigravity turn is unknown or no longer retained')
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Antigravity turn observation timed out')), RESULT_TIMEOUT_MS)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
      this.turns.delete(turnId)
    }
  }

  async interrupt(logicalSessionIdValue: unknown) {
    const logicalSessionId = required(logicalSessionIdValue, 'logicalSessionId', 256)
    const handle = this.handles.get(logicalSessionId)
    if (!handle) return { interrupted: false }
    handle.child.kill('SIGINT')
    return { interrupted: true }
  }

  async stop(logicalSessionIdValue: unknown) {
    const logicalSessionId = required(logicalSessionIdValue, 'logicalSessionId', 256)
    const handle = this.handles.get(logicalSessionId)
    if (!handle) return { stopped: false }
    handle.child.stdin.end()
    return { stopped: true }
  }

  stopAll() {
    for (const handle of this.handles.values()) {
      try { handle.child.stdin.end() } catch {}
      try { handle.child.kill() } catch {}
    }
    this.handles.clear()
  }

  private async ensureRuntime(logicalSessionId: string, cwd: string, projectId: string | null): Promise<RuntimeHandle> {
    const existing = this.handles.get(logicalSessionId)
    if (existing && !existing.child.killed && existing.binding.cwd === cwd) return existing
    if (existing) {
      try { existing.child.kill() } catch {}
      this.handles.delete(logicalSessionId)
    }

    const persisted = await this.store.get(logicalSessionId)
    if (persisted && path.resolve(persisted.cwd) !== cwd && persisted.conversationId) {
      throw new Error('Antigravity logical session is already bound to a different cwd; create a new logical session')
    }
    const binding: Zero3AntigravitySessionBinding = persisted ?? {
      logicalSessionId,
      projectId,
      cwd,
      conversationId: null,
      state: 'STARTING',
      authState: 'UNKNOWN',
      lastEventAt: null,
      createdAt: now(),
      updatedAt: now()
    }
    binding.cwd = cwd
    binding.projectId = projectId ?? binding.projectId
    binding.state = 'STARTING'
    binding.updatedAt = now()
    await this.store.put(binding)

    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--sandbox',
      '--print-timeout', '60m',
      '--json-schema', JSON.stringify(ZERO3_GEMINI_EXECUTION_RESULT_SCHEMA)
    ]
    if (binding.conversationId) args.push('--conversation', binding.conversationId)
    const shell = process.platform === 'win32' && /\.cmd$/i.test(this.binary!)
    const child = spawn(this.binary!, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell
    })
    const handle: RuntimeHandle = { binding, child, pending: null, terminalSeenForCurrentTurn: false, stderrTail: [] }
    this.handles.set(logicalSessionId, handle)
    this.observeProcess(handle)
    await this.waitUntilStarted(handle)
    return handle
  }

  private waitUntilStarted(handle: RuntimeHandle): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Antigravity runtime did not emit init/auth state within 30 seconds'))
      }, START_TIMEOUT_MS)
      const onEvent = (event: Zero3AntigravityMappedEvent) => {
        if (event.logicalSessionId !== handle.binding.logicalSessionId) return
        if (event.type === 'agent.runtime.started' || event.type === 'provider.auth.required') {
          cleanup()
          resolve()
        }
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        reject(new Error(`Antigravity runtime exited before init (code=${code ?? 'null'}, signal=${signal ?? 'none'})`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.listeners.delete(onEvent)
        handle.child.off('error', onError)
        handle.child.off('exit', onExit)
      }
      this.listeners.add(onEvent)
      handle.child.once('error', onError)
      handle.child.once('exit', onExit)
    })
  }

  private observeProcess(handle: RuntimeHandle) {
    const stdout = readline.createInterface({ input: handle.child.stdout })
    stdout.on('line', line => {
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        this.failPending(handle, new Error('Antigravity NDJSON line exceeded 4 MiB'))
        handle.child.kill()
        return
      }
      let message: Record<string, unknown>
      try {
        message = record(JSON.parse(line))
      } catch {
        this.failPending(handle, new Error('Antigravity stdout emitted invalid NDJSON'))
        handle.child.kill()
        return
      }
      void this.handleMessage(handle, message)
    })

    const stderr = readline.createInterface({ input: handle.child.stderr })
    stderr.on('line', line => {
      const bounded = line.slice(0, 4000)
      handle.stderrTail.push(bounded)
      if (handle.stderrTail.length > MAX_STDERR_LINES) handle.stderrTail.shift()
      const auth = authDiagnostic(bounded)
      if (auth) {
        handle.binding.authState = auth
        handle.binding.state = 'ERROR'
        handle.binding.updatedAt = now()
        void this.store.put(handle.binding)
        this.emit(handle, 'provider.auth.required', { state: auth, message: 'Authenticate with the official interactive agy client' })
      }
    })

    handle.child.on('error', error => this.failPending(handle, error))
    handle.child.on('exit', (code, signal) => {
      this.handles.delete(handle.binding.logicalSessionId)
      const pending = handle.pending
      handle.pending = null
      if (pending && !handle.terminalSeenForCurrentTurn) {
        handle.binding.state = 'OUTCOME_UNKNOWN'
        handle.binding.updatedAt = now()
        void this.store.put(handle.binding)
        const result: Zero3AntigravityTurnResult = {
          turnId: pending.turnId,
          logicalSessionId: handle.binding.logicalSessionId,
          conversationId: handle.binding.conversationId,
          status: 'OUTCOME_UNKNOWN',
          response: null,
          structuredOutput: null,
          error: `Antigravity process exited before a terminal result (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
          rawStatus: null
        }
        this.emit(handle, 'agent.turn.outcome_unknown', { code, signal, stderrTail: handle.stderrTail.slice(-10) }, pending.turnId, pending.taskId)
        pending.resolve(result)
      }
    })
  }

  private async handleMessage(handle: RuntimeHandle, message: Record<string, unknown>) {
    const event = asString(message.event) ?? ''
    if (event === 'init') {
      const init = record(message.init)
      const conversationId = asString(message.conversation_id) ?? asString(init.conversation_id)
      if (conversationId) {
        handle.binding.conversationId = conversationId
        handle.binding.authState = 'AUTHENTICATED'
      }
      handle.binding.state = handle.pending ? 'RUNNING' : 'READY'
      handle.binding.lastEventAt = now()
      handle.binding.updatedAt = now()
      await this.store.put(handle.binding)
      this.emit(handle, 'agent.runtime.started', { init })
      this.emit(handle, 'provider.health.changed', {
        available: true,
        authenticated: handle.binding.authState === 'AUTHENTICATED',
        authState: handle.binding.authState
      })
      return
    }

    if (event === 'step_update') {
      const nested = record(message.step_update)
      const step = Object.keys(nested).length > 0 ? nested : message
      const pending = handle.pending
      const stepType = asString(step.step_type) ?? 'unknown'
      const state = asString(step.state) ?? 'unknown'
      const conversationId = asString(step.conversation_id)
      if (conversationId) handle.binding.conversationId = conversationId
      const payload = {
        stepIndex: step.step_index ?? null,
        state,
        stepType,
        toolName: step.tool_name ?? null,
        toolInfo: step.tool_info ?? null,
        subagentInfo: step.subagent_info ?? null,
        usage: step.usage ?? null,
        durationSeconds: step.duration_seconds ?? null
      }
      if (stepType === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
        this.emit(handle, 'agent.response.delta', { delta: step.text_delta }, pending?.turnId ?? null, pending?.taskId ?? null)
      } else if (stepType === 'tool') {
        this.emit(handle, state === 'DONE' ? 'agent.tool.completed' : 'agent.tool.started', payload, pending?.turnId ?? null, pending?.taskId ?? null)
      } else if (step.subagent_info) {
        this.emit(handle, state === 'DONE' ? 'agent.subagent.completed' : 'agent.subagent.started', payload, pending?.turnId ?? null, pending?.taskId ?? null)
      }
      return
    }

    if (event === 'result') {
      const pending = handle.pending
      if (!pending) return
      const envelope = record(message.result)
      const resultPayload = Object.keys(envelope).length > 0 ? envelope : message
      handle.terminalSeenForCurrentTurn = true
      handle.pending = null

      const conversationId = asString(resultPayload.conversation_id) ?? handle.binding.conversationId
      if (conversationId) handle.binding.conversationId = conversationId
      handle.binding.authState = 'AUTHENTICATED'
      const rawStatus = asString(resultPayload.status)
      const status = this.mapResultStatus(rawStatus)
      handle.binding.state = status === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : status === 'FAILED' ? 'ERROR' : 'READY'
      handle.binding.lastEventAt = now()
      handle.binding.updatedAt = now()
      await this.store.put(handle.binding)

      const result: Zero3AntigravityTurnResult = {
        turnId: pending.turnId,
        logicalSessionId: handle.binding.logicalSessionId,
        conversationId: handle.binding.conversationId,
        status,
        response: asString(resultPayload.response),
        structuredOutput: resultPayload.structured_output ?? null,
        error: asString(resultPayload.error),
        rawStatus
      }
      const type = status === 'COMPLETE'
        ? 'agent.turn.completed'
        : status === 'OUTCOME_UNKNOWN'
          ? 'agent.turn.outcome_unknown'
          : 'agent.turn.failed'
      this.emit(handle, type, {
        rawStatus,
        structuredOutput: result.structuredOutput,
        error: result.error,
        usage: resultPayload.usage ?? null,
        numTurns: resultPayload.num_turns ?? null
      }, pending.turnId, pending.taskId)
      pending.resolve(result)
    }
  }

  private mapResultStatus(raw: string | null): Zero3AntigravityTurnResult['status'] {
    switch (raw) {
      case 'SUCCESS': return 'COMPLETE'
      case 'ERROR': return 'FAILED'
      case 'CANCELED':
      case 'INTERRUPTED': return 'PARTIAL'
      case 'INVALID': return 'BLOCKED'
      case 'WAITING':
      case 'RUNNING':
      default: return 'OUTCOME_UNKNOWN'
    }
  }

  private failPending(handle: RuntimeHandle, error: Error) {
    const pending = handle.pending
    handle.pending = null
    if (pending) pending.reject(error)
  }

  private emit(
    handle: RuntimeHandle,
    type: Zero3AntigravityMappedEvent['type'],
    payload: Record<string, unknown>,
    turnId: string | null = null,
    taskId: string | null = null
  ) {
    const event: Zero3AntigravityMappedEvent = {
      eventId: randomUUID(),
      logicalSessionId: handle.binding.logicalSessionId,
      taskId,
      turnId,
      conversationId: handle.binding.conversationId,
      at: now(),
      type,
      payload
    }
    for (const listener of this.listeners) listener(event)
  }
}

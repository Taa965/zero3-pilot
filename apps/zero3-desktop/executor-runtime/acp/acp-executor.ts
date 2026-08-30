import path from 'node:path'

import { createExecutorFailure } from '../failure-normalizer.ts'
import {
  ZERO3_EXECUTOR_CONTRACT,
  ZERO3_HANDOFF_PROTOCOL,
  type ExecutorEvent,
  type ExecutorFailureCode,
  type ExecutorHandoffCheckpointRef,
  type ExecutorInput,
  type ExecutorPermissionResponse,
  type ExecutorProbe,
  type ExecutorSession,
  type ExecutorSessionRef,
  type ExecutorStartContext,
  type Zero3Executor
} from '../executor-types.ts'
import { AcpJsonlClient, AcpProcessCrashedError, AcpTransportError, type AcpInbound } from './acp-jsonl-client.ts'
import { AcpSessionStore } from './acp-session-store.ts'
import type { AcpJsonRecord, AcpPermissionOption, AcpRuntimeEvent, ResolvedAcpAdapter } from './acp-types.ts'

export interface AcpExternalExecutorOptions {
  id: string
  label: string
  adapter: ResolvedAcpAdapter
  stateDir: string
  now?: () => string
  requestTimeoutMs?: number
}

export class AcpContextLostError extends Error {
  readonly failure
  constructor(executorId: string, message: string) {
    super(message)
    this.name = 'AcpContextLostError'
    this.failure = createExecutorFailure('context_lost', message, executorId)
  }
}

function record(value: unknown): AcpJsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AcpJsonRecord : {}
}

function nonEmpty(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} must be non-empty`)
  return text
}

function textContent(update: AcpJsonRecord): string | undefined {
  const content = record(update.content)
  return content.type === 'text' && typeof content.text === 'string' && content.text ? content.text : undefined
}

function classifyFailure(error: unknown): ExecutorFailureCode {
  if (error instanceof AcpProcessCrashedError) return 'process_crash'
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('quota') || message.includes('credit balance') || message.includes('spend limit')) return 'quota_exhausted'
  if (message.includes('rate limit') || message.includes('too many requests') || message.includes('429')) return 'rate_limited'
  if (message.includes('auth') || message.includes('login') || message.includes('unauthorized') || message.includes('401')) return 'auth_required'
  if (message.includes('overload') || message.includes('capacity')) return 'provider_overloaded'
  if (message.includes('context') && (message.includes('length') || message.includes('window') || message.includes('token'))) return 'context_exhausted'
  if (message.includes('budget')) return 'budget_exhausted'
  if (message.includes('permission') && (message.includes('deny') || message.includes('denied'))) return 'permission_denied'
  if (message.includes('policy') && (message.includes('deny') || message.includes('blocked'))) return 'policy_denied'
  if (message.includes('unsupported') || message.includes('method not found') || message.includes('-32601')) return 'unsupported'
  if (message.includes('transport') || message.includes('stdin') || message.includes('jsonl')) return 'transport_lost'
  if (message.includes('invalid') || message.includes('bad request') || message.includes('-32602')) return 'bad_request'
  if (error instanceof AcpTransportError) return 'provider_error'
  return 'internal_error'
}

function planText(update: AcpJsonRecord): string | undefined {
  if (typeof update.text === 'string' && update.text.trim()) return update.text.trim()
  if (!Array.isArray(update.entries)) return undefined
  const lines = update.entries.map(record).map(entry => {
    const content = typeof entry.content === 'string' ? entry.content : typeof entry.text === 'string' ? entry.text : ''
    const status = typeof entry.status === 'string' ? ` [${entry.status}]` : ''
    return content ? `${content}${status}` : ''
  }).filter(Boolean)
  return lines.length ? lines.join('\n') : undefined
}

function updateToRuntimeEvent(update: AcpJsonRecord): AcpRuntimeEvent | undefined {
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
  if (kind === 'agent_message_chunk') {
    const text = textContent(update)
    return text ? { type: 'message', text } : undefined
  }
  if (kind === 'agent_thought_chunk') {
    const text = textContent(update)
    return text ? { type: 'reasoning', text } : undefined
  }
  if (kind === 'plan') {
    const text = planText(update)
    return text ? { type: 'plan', text } : undefined
  }
  if (kind === 'tool_call') {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
    if (!toolCallId) return undefined
    const name = typeof update.title === 'string' && update.title ? update.title : typeof update.name === 'string' && update.name ? update.name : 'ACP tool'
    return { type: 'tool.started', toolCallId, name }
  }
  if (kind === 'tool_call_update') {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
    if (!toolCallId) return undefined
    const status = typeof update.status === 'string' ? update.status : ''
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      return { type: 'tool.completed', toolCallId, success: status === 'completed' }
    }
    return status ? { type: 'tool.updated', toolCallId, detail: status } : undefined
  }
  if (kind === 'usage_update') {
    const cost = record(update.cost)
    const costUsd = cost.currency === 'USD' && typeof cost.amount === 'number' ? cost.amount : undefined
    return costUsd == null ? undefined : { type: 'usage.updated', usage: { costUsd } }
  }
  return undefined
}

function permissionOption(options: readonly AcpPermissionOption[], decision: ExecutorPermissionResponse['decision']): string | undefined {
  if (decision === 'approve_once') {
    return options.find(option => option.kind === 'allow_once')?.optionId ?? options.find(option => option.optionId === 'allow-once')?.optionId
  }
  if (decision === 'approve_session') {
    return options.find(option => option.kind === 'allow_always')?.optionId ?? options.find(option => /session|always/i.test(option.optionId))?.optionId
  }
  return options.find(option => option.kind?.startsWith('reject'))?.optionId ?? options.find(option => /^reject$/i.test(option.optionId))?.optionId
}

function stopOutcome(stopReason: unknown): 'succeeded' | 'cancelled' | 'failed' {
  const value = typeof stopReason === 'string' ? stopReason.toLowerCase() : ''
  if (value.includes('cancel')) return 'cancelled'
  if (['end_turn', 'end-turn', 'completed', 'stop'].includes(value)) return 'succeeded'
  return value ? 'failed' : 'succeeded'
}

export class AcpExternalExecutor implements Zero3Executor {
  readonly descriptor
  readonly #client: AcpJsonlClient
  readonly #store: AcpSessionStore
  readonly #now: () => string

  constructor(readonly options: AcpExternalExecutorOptions) {
    const id = nonEmpty(options.id, 'ACP executor id')
    this.descriptor = { id, kind: 'external-agent' as const, label: nonEmpty(options.label, 'ACP executor label') }
    this.#client = new AcpJsonlClient(options.adapter, options.requestTimeoutMs)
    this.#store = new AcpSessionStore(path.resolve(options.stateDir))
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async probe(): Promise<ExecutorProbe> {
    try {
      await this.#client.initialize()
      return { executorId: this.descriptor.id, status: 'ready', detail: `${this.options.adapter.packageName}@${this.options.adapter.packageVersion} ACP v1` }
    } catch (error) {
      const code = classifyFailure(error)
      return {
        executorId: this.descriptor.id,
        status: code === 'auth_required' ? 'auth_required' : code === 'unsupported' ? 'unsupported' : 'unavailable',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async start(context: ExecutorStartContext): Promise<ExecutorSession> {
    if (context.contract !== ZERO3_EXECUTOR_CONTRACT) throw new Error('unsupported Zero3 Executor Contract')
    const workspace = path.resolve(nonEmpty(context.identity.workspace, 'workspace'))
    const initialized = await this.#client.initialize()
    if (initialized.protocolVersion !== 1) throw new Error('ACP v1 negotiation failed')
    const response = record(await this.#client.request('session/new', { cwd: workspace, mcpServers: [] }))
    const sessionId = nonEmpty(response.sessionId, 'ACP sessionId')
    await this.#store.save({
      schemaVersion: 'zero3.pilot.acp.session.v1',
      executorId: this.descriptor.id,
      sessionId,
      workspace,
      createdAt: this.#now()
    })
    return { executorId: this.descriptor.id, sessionId, generation: context.generation, startedAt: this.#now() }
  }

  async resume(ref: ExecutorSessionRef, checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession> {
    this.assertSession(ref)
    if (checkpoint.protocol !== ZERO3_HANDOFF_PROTOCOL || checkpoint.generation !== ref.generation) {
      throw new AcpContextLostError(this.descriptor.id, 'ACP resume handoff identity is invalid')
    }
    let workspace: string
    try {
      workspace = (await this.#store.load(this.descriptor.id, ref.sessionId)).workspace
    } catch (error) {
      throw new AcpContextLostError(this.descriptor.id, `ACP session metadata unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const initialized = await this.#client.initialize()
      if (!initialized.loadSession) throw new Error('ACP adapter does not advertise loadSession')
      await this.#client.request('session/load', { sessionId: ref.sessionId, cwd: workspace, mcpServers: [] })
    } catch (error) {
      throw new AcpContextLostError(this.descriptor.id, `ACP session/load failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { ...ref, startedAt: this.#now() }
  }

  async *prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    this.assertSession(session)
    let sequence = 0
    const request = this.#client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: input.text }],
      _meta: { zero3ClientRequestId: input.clientRequestId }
    })
    let settled = false
    let response: unknown
    let requestError: unknown
    void request.then(value => { settled = true; response = value }, error => { settled = true; requestError = error })

    while (!settled) {
      let inbound: AcpInbound
      try {
        inbound = await Promise.race([
          this.#client.nextInbound(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('__zero3_poll__')), 50))
        ])
      } catch (error) {
        if (error instanceof Error && error.message === '__zero3_poll__') continue
        requestError = error
        settled = true
        break
      }
      if (inbound.type === 'permission.request') {
        if (inbound.request.sessionId !== session.sessionId) continue
        sequence += 1
        yield {
          type: 'permission.requested', sequence, at: this.#now(),
          requestId: inbound.request.requestKey,
          description: inbound.request.description,
          allowSessionApproval: inbound.request.options.some(option => option.kind === 'allow_always' || /session|always/i.test(option.optionId))
        }
        continue
      }
      if (inbound.sessionId !== session.sessionId) continue
      const runtimeEvent = updateToRuntimeEvent(inbound.update)
      if (!runtimeEvent) continue
      sequence += 1
      yield { ...runtimeEvent, sequence, at: this.#now() } as ExecutorEvent
    }

    if (requestError) {
      sequence += 1
      yield {
        type: 'failure', sequence, at: this.#now(),
        failure: createExecutorFailure(classifyFailure(requestError), requestError instanceof Error ? requestError.message : String(requestError), this.descriptor.id)
      }
      sequence += 1
      yield { type: 'completed', sequence, at: this.#now(), outcome: 'failed' }
      return
    }
    const result = record(response)
    sequence += 1
    yield { type: 'completed', sequence, at: this.#now(), outcome: stopOutcome(result.stopReason) }
  }

  async respondPermission(session: ExecutorSession, response: ExecutorPermissionResponse): Promise<void> {
    this.assertSession(session)
    const request = this.#client.permission(response.requestId)
    if (!request || request.sessionId !== session.sessionId) throw new Error('ACP permission request is not pending for this session')
    if (response.decision === 'deny') {
      this.#client.respondPermission(response.requestId, permissionOption(request.options, response.decision))
      return
    }
    const optionId = permissionOption(request.options, response.decision)
    if (!optionId) throw new Error(`ACP adapter did not offer a compatible ${response.decision} option; refusing implicit approval`)
    this.#client.respondPermission(response.requestId, optionId)
  }

  async cancel(session: ExecutorSession): Promise<void> {
    this.assertSession(session)
    this.#client.notify('session/cancel', { sessionId: session.sessionId })
  }

  async close(session: ExecutorSession): Promise<void> {
    this.assertSession(session)
    try {
      await this.#client.request('session/close', { sessionId: session.sessionId }, 5_000)
    } catch (error) {
      if (classifyFailure(error) !== 'unsupported') throw error
    }
  }

  private assertSession(session: ExecutorSession | ExecutorSessionRef): void {
    if (session.executorId !== this.descriptor.id) throw new Error('ACP session belongs to a different executor')
    nonEmpty(session.sessionId, 'ACP sessionId')
    if (!Number.isSafeInteger(session.generation) || session.generation < 1) throw new Error('ACP session generation must be positive')
  }
}

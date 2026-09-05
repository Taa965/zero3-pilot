import { setTimeout as delay } from 'node:timers/promises'

import type { ExecutorInput, ExecutorPermissionResponse, ExecutorPermissionProfile } from '../executor-types.ts'
import type {
  NativeCodexDriver,
  NativeCodexDriverEvent,
  NativeCodexFailureReason,
  NativeCodexProbeSnapshot,
  NativeCodexResumeOptions,
  NativeCodexStartOptions
} from './native-driver.ts'

type RpcId = number | string
type JsonRecord = Record<string, unknown>

export type NativeCodexAppServerEvent =
  | { kind: 'lifecycle'; state: 'started' | 'stopped' | 'error'; detail?: string }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: RpcId; method: string; params: unknown }

export interface NativeCodexAppServerTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
  respondToServerRequest(value: unknown): Promise<unknown>
  subscribe(listener: (event: NativeCodexAppServerEvent) => void): () => void
}

interface ServerRequest {
  id: RpcId
  key: string
  method: string
  params: JsonRecord
}

export interface NativeCodexAppServerDriverOptions {
  transport: NativeCodexAppServerTransport
  turnTimeoutMs?: number
  pollMs?: number
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000
const DEFAULT_POLL_MS = 300
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval'
])

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function nonEmpty(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} must be non-empty`)
  return text
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function rpcKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`
}

function extractId(value: unknown, kind: 'thread' | 'turn'): string {
  const root = record(value)
  const nested = record(root[kind])
  return nonEmpty(root.id ?? nested.id, `Codex ${kind} id`)
}

function sandboxFor(profile: ExecutorPermissionProfile): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (profile === 'read_only') return 'read-only'
  if (profile === 'full_control') return 'danger-full-access'
  return 'workspace-write'
}

function approvalDescription(request: ServerRequest): string {
  const reason = optionalString(request.params.reason)
  const command = Array.isArray(request.params.command)
    ? request.params.command.filter(value => typeof value === 'string').join(' ')
    : undefined
  const cwd = optionalString(request.params.cwd)
  return [reason, command, cwd].filter(Boolean).join(' | ') || `Codex approval request: ${request.method}`
}

function allowSessionApproval(request: ServerRequest): boolean {
  const available = Array.isArray(request.params.availableDecisions)
    ? request.params.availableDecisions.filter(value => typeof value === 'string')
    : []
  if (available.length > 0) return available.includes('acceptForSession') || available.includes('approved_for_session')
  return request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval'
}

function turnFromThreadRead(value: unknown, turnId: string): JsonRecord | undefined {
  const root = record(value)
  const thread = record(root.thread)
  const turns = Array.isArray(thread.turns) ? thread.turns : Array.isArray(root.turns) ? root.turns : []
  return turns.map(record).find(turn => turn.id === turnId)
}

function finalTextEvents(turn: JsonRecord): NativeCodexDriverEvent[] {
  const events: NativeCodexDriverEvent[] = []
  const items = Array.isArray(turn.items) ? turn.items.map(record) : []
  for (const item of items) {
    const type = optionalString(item.type)
    if (type === 'agentMessage') {
      const text = optionalString(item.text)
      if (text) events.push({ type: 'message', text })
    } else if (type === 'reasoning') {
      const text = optionalString(item.text) ?? optionalString(item.summary)
      if (text) events.push({ type: 'reasoning', text })
    } else if (type === 'plan') {
      const text = optionalString(item.text)
      if (text) events.push({ type: 'plan', text })
    }
  }
  return events
}

function usageEvent(turn: JsonRecord): NativeCodexDriverEvent | undefined {
  const usage = record(turn.usage)
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined
  if (inputTokens == null && outputTokens == null) return undefined
  return { type: 'usage.updated', usage: { inputTokens, outputTokens } }
}

function failureReason(error: unknown, fallback: NativeCodexFailureReason = 'provider_error'): NativeCodexFailureReason {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (text.includes('quota') || text.includes('usage limit') || text.includes('spend control')) return 'quota_exhausted'
  if (text.includes('rate limit') || text.includes('429')) return 'rate_limit_reached'
  if (text.includes('auth') || text.includes('login') || text.includes('401')) return 'not_authenticated'
  if (text.includes('context') && (text.includes('missing') || text.includes('lost') || text.includes('not found'))) return 'context_lost'
  if (text.includes('overload') || text.includes('503')) return 'provider_overloaded'
  return fallback
}

export class NativeCodexAppServerDriver implements NativeCodexDriver {
  readonly #transport: NativeCodexAppServerTransport
  readonly #turnTimeoutMs: number
  readonly #pollMs: number
  readonly #activeTurnByThread = new Map<string, string>()
  readonly #approvalThreadByRequest = new Map<string, string>()
  readonly #serverRequests = new Map<string, ServerRequest>()
  #lifecycleGeneration = 0
  #lastLifecycleFailure: string | undefined

  constructor(options: NativeCodexAppServerDriverOptions) {
    this.#transport = options.transport
    this.#turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.#transport.subscribe(event => this.onTransportEvent(event))
  }

  async probe(): Promise<NativeCodexProbeSnapshot> {
    try {
      const accountRead = record(await this.#transport.request('account/read', { refreshToken: false }))
      const account = record(accountRead.account)
      const type = optionalString(account.type)
      const planType = optionalString(account.planType) ?? null
      if (!type) return { available: false, reason: 'not_authenticated', planType }
      if (type !== 'chatgpt') return { available: false, reason: 'non_chatgpt_auth', planType }

      try {
        await this.#transport.request('modelProvider/capabilities/read', {})
      } catch {
        return { available: false, reason: 'unsupported', planType }
      }

      let limits: JsonRecord
      try {
        limits = record(await this.#transport.request('account/rateLimits/read', {}))
      } catch {
        return { available: false, reason: 'quota_probe_unavailable', planType }
      }
      if (limits.spendControlReached === true) return { available: false, reason: 'spend_control_reached', planType }
      const rateLimits = record(limits.rateLimits)
      if (rateLimits.rateLimitReachedType) return { available: false, reason: 'rate_limit_reached', planType }
      return { available: true, reason: 'chatgpt_subscription', planType }
    } catch (error) {
      const reason = failureReason(error)
      if (reason === 'not_authenticated') return { available: false, reason: 'not_authenticated' }
      if (reason === 'provider_overloaded') return { available: false, reason: 'provider_overloaded' }
      return { available: false, reason: 'provider_error' }
    }
  }

  async startThread(options: NativeCodexStartOptions): Promise<{ threadId: string }> {
    const result = await this.#transport.request('thread/start', {
      cwd: nonEmpty(options.workspace, 'workspace'),
      approvalPolicy: options.policy.approvalRequired ? 'on-request' : 'never',
      sandbox: sandboxFor(options.policy.permissionProfile),
      ephemeral: false,
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {})
    })
    return { threadId: extractId(result, 'thread') }
  }

  async resumeThread(threadId: string, options: NativeCodexResumeOptions = {}): Promise<void> {
    await this.#transport.request('thread/resume', {
      threadId: nonEmpty(threadId, 'threadId'),
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {})
    })
  }

  async *prompt(threadId: string, input: ExecutorInput): AsyncIterable<NativeCodexDriverEvent> {
    const id = nonEmpty(threadId, 'threadId')
    const lifecycleGeneration = this.#lifecycleGeneration
    this.#lastLifecycleFailure = undefined
    let turnId: string
    try {
      const turn = await this.#transport.request('turn/start', {
        threadId: id,
        clientUserMessageId: nonEmpty(input.clientRequestId, 'clientRequestId'),
        input: [{ type: 'text', text: input.text, text_elements: [] }]
      })
      turnId = extractId(turn, 'turn')
    } catch (error) {
      yield { type: 'failure', reason: failureReason(error), message: error instanceof Error ? error.message : String(error) }
      yield { type: 'completed', outcome: 'failed' }
      return
    }

    this.#activeTurnByThread.set(id, turnId)
    const surfacedApprovals = new Set<string>()
    const toolStatus = new Map<string, string>()
    const changedPaths = new Set<string>()
    const deadline = Date.now() + this.#turnTimeoutMs

    try {
      while (Date.now() < deadline) {
        if (this.#lifecycleGeneration !== lifecycleGeneration) {
          yield { type: 'failure', reason: 'process_crash', message: this.#lastLifecycleFailure ?? 'Codex app-server stopped during an active turn' }
          yield { type: 'completed', outcome: 'failed' }
          return
        }

        for (const request of this.serverRequestsForThread(id)) {
          if (surfacedApprovals.has(request.key)) continue
          surfacedApprovals.add(request.key)
          if (!APPROVAL_METHODS.has(request.method)) {
            await this.rejectServerRequest(request, 'Zero3 Pilot Native Executor does not support this server request.')
            yield { type: 'failure', reason: 'unsupported', message: `unsupported Codex server request: ${request.method}` }
            continue
          }
          this.#approvalThreadByRequest.set(request.key, id)
          yield {
            type: 'permission.requested',
            requestId: request.key,
            description: approvalDescription(request),
            allowSessionApproval: allowSessionApproval(request)
          }
        }

        let turn: JsonRecord | undefined
        try {
          turn = turnFromThreadRead(await this.#transport.request('thread/read', { threadId: id, includeTurns: true }), turnId)
        } catch (error) {
          const reason = this.#lifecycleGeneration !== lifecycleGeneration ? 'process_crash' : failureReason(error, 'transport_lost')
          yield { type: 'failure', reason, message: error instanceof Error ? error.message : String(error) }
          yield { type: 'completed', outcome: 'failed' }
          return
        }
        if (!turn) {
          await delay(this.#pollMs)
          continue
        }

        const items = Array.isArray(turn.items) ? turn.items.map(record) : []
        for (const item of items) {
          const itemId = optionalString(item.id)
          const type = optionalString(item.type)
          const status = optionalString(item.status) ?? ''
          if (itemId && type === 'commandExecution') {
            if (!toolStatus.has(itemId)) yield { type: 'tool.started', toolCallId: itemId, name: 'commandExecution' }
            const previous = toolStatus.get(itemId)
            if (previous !== status && status && previous != null) yield { type: 'tool.updated', toolCallId: itemId, detail: status }
            if (status && ['completed', 'failed', 'declined'].includes(status) && previous !== status) {
              yield { type: 'tool.completed', toolCallId: itemId, success: status === 'completed' }
            }
            toolStatus.set(itemId, status)
          }
          if (type === 'fileChange' && Array.isArray(item.changes)) {
            for (const change of item.changes.map(record)) {
              const filePath = optionalString(change.path)
              if (filePath && !changedPaths.has(filePath)) {
                changedPaths.add(filePath)
                yield { type: 'file.changed', path: filePath }
              }
            }
          }
        }

        const status = optionalString(turn.status)
        if (status === 'completed') {
          for (const event of finalTextEvents(turn)) yield event
          const usage = usageEvent(turn)
          if (usage) yield usage
          yield { type: 'completed', outcome: 'succeeded' }
          return
        }
        if (status === 'failed') {
          const message = JSON.stringify(turn.error ?? 'Codex turn failed')
          yield { type: 'failure', reason: failureReason(message), message }
          yield { type: 'completed', outcome: 'failed' }
          return
        }
        if (status === 'interrupted') {
          yield { type: 'completed', outcome: 'cancelled' }
          return
        }
        await delay(this.#pollMs)
      }
      yield { type: 'failure', reason: 'provider_error', message: 'Codex turn observation timed out' }
      yield { type: 'completed', outcome: 'failed' }
    } finally {
      this.#activeTurnByThread.delete(id)
    }
  }

  async respondPermission(threadId: string, response: ExecutorPermissionResponse): Promise<void> {
    const id = nonEmpty(threadId, 'threadId')
    if (this.#approvalThreadByRequest.get(response.requestId) !== id) throw new Error('Codex approval request belongs to a different session')
    const request = this.#serverRequests.get(response.requestId)
    if (!request) throw new Error('Codex approval request is not pending')
    const decision = response.decision === 'approve_once'
      ? 'accept'
      : response.decision === 'approve_session'
        ? 'acceptForSession'
        : 'decline'
    await this.#transport.respondToServerRequest({ id: request.id, result: { decision } })
    this.#serverRequests.delete(response.requestId)
    this.#approvalThreadByRequest.delete(response.requestId)
  }

  async cancel(threadId: string): Promise<void> {
    const id = nonEmpty(threadId, 'threadId')
    const turnId = this.#activeTurnByThread.get(id)
    if (!turnId) return
    await this.#transport.request('turn/interrupt', { threadId: id, turnId })
  }

  async close(threadId: string): Promise<void> {
    const id = nonEmpty(threadId, 'threadId')
    for (const [requestId, owner] of [...this.#approvalThreadByRequest]) {
      if (owner !== id) continue
      const request = this.#serverRequests.get(requestId)
      if (request) await this.#transport.respondToServerRequest({ id: request.id, result: { decision: 'decline' } })
      this.#serverRequests.delete(requestId)
      this.#approvalThreadByRequest.delete(requestId)
    }
    this.#activeTurnByThread.delete(id)
  }

  private onTransportEvent(event: NativeCodexAppServerEvent): void {
    if (event.kind === 'lifecycle') {
      if (event.state === 'stopped' || event.state === 'error') {
        this.#lifecycleGeneration += 1
        this.#lastLifecycleFailure = event.detail ?? `Codex app-server ${event.state}`
      }
      return
    }
    if (event.kind !== 'request') return
    const key = rpcKey(event.id)
    this.#serverRequests.set(key, { id: event.id, key, method: event.method, params: record(event.params) })
  }

  private serverRequestsForThread(threadId: string): ServerRequest[] {
    return [...this.#serverRequests.values()].filter(request => {
      const requestThread = optionalString(request.params.threadId) ?? optionalString(request.params.conversationId)
      return requestThread == null || requestThread === threadId
    })
  }

  private async rejectServerRequest(request: ServerRequest, message: string): Promise<void> {
    this.#serverRequests.delete(request.key)
    await this.#transport.respondToServerRequest({ id: request.id, error: { code: -32001, message } })
  }
}

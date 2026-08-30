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
import type {
  NativeCodexDriver,
  NativeCodexDriverEvent,
  NativeCodexFailureReason,
  NativeCodexProbeSnapshot,
  NativeCodexStartOptions
} from './native-driver.ts'

export interface NativeCodexExecutorOptions {
  id?: string
  label?: string
  model?: string
  modelProvider?: string
  now?: () => string
}

const FAILURE_MAP: Readonly<Record<NativeCodexFailureReason, ExecutorFailureCode>> = {
  not_authenticated: 'auth_required',
  non_chatgpt_auth: 'auth_required',
  quota_exhausted: 'quota_exhausted',
  rate_limit_reached: 'rate_limited',
  spend_control_reached: 'quota_exhausted',
  quota_probe_unavailable: 'provider_error',
  provider_overloaded: 'provider_overloaded',
  provider_error: 'provider_error',
  unsupported: 'unsupported',
  context_exhausted: 'context_exhausted',
  permission_denied: 'permission_denied',
  policy_denied: 'policy_denied',
  bad_request: 'bad_request',
  transport_lost: 'transport_lost',
  process_crash: 'process_crash',
  context_lost: 'context_lost',
  user_stopped: 'user_stopped',
  internal_error: 'internal_error'
}

export class NativeCodexContextLostError extends Error {
  readonly failure

  constructor(executorId: string, message: string) {
    super(message)
    this.name = 'NativeCodexContextLostError'
    this.failure = createExecutorFailure('context_lost', message, executorId)
  }
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} must be non-empty`)
  return normalized
}

function probeStatus(snapshot: NativeCodexProbeSnapshot): ExecutorProbe['status'] {
  if (snapshot.available) return 'ready'
  if (snapshot.reason === 'not_authenticated' || snapshot.reason === 'non_chatgpt_auth') return 'auth_required'
  if (snapshot.reason === 'unsupported') return 'unsupported'
  return 'unavailable'
}

function ensureSession(executorId: string, session: ExecutorSession | ExecutorSessionRef): void {
  if (session.executorId !== executorId) throw new Error('Native Codex session belongs to a different executor')
  requireNonEmpty(session.sessionId, 'sessionId')
  if (!Number.isSafeInteger(session.generation) || session.generation < 1) {
    throw new Error('Native Codex session generation must be a positive safe integer')
  }
}

export class NativeCodexExecutor implements Zero3Executor {
  readonly descriptor
  readonly #now: () => string

  constructor(
    private readonly driver: NativeCodexDriver,
    private readonly options: NativeCodexExecutorOptions = {}
  ) {
    const id = requireNonEmpty(options.id ?? 'native-codex', 'executor id')
    this.descriptor = {
      id,
      kind: 'native-codex' as const,
      label: requireNonEmpty(options.label ?? 'Native Codex', 'executor label')
    }
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async probe(): Promise<ExecutorProbe> {
    const snapshot = await this.driver.probe()
    return {
      executorId: this.descriptor.id,
      status: probeStatus(snapshot),
      detail: snapshot.reason
    }
  }

  async start(context: ExecutorStartContext): Promise<ExecutorSession> {
    if (context.contract !== ZERO3_EXECUTOR_CONTRACT) throw new Error('unsupported Zero3 Executor Contract')
    const result = await this.driver.startThread(this.startOptions(context))
    return {
      executorId: this.descriptor.id,
      sessionId: requireNonEmpty(result.threadId, 'Codex thread id'),
      generation: context.generation,
      startedAt: this.#now()
    }
  }

  async resume(ref: ExecutorSessionRef, checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession> {
    ensureSession(this.descriptor.id, ref)
    if (checkpoint.protocol !== ZERO3_HANDOFF_PROTOCOL) throw new Error('unsupported handoff checkpoint protocol')
    if (checkpoint.generation !== ref.generation) {
      throw new NativeCodexContextLostError(this.descriptor.id, 'handoff generation does not match Native Codex session')
    }
    try {
      await this.driver.resumeThread(ref.sessionId, {
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {})
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new NativeCodexContextLostError(this.descriptor.id, `Native Codex thread resume failed: ${message}`)
    }
    return { ...ref, startedAt: this.#now() }
  }

  async *prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    ensureSession(this.descriptor.id, session)
    let sequence = 0
    for await (const event of this.driver.prompt(session.sessionId, input)) {
      sequence += 1
      yield this.normalizeEvent(event, sequence)
    }
  }

  async respondPermission(session: ExecutorSession, response: ExecutorPermissionResponse): Promise<void> {
    ensureSession(this.descriptor.id, session)
    await this.driver.respondPermission(session.sessionId, response)
  }

  async cancel(session: ExecutorSession): Promise<void> {
    ensureSession(this.descriptor.id, session)
    await this.driver.cancel(session.sessionId)
  }

  async close(session: ExecutorSession): Promise<void> {
    ensureSession(this.descriptor.id, session)
    await this.driver.close(session.sessionId)
  }

  private startOptions(context: ExecutorStartContext): NativeCodexStartOptions {
    return {
      workspace: requireNonEmpty(context.identity.workspace, 'workspace'),
      policy: { ...context.policy },
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.modelProvider ? { modelProvider: this.options.modelProvider } : {})
    }
  }

  private normalizeEvent(event: NativeCodexDriverEvent, sequence: number): ExecutorEvent {
    const at = this.#now()
    switch (event.type) {
      case 'failure':
        return {
          type: 'failure',
          sequence,
          at,
          failure: createExecutorFailure(FAILURE_MAP[event.reason], event.message, this.descriptor.id)
        }
      case 'message':
      case 'reasoning':
      case 'plan':
      case 'tool.started':
      case 'tool.updated':
      case 'tool.completed':
      case 'file.changed':
      case 'permission.requested':
      case 'usage.updated':
      case 'completed':
        return { ...event, sequence, at }
    }
  }
}

import { failurePolicyFor } from '../failure-normalizer.ts'
import type { ExecutorFailure, ExecutorFailureCode, ExecutorId } from '../executor-types.ts'

export type FailoverAction =
  | { type: 'none'; reason: string }
  | { type: 'retry'; executorId: ExecutorId; attempt: number; maxAttempts: number }
  | { type: 'recover'; executorId: ExecutorId; reason: 'transport_lost' | 'process_crash' }
  | { type: 'handoff'; fromExecutorId: ExecutorId; targetGeneration: number; reason: ExecutorFailureCode }
  | { type: 'request_auth'; executorId: ExecutorId }
  | { type: 'switch'; fromExecutorId: ExecutorId; toExecutorId: ExecutorId; targetGeneration: number; reason: ExecutorFailureCode | 'manual' | 'return_to_primary' }

export interface FailoverConfig {
  candidates: readonly ExecutorId[]
  automaticFailover: boolean
  maxRetries: number
  providerCooldownMs: number
  circuitFailureThreshold: number
  circuitOpenMs: number
  switchOnAuthRequired: boolean
  returnToPrimaryAfterStage: boolean
  maxProcessedEvents?: number
}

interface ProviderState {
  retryCount: number
  consecutiveFailures: number
  cooldownUntilMs: number
  circuitOpenUntilMs: number
}

interface PendingSwitch {
  eventId: string
  action: Extract<FailoverAction, { type: 'switch' }>
}

interface CachedDecision {
  eventId: string
  action: FailoverAction
}

export interface FailoverSnapshot {
  version: 'zero3.pilot.failover.v1'
  currentExecutorId: ExecutorId
  generation: number
  providerState: Record<string, ProviderState>
  processed: CachedDecision[]
  pendingSwitch?: PendingSwitch
}

const RETRY_THEN_SWITCH = new Set<ExecutorFailureCode>(['rate_limited', 'provider_overloaded', 'provider_error'])
const RECOVER_FIRST = new Set<ExecutorFailureCode>(['transport_lost', 'process_crash'])
const HANDOFF_REQUIRED = new Set<ExecutorFailureCode>(['context_lost', 'context_exhausted'])

function validateConfig(config: FailoverConfig): void {
  if (config.candidates.length === 0) throw new Error('failover candidates must not be empty')
  if (new Set(config.candidates).size !== config.candidates.length) throw new Error('failover candidates must be unique')
  for (const [name, value] of [
    ['maxRetries', config.maxRetries],
    ['providerCooldownMs', config.providerCooldownMs],
    ['circuitFailureThreshold', config.circuitFailureThreshold],
    ['circuitOpenMs', config.circuitOpenMs]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  }
  if (config.circuitFailureThreshold < 1) throw new Error('circuitFailureThreshold must be positive')
}

export class Zero3FailoverController {
  readonly #providers = new Map<ExecutorId, ProviderState>()
  readonly #processed = new Map<string, FailoverAction>()
  readonly #processedOrder: string[] = []
  #pendingSwitch?: PendingSwitch
  #currentExecutorId: ExecutorId
  #generation: number

  constructor(readonly config: FailoverConfig, currentExecutorId: ExecutorId, generation = 1) {
    validateConfig(config)
    if (!config.candidates.includes(currentExecutorId)) throw new Error('current executor must be in candidate order')
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation must be a positive safe integer')
    this.#currentExecutorId = currentExecutorId
    this.#generation = generation
    for (const id of config.candidates) this.#providers.set(id, this.emptyProviderState())
  }

  current(): { executorId: ExecutorId; generation: number } {
    return { executorId: this.#currentExecutorId, generation: this.#generation }
  }

  onFailure(eventId: string, failure: ExecutorFailure, nowMs: number): FailoverAction {
    this.assertEventId(eventId)
    this.assertTime(nowMs)
    const cached = this.#processed.get(eventId)
    if (cached) return cached
    if (this.#pendingSwitch) return this.remember(eventId, { type: 'none', reason: 'switch already pending handoff verification' })
    if (failure.source !== this.#currentExecutorId && failure.source !== 'executor-core') {
      return this.remember(eventId, { type: 'none', reason: 'failure source does not match current executor' })
    }

    const code = failure.code
    const safety = failurePolicyFor(code)
    if (safety.failover === 'forbidden') return this.remember(eventId, { type: 'none', reason: `automatic failover forbidden for ${code}` })
    if (code === 'user_stopped') return this.remember(eventId, { type: 'none', reason: 'user stopped execution' })

    const state = this.provider(this.#currentExecutorId)
    state.consecutiveFailures += 1
    if (state.consecutiveFailures >= this.config.circuitFailureThreshold) {
      state.circuitOpenUntilMs = Math.max(state.circuitOpenUntilMs, nowMs + this.config.circuitOpenMs)
    }

    if (RECOVER_FIRST.has(code)) {
      return this.remember(eventId, { type: 'recover', executorId: this.#currentExecutorId, reason: code as 'transport_lost' | 'process_crash' })
    }
    if (HANDOFF_REQUIRED.has(code)) {
      return this.remember(eventId, { type: 'handoff', fromExecutorId: this.#currentExecutorId, targetGeneration: this.#generation + 1, reason: code })
    }
    if (code === 'auth_required' && !this.config.switchOnAuthRequired) {
      return this.remember(eventId, { type: 'request_auth', executorId: this.#currentExecutorId })
    }
    if (!this.config.automaticFailover) return this.remember(eventId, { type: 'none', reason: 'automatic failover disabled' })

    if (RETRY_THEN_SWITCH.has(code) && state.retryCount < this.config.maxRetries) {
      state.retryCount += 1
      return this.remember(eventId, { type: 'retry', executorId: this.#currentExecutorId, attempt: state.retryCount, maxAttempts: this.config.maxRetries })
    }

    if (RETRY_THEN_SWITCH.has(code) || code === 'quota_exhausted' || code === 'unsupported' || (code === 'auth_required' && this.config.switchOnAuthRequired)) {
      state.cooldownUntilMs = Math.max(state.cooldownUntilMs, nowMs + this.config.providerCooldownMs)
      return this.remember(eventId, this.planSwitch(eventId, code, nowMs))
    }
    return this.remember(eventId, { type: 'none', reason: `no automatic policy for ${code}` })
  }

  onRecoveryFailed(eventId: string, reason: 'transport_lost' | 'process_crash'): FailoverAction {
    this.assertEventId(eventId)
    const recoveryEventId = `${eventId}:recovery-failed`
    const cached = this.#processed.get(recoveryEventId)
    if (cached) return cached
    return this.remember(recoveryEventId, {
      type: 'handoff',
      fromExecutorId: this.#currentExecutorId,
      targetGeneration: this.#generation + 1,
      reason
    })
  }

  manualSwitch(eventId: string, executorId: ExecutorId): FailoverAction {
    this.assertEventId(eventId)
    const cached = this.#processed.get(eventId)
    if (cached) return cached
    if (this.#pendingSwitch) return this.remember(eventId, { type: 'none', reason: 'switch already pending handoff verification' })
    if (!this.config.candidates.includes(executorId)) throw new Error('manual executor is not in candidate order')
    if (executorId === this.#currentExecutorId) return this.remember(eventId, { type: 'none', reason: 'executor already current' })
    const action: Extract<FailoverAction, { type: 'switch' }> = {
      type: 'switch', fromExecutorId: this.#currentExecutorId, toExecutorId: executorId, targetGeneration: this.#generation + 1, reason: 'manual'
    }
    this.#pendingSwitch = { eventId, action }
    return this.remember(eventId, action)
  }

  stageBoundary(eventId: string, nowMs: number): FailoverAction {
    this.assertTime(nowMs)
    const cached = this.#processed.get(eventId)
    if (cached) return cached
    const primary = this.config.candidates[0]
    if (!this.config.returnToPrimaryAfterStage || this.#currentExecutorId === primary || !this.available(primary, nowMs)) {
      return this.remember(eventId, { type: 'none', reason: 'return-to-primary not required or primary unavailable' })
    }
    const action: Extract<FailoverAction, { type: 'switch' }> = {
      type: 'switch', fromExecutorId: this.#currentExecutorId, toExecutorId: primary, targetGeneration: this.#generation + 1, reason: 'return_to_primary'
    }
    this.#pendingSwitch = { eventId, action }
    return this.remember(eventId, action)
  }

  commitVerifiedSwitch(eventId: string, acceptedGeneration: number): void {
    const pending = this.#pendingSwitch
    if (!pending || pending.eventId !== eventId) throw new Error('no matching pending switch')
    if (acceptedGeneration !== pending.action.targetGeneration) throw new Error('verified handoff generation does not match pending switch')
    this.#currentExecutorId = pending.action.toExecutorId
    this.#generation = acceptedGeneration
    this.#pendingSwitch = undefined
    this.recordSuccess(this.#currentExecutorId)
  }

  abortSwitch(eventId: string): void {
    if (!this.#pendingSwitch || this.#pendingSwitch.eventId !== eventId) throw new Error('no matching pending switch')
    this.#pendingSwitch = undefined
  }

  recordSuccess(executorId: ExecutorId): void {
    const state = this.provider(executorId)
    state.retryCount = 0
    state.consecutiveFailures = 0
    state.circuitOpenUntilMs = 0
  }

  snapshot(): FailoverSnapshot {
    return {
      version: 'zero3.pilot.failover.v1',
      currentExecutorId: this.#currentExecutorId,
      generation: this.#generation,
      providerState: Object.fromEntries([...this.#providers].map(([id, state]) => [id, { ...state }])),
      processed: this.#processedOrder.map(eventId => ({ eventId, action: this.#processed.get(eventId)! })),
      ...(this.#pendingSwitch ? { pendingSwitch: { eventId: this.#pendingSwitch.eventId, action: { ...this.#pendingSwitch.action } } } : {})
    }
  }

  static restore(config: FailoverConfig, snapshot: FailoverSnapshot): Zero3FailoverController {
    if (snapshot.version !== 'zero3.pilot.failover.v1') throw new Error('unsupported failover snapshot version')
    const controller = new Zero3FailoverController(config, snapshot.currentExecutorId, snapshot.generation)
    for (const id of config.candidates) {
      const saved = snapshot.providerState[id]
      if (!saved) throw new Error(`missing provider state: ${id}`)
      controller.#providers.set(id, { ...saved })
    }
    for (const entry of snapshot.processed) controller.remember(entry.eventId, entry.action)
    if (snapshot.pendingSwitch) controller.#pendingSwitch = { eventId: snapshot.pendingSwitch.eventId, action: { ...snapshot.pendingSwitch.action } }
    return controller
  }

  private planSwitch(eventId: string, reason: ExecutorFailureCode, nowMs: number): FailoverAction {
    const next = this.nextAvailable(nowMs)
    if (!next) return { type: 'none', reason: 'no eligible fallback executor' }
    const action: Extract<FailoverAction, { type: 'switch' }> = {
      type: 'switch', fromExecutorId: this.#currentExecutorId, toExecutorId: next, targetGeneration: this.#generation + 1, reason
    }
    this.#pendingSwitch = { eventId, action }
    return action
  }

  private nextAvailable(nowMs: number): ExecutorId | undefined {
    const index = this.config.candidates.indexOf(this.#currentExecutorId)
    for (let offset = 1; offset < this.config.candidates.length; offset += 1) {
      const candidate = this.config.candidates[(index + offset) % this.config.candidates.length]
      if (this.available(candidate, nowMs)) return candidate
    }
    return undefined
  }

  private available(executorId: ExecutorId, nowMs: number): boolean {
    const state = this.provider(executorId)
    return nowMs >= state.cooldownUntilMs && nowMs >= state.circuitOpenUntilMs
  }

  private provider(executorId: ExecutorId): ProviderState {
    const state = this.#providers.get(executorId)
    if (!state) throw new Error(`executor not configured for failover: ${executorId}`)
    return state
  }

  private remember(eventId: string, action: FailoverAction): FailoverAction {
    if (this.#processed.has(eventId)) return this.#processed.get(eventId)!
    this.#processed.set(eventId, action)
    this.#processedOrder.push(eventId)
    const limit = this.config.maxProcessedEvents ?? 1024
    while (this.#processedOrder.length > limit) {
      const oldest = this.#processedOrder.shift()!
      this.#processed.delete(oldest)
    }
    return action
  }

  private emptyProviderState(): ProviderState {
    return { retryCount: 0, consecutiveFailures: 0, cooldownUntilMs: 0, circuitOpenUntilMs: 0 }
  }

  private assertEventId(eventId: string): void {
    if (!eventId.trim()) throw new Error('failure event id must be non-empty')
  }

  private assertTime(nowMs: number): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('nowMs must be a non-negative safe integer')
  }
}

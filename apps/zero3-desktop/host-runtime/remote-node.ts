import { loadZero3RemoteHostConfig } from './remote-config'
import {
  Zero3RemoteClient,
  zero3RemoteControlPlaneRejectedStaleEnvelope
} from './remote-client'
import { evaluateZero3CompletionGate } from './remote-completion-gate'
import { drainZero3RemoteOutboxInOrder, type Zero3RemotePublishEnvelopeResult } from './remote-outbox-drain'
import { Zero3RemoteOutbox } from './remote-outbox'
import {
  Zero3RemoteTaskBlockedError,
  Zero3RemoteTaskOutcomeUnknownError,
  Zero3RemoteTaskRunner,
  type Zero3CodexRuntime
} from './remote-task-runner'
import type {
  Zero3RemoteHostStatus,
  Zero3RemoteLease,
  Zero3RemoteOutboxEnvelope,
  Zero3RemoteTerminalState
} from './remote-types'

const HEARTBEAT_INTERVAL_MS = 15_000
const LEASE_RENEW_INTERVAL_MS = 10_000
const LEASE_RETRY_MIN_MS = 1_000
const LEASE_RETRY_MAX_MS = 30_000

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class Zero3RemoteDeliveryPendingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Zero3RemoteDeliveryPendingError'
  }
}

export class Zero3RemoteNode {
  private readonly config = loadZero3RemoteHostConfig()
  private readonly client = new Zero3RemoteClient(this.config)
  private readonly outbox = new Zero3RemoteOutbox(this.config.outboxDir)
  private readonly runner: Zero3RemoteTaskRunner
  private stopped = false
  private running: Promise<void> | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private leaseRenewTimer: NodeJS.Timeout | null = null
  private activeLeaseInvalid = false
  private statusValue: Zero3RemoteHostStatus

  constructor(codex: Zero3CodexRuntime) {
    this.runner = new Zero3RemoteTaskRunner(this.config, codex)
    this.statusValue = {
      enabled: this.config.enabled,
      connected: false,
      nodeId: this.config.nodeId,
      activeTaskId: null,
      pendingDeliveries: 0,
      lastError: null,
      lastHeartbeatAt: null
    }
  }

  status(): Zero3RemoteHostStatus {
    return { ...this.statusValue }
  }

  start(): void {
    if (!this.config.enabled || this.running) return
    this.stopped = false
    this.running = this.loop().finally(() => {
      this.running = null
      this.statusValue.connected = false
    })
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
    this.heartbeatTimer = null
    this.leaseRenewTimer = null
    this.client.close()
    this.statusValue.connected = false
  }

  private async refreshPendingDeliveries(): Promise<void> {
    this.statusValue.pendingDeliveries = await this.outbox.count()
  }

  private async heartbeat(): Promise<void> {
    await this.refreshPendingDeliveries()
    await this.client.heartbeat(this.status())
    this.statusValue.connected = true
    this.statusValue.lastHeartbeatAt = new Date().toISOString()
  }

  private async publishEnvelope(envelope: Zero3RemoteOutboxEnvelope): Promise<Zero3RemotePublishEnvelopeResult> {
    try {
      await this.client.publishEnvelope(envelope)
      await this.outbox.ack(envelope.deliveryId)
      await this.refreshPendingDeliveries()
      return 'published'
    } catch (error) {
      if (zero3RemoteControlPlaneRejectedStaleEnvelope(error)) {
        const reason = error instanceof Error ? error.message : String(error)
        await this.outbox.quarantine(envelope, reason)
        if (this.statusValue.activeTaskId === envelope.taskId) this.activeLeaseInvalid = true
        await this.refreshPendingDeliveries()
        this.statusValue.lastError = `remote outbox envelope quarantined after stale lease/fencing rejection: ${reason}`
        return 'quarantined'
      }
      await this.refreshPendingDeliveries()
      throw error
    }
  }

  private async flushOutbox(targetDeliveryId?: string): Promise<Zero3RemotePublishEnvelopeResult | null> {
    return drainZero3RemoteOutboxInOrder(
      await this.outbox.list(),
      envelope => this.publishEnvelope(envelope),
      targetDeliveryId,
      envelope => !this.stopped && !(this.activeLeaseInvalid && this.statusValue.activeTaskId === envelope.taskId)
    )
  }

  private async durableEvent(
    lease: Zero3RemoteLease,
    eventType: string,
    payload: unknown,
    requireImmediateDelivery: boolean
  ): Promise<void> {
    const envelope = await this.outbox.enqueueEvent(lease, eventType, payload)
    await this.refreshPendingDeliveries()
    if (this.activeLeaseInvalid) {
      if (requireImmediateDelivery) {
        throw new Zero3RemoteDeliveryPendingError('required remote event cannot be published because the active lease is invalid')
      }
      return
    }
    try {
      const result = await this.flushOutbox(envelope.deliveryId)
      if (result === 'quarantined' && requireImmediateDelivery) {
        throw new Zero3RemoteDeliveryPendingError('required remote event was rejected as stale; local Codex execution was not started')
      }
      if (result == null && requireImmediateDelivery) {
        throw new Zero3RemoteDeliveryPendingError('required remote event was not published in durable outbox order')
      }
    } catch (error) {
      if (error instanceof Zero3RemoteDeliveryPendingError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      if (requireImmediateDelivery) {
        throw new Zero3RemoteDeliveryPendingError(`required remote event is durably pending: ${reason}`)
      }
      this.statusValue.lastError = `remote evidence is durably pending: ${reason}`
    }
  }

  private async durableTerminal(
    lease: Zero3RemoteLease,
    state: Zero3RemoteTerminalState,
    result: unknown
  ): Promise<void> {
    const envelope = await this.outbox.enqueueTerminal(lease, state, result)
    await this.refreshPendingDeliveries()
    if (this.activeLeaseInvalid) return
    try {
      const published = await this.flushOutbox(envelope.deliveryId)
      if (published == null) {
        throw new Zero3RemoteDeliveryPendingError('terminal result is durable but waiting behind an earlier pending envelope')
      }
    } catch (error) {
      if (error instanceof Zero3RemoteDeliveryPendingError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new Zero3RemoteDeliveryPendingError(`terminal result is durably pending: ${reason}`)
    }
  }

  private async loop(): Promise<void> {
    let retryMs = LEASE_RETRY_MIN_MS
    while (!this.stopped) {
      try {
        await this.client.register(['codex', 'thread', 'turn', 'shell', 'file', 'git', 'mcp'])
        this.statusValue.connected = true
        this.statusValue.lastError = null
        await this.flushOutbox()
        await this.heartbeat()
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = setInterval(() => {
          void this.heartbeat().catch(error => {
            this.statusValue.connected = false
            this.statusValue.lastError = error instanceof Error ? error.message : String(error)
          })
        }, HEARTBEAT_INTERVAL_MS)

        retryMs = LEASE_RETRY_MIN_MS
        while (!this.stopped) {
          await this.flushOutbox()
          const lease = await this.client.lease(25)
          if (!lease) continue
          const taskId = lease.task?.task_id
          if (!taskId) throw new Error('leased remote task is missing task_id')
          if (this.statusValue.activeTaskId) {
            await this.durableTerminal(lease, 'blocked', {
              reason: 'local Zero3 Remote Host already has an active remote task'
            })
            continue
          }

          this.statusValue.activeTaskId = taskId
          this.activeLeaseInvalid = false
          let terminalDurable = false
          try {
            // The accepted event is persisted before publication, and Codex side
            // effects do not begin unless the current lease can be correlated to
            // the control plane at least once. Every publication drains older
            // durable envelopes first, so accepted/evidence/terminal cannot overtake.
            await this.durableEvent(lease, 'host.accepted', { node_id: this.config.nodeId }, true)

            if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
            this.leaseRenewTimer = setInterval(() => {
              void this.client.renew(taskId, lease).catch(error => {
                if (zero3RemoteControlPlaneRejectedStaleEnvelope(error)) {
                  this.activeLeaseInvalid = true
                }
                this.statusValue.lastError = `remote task lease renewal failed: ${error instanceof Error ? error.message : String(error)}`
              })
            }, LEASE_RENEW_INTERVAL_MS)

            const result = await this.runner.run(lease, async (_sequence, method, payload) => {
              await this.durableEvent(lease, `codex.${method}`, payload, false)
            })

            if (result.state === 'succeeded') {
              const executionResult = result.executionResult
              const gate = evaluateZero3CompletionGate({
                task: result.task,
                turnStatus: result.terminal.status,
                agentSummary: executionResult.agent_summary,
                gitPreflight: {
                  headCommit: executionResult.git_preflight.head_commit,
                  baseCommit: executionResult.git_preflight.base_commit,
                  cleanWorktree: executionResult.git_preflight.clean_worktree
                },
                gitPostflight: executionResult.git_postflight
                  ? {
                      headCommit: executionResult.git_postflight.head_commit,
                      cleanWorktree: executionResult.git_postflight.clean_worktree,
                      upstreamCommit: executionResult.git_postflight.upstream_commit ?? null,
                      remoteSynced: executionResult.git_postflight.remote_synced ?? null
                    }
                  : null,
                executionResultReady: executionResult.protocol === 'zero3.pilot.execution-result.v1'
              })
              if (!gate.ok) {
                const missing = gate.missing.length ? `missing=${gate.missing.join(',')}` : ''
                const unsupported = gate.unsupported.length ? `unsupported=${gate.unsupported.join(',')}` : ''
                throw new Zero3RemoteTaskBlockedError(
                  `required handoff evidence gate rejected completion: ${[missing, unsupported].filter(Boolean).join('; ')}`
                )
              }
            }

            const terminalEnvelope = await this.outbox.enqueueTerminal(lease, result.state, result)
            terminalDurable = true
            await this.refreshPendingDeliveries()
            if (!this.activeLeaseInvalid) await this.flushOutbox(terminalEnvelope.deliveryId)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            const terminalState: Zero3RemoteTerminalState =
              error instanceof Zero3RemoteTaskBlockedError
                ? 'blocked'
                : error instanceof Zero3RemoteTaskOutcomeUnknownError
                  ? 'outcome_unknown'
                  : 'failed'

            if (
              !terminalDurable &&
              !this.stopped &&
              !(error instanceof Zero3RemoteDeliveryPendingError)
            ) {
              try {
                const envelope = await this.outbox.enqueueTerminal(lease, terminalState, { reason })
                terminalDurable = true
                await this.refreshPendingDeliveries()
                if (!this.activeLeaseInvalid) await this.flushOutbox(envelope.deliveryId)
              } catch (terminalError) {
                this.statusValue.lastError = `remote terminal persistence/publication failed: ${terminalError instanceof Error ? terminalError.message : String(terminalError)}`
              }
            }
            this.statusValue.lastError = reason
          } finally {
            if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
            this.leaseRenewTimer = null
            this.activeLeaseInvalid = false
            this.statusValue.activeTaskId = null
          }
        }
      } catch (error) {
        this.statusValue.connected = false
        this.statusValue.lastError = error instanceof Error ? error.message : String(error)
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
        this.heartbeatTimer = null
        this.leaseRenewTimer = null
        this.activeLeaseInvalid = false
        if (!this.stopped) await delay(retryMs)
        retryMs = Math.min(retryMs * 2, LEASE_RETRY_MAX_MS)
      }
    }
  }
}

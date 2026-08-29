import { loadZero3RemoteHostConfig } from './remote-config'
import { Zero3RemoteClient } from './remote-client'
import { Zero3RemoteTaskRunner, type Zero3CodexRuntime } from './remote-task-runner'
import type { Zero3RemoteHostStatus } from './remote-types'

const HEARTBEAT_INTERVAL_MS = 15_000
const LEASE_RENEW_INTERVAL_MS = 10_000
const LEASE_RETRY_MIN_MS = 1_000
const LEASE_RETRY_MAX_MS = 30_000

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class Zero3RemoteNode {
  private readonly config = loadZero3RemoteHostConfig()
  private readonly client = new Zero3RemoteClient(this.config)
  private readonly runner: Zero3RemoteTaskRunner
  private stopped = false
  private running: Promise<void> | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private leaseRenewTimer: NodeJS.Timeout | null = null
  private statusValue: Zero3RemoteHostStatus

  constructor(codex: Zero3CodexRuntime) {
    this.runner = new Zero3RemoteTaskRunner(this.config, codex)
    this.statusValue = {
      enabled: this.config.enabled,
      connected: false,
      nodeId: this.config.nodeId,
      activeTaskId: null,
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

  private async heartbeat(): Promise<void> {
    await this.client.heartbeat(this.status())
    this.statusValue.connected = true
    this.statusValue.lastHeartbeatAt = new Date().toISOString()
  }

  private async loop(): Promise<void> {
    let retryMs = LEASE_RETRY_MIN_MS
    while (!this.stopped) {
      try {
        await this.client.register(['codex', 'thread', 'turn', 'shell', 'file', 'git', 'mcp'])
        this.statusValue.connected = true
        this.statusValue.lastError = null
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
          const lease = await this.client.lease(25)
          if (!lease) continue
          const taskId = lease.task?.task_id
          if (!taskId) throw new Error('leased remote task is missing task_id')
          if (this.statusValue.activeTaskId) {
            await this.client.terminal(taskId, lease, 'blocked', {
              reason: 'local Zero3 Remote Host already has an active remote task'
            })
            continue
          }

          this.statusValue.activeTaskId = taskId
          let terminalSent = false
          try {
            await this.client.event(taskId, lease, 1, 'host.accepted', {
              node_id: this.config.nodeId
            })

            if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
            this.leaseRenewTimer = setInterval(() => {
              void this.client.renew(taskId, lease).catch(error => {
                // The control plane remains authoritative for lease/fencing.
                // A renewal failure is surfaced and later event/terminal writes
                // still carry the same fencing token; stale writers are refused.
                this.statusValue.lastError = `remote task lease renewal failed: ${error instanceof Error ? error.message : String(error)}`
              })
            }, LEASE_RENEW_INTERVAL_MS)

            const result = await this.runner.run(lease, async (sequence, method, payload) => {
              await this.client.event(taskId, lease, sequence + 1, `codex.${method}`, payload)
            })
            await this.client.terminal(taskId, lease, result.state, result)
            terminalSent = true
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            if (!terminalSent && !this.stopped) {
              try {
                await this.client.terminal(taskId, lease, 'failed', { reason })
              } catch {
                // If terminal publication itself fails, keep the local error visible.
                // The control plane's lease/fencing/reconciliation path must decide
                // whether the remote outcome is unknown; do not invent success here.
              }
            }
            this.statusValue.lastError = reason
          } finally {
            if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
            this.leaseRenewTimer = null
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
        if (!this.stopped) await delay(retryMs)
        retryMs = Math.min(retryMs * 2, LEASE_RETRY_MAX_MS)
      }
    }
  }
}

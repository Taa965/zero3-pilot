import fs from 'node:fs'

import type {
  Zero3RemoteHostConfig,
  Zero3RemoteHostStatus,
  Zero3RemoteLease,
  Zero3RemoteOutboxEnvelope,
  Zero3RemoteTask,
  Zero3RemoteTaskState
} from './remote-types'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

function readToken(config: Zero3RemoteHostConfig): string {
  if (!config.tokenFile) throw new Error('Zero3 Remote Host token file is not configured')
  const token = fs.readFileSync(config.tokenFile, 'utf8').trim()
  if (!token) throw new Error('Zero3 Remote Host token file is empty')
  return token
}

function endpoint(config: Zero3RemoteHostConfig, pathname: string): string {
  if (!config.baseUrl) throw new Error('Zero3 Remote Host control-plane URL is not configured')
  return `${config.baseUrl}${pathname}`
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Zero3 Remote Host control-plane response exceeds the local size limit')
  }
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Zero3 Remote Host control plane returned invalid JSON (HTTP ${response.status})`)
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class Zero3RemoteControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'Zero3RemoteControlPlaneError'
  }
}

export function zero3RemoteControlPlaneRejectedStaleEnvelope(error: unknown): boolean {
  return error instanceof Zero3RemoteControlPlaneError && [409, 410, 412].includes(error.status)
}

export class Zero3RemoteClient {
  private readonly activeControllers = new Set<AbortController>()
  private closed = false

  constructor(private readonly config: Zero3RemoteHostConfig) {}

  close(): void {
    this.closed = true
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
  }

  private async request(pathname: string, init: RequestInit, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) throw new Error('Zero3 Remote Host client is closed')
    const body = typeof init.body === 'string' ? init.body : null
    if (body != null && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      throw new Error('Zero3 Remote Host request exceeds the local size limit')
    }

    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${readToken(this.config)}`)
    headers.set('x-zero3-node-id', this.config.nodeId)
    headers.set('content-type', 'application/json')

    const controller = new AbortController()
    this.activeControllers.add(controller)
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs))
    try {
      const response = await fetch(endpoint(this.config, pathname), {
        ...init,
        headers,
        signal: controller.signal
      })
      const payload = await responseJson(response)
      if (!response.ok) {
        const detail =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error?: unknown }).error)
            : ''
        throw new Zero3RemoteControlPlaneError(
          response.status,
          `Zero3 Remote Host control-plane request failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`
        )
      }
      return payload
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(this.closed ? 'Zero3 Remote Host request cancelled during shutdown' : 'Zero3 Remote Host request timed out')
      }
      throw error
    } finally {
      clearTimeout(timer)
      this.activeControllers.delete(controller)
    }
  }

  private async taskExtension(taskId: string, executionId: string): Promise<Partial<Zero3RemoteTask> | null> {
    let payload: unknown
    try {
      payload = await this.request(`/api/host/v1/tasks/${encodeURIComponent(taskId)}/extensions`, { method: 'GET' })
    } catch (error) {
      // Backward compatibility while older H5 deployments roll forward: an
      // absent extension route means legacy task semantics, not task failure.
      if (error instanceof Zero3RemoteControlPlaneError && error.status === 404) return null
      throw error
    }
    const extension = record(payload)
    const version = Number(extension.version ?? 0)
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('remote task extension has an invalid version')
    if (version === 0) return null
    if (extension.schema !== 'zero3.pilot.task-extension.v1') throw new Error('unsupported remote task extension schema')
    if (extension.task_id !== taskId) throw new Error('remote task extension task_id mismatch')
    if (extension.execution_id !== executionId) throw new Error('remote task extension execution_id mismatch')

    return {
      ...(extension.project_context == null ? {} : { project_context: extension.project_context as Zero3RemoteTask['project_context'] }),
      ...(extension.handoff == null ? {} : { handoff: extension.handoff as Zero3RemoteTask['handoff'] })
    }
  }

  async register(capabilities: string[]): Promise<void> {
    await this.request('/api/host/v1/nodes/register', {
      method: 'POST',
      body: JSON.stringify({ node_id: this.config.nodeId, capabilities })
    })
  }

  async heartbeat(status: Zero3RemoteHostStatus): Promise<void> {
    await this.request(`/api/host/v1/nodes/${encodeURIComponent(this.config.nodeId)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        node_id: this.config.nodeId,
        active_task_id: status.activeTaskId,
        pending_deliveries: status.pendingDeliveries,
        at: new Date().toISOString()
      })
    })
  }

  async lease(waitSeconds = 25): Promise<Zero3RemoteLease | null> {
    const boundedWait = Math.max(1, Math.min(waitSeconds, 30))
    const payload = await this.request(
      '/api/host/v1/tasks/lease',
      {
        method: 'POST',
        body: JSON.stringify({
          node_id: this.config.nodeId,
          wait_seconds: boundedWait,
          capabilities: ['codex', 'thread', 'turn', 'shell', 'file', 'git', 'mcp']
        })
      },
      (boundedWait + 10) * 1000
    )
    if (payload == null) return null
    if (typeof payload !== 'object') throw new Error('Remote lease response must be an object or null')
    const lease = payload as unknown as Zero3RemoteLease
    if (!lease.task) return null

    const extension = await this.taskExtension(lease.task.task_id, lease.task.execution_id)
    if (!extension) return lease
    if (extension.project_context && lease.task.project_context && !sameJson(extension.project_context, lease.task.project_context)) {
      throw new Error('remote task project_context conflicts with the H5 task extension envelope')
    }
    if (extension.handoff && lease.task.handoff && !sameJson(extension.handoff, lease.task.handoff)) {
      throw new Error('remote task handoff conflicts with the H5 task extension envelope')
    }
    return {
      ...lease,
      task: {
        ...lease.task,
        ...extension
      }
    }
  }

  async renew(taskId: string, lease: Zero3RemoteLease): Promise<void> {
    await this.request(`/api/host/v1/tasks/${encodeURIComponent(taskId)}/renew`, {
      method: 'POST',
      body: JSON.stringify({
        node_id: this.config.nodeId,
        lease_id: lease.lease_id,
        fencing_token: lease.fencing_token
      })
    })
  }

  async publishEnvelope(envelope: Zero3RemoteOutboxEnvelope): Promise<void> {
    if (envelope.kind === 'event') {
      await this.request(`/api/host/v1/tasks/${encodeURIComponent(envelope.taskId)}/events`, {
        method: 'POST',
        body: JSON.stringify({
          delivery_id: envelope.deliveryId,
          execution_id: envelope.executionId,
          lease_id: envelope.leaseId,
          fencing_token: envelope.fencingToken,
          event_sequence: envelope.eventSequence,
          event_type: envelope.eventType,
          created_at: envelope.createdAt,
          payload: envelope.payload
        })
      })
      return
    }

    const suffix = envelope.state === 'succeeded' ? 'complete' : envelope.state === 'blocked' ? 'blocked' : 'fail'
    await this.request(`/api/host/v1/tasks/${encodeURIComponent(envelope.taskId)}/${suffix}`, {
      method: 'POST',
      body: JSON.stringify({
        delivery_id: envelope.deliveryId,
        execution_id: envelope.executionId,
        lease_id: envelope.leaseId,
        fencing_token: envelope.fencingToken,
        created_at: envelope.createdAt,
        state: envelope.state,
        result: envelope.result
      })
    })
  }

  async event(taskId: string, lease: Zero3RemoteLease, sequence: number, type: string, payload: unknown): Promise<void> {
    await this.request(`/api/host/v1/tasks/${encodeURIComponent(taskId)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        lease_id: lease.lease_id,
        fencing_token: lease.fencing_token,
        event_sequence: sequence,
        event_type: type,
        created_at: new Date().toISOString(),
        payload
      })
    })
  }

  async terminal(
    taskId: string,
    lease: Zero3RemoteLease,
    state: Extract<Zero3RemoteTaskState, 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'outcome_unknown' | 'quarantined'>,
    result: unknown
  ): Promise<void> {
    const suffix = state === 'succeeded' ? 'complete' : state === 'blocked' ? 'blocked' : 'fail'
    await this.request(`/api/host/v1/tasks/${encodeURIComponent(taskId)}/${suffix}`, {
      method: 'POST',
      body: JSON.stringify({
        lease_id: lease.lease_id,
        fencing_token: lease.fencing_token,
        state,
        result
      })
    })
  }
}

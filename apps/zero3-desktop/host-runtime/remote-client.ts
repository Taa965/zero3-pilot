import fs from 'node:fs'

import type {
  Zero3RemoteHostConfig,
  Zero3RemoteHostStatus,
  Zero3RemoteLease,
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
        throw new Error(
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
    const record = payload as Record<string, unknown>
    if (record.task == null) return null
    return record as unknown as Zero3RemoteLease
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

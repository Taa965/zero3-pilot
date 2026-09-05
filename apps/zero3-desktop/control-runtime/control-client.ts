import fs from 'node:fs'

export type Zero3ControlConfig = {
  baseUrl: string | null
  tokenFile: string | null
  developmentAllowHttp: boolean
}

export type Zero3ControlStatus = {
  configured: boolean
  baseUrl: string | null
}

export type Zero3ControlDispatchRequest = {
  task: Record<string, unknown>
  extension?: {
    project_context?: unknown
    handoff?: unknown
    provider?: unknown
    review?: unknown
  }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const REMOTE_TASK_PROTOCOL = 'zero3.pilot.remote-task.v1'
const TASK_EXTENSION_SCHEMA = 'zero3.pilot.task-extension.v1'

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return text
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === '') return undefined
  return requiredText(value, label, max)
}

function listOfText(value: unknown, label: string): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} must contain at most 64 items`)
  return value.map((entry, index) => requiredText(entry, `${label}[${index}]`, 4096))
}

function readControlToken(config: Zero3ControlConfig): string {
  if (!config.tokenFile) throw new Error('Zero3 control token file is not configured')
  const token = fs.readFileSync(config.tokenFile, 'utf8').trim()
  if (!token) throw new Error('Zero3 control token file is empty')
  return token
}

function normalizeBaseUrl(value: string | null, allowHttp: boolean): string | null {
  if (!value) return null
  const parsed = new URL(value)
  if (parsed.username || parsed.password) throw new Error('Zero3 control-plane URL must not contain inline credentials')
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new Error('Zero3 control-plane URL must use HTTPS')
  }
  return parsed.toString().replace(/\/$/, '')
}

export function loadZero3ControlConfig(): Zero3ControlConfig {
  const developmentAllowHttp = ['1', 'true', 'yes', 'on'].includes(
    (process.env.ZERO3_CONTROL_ALLOW_HTTP ?? process.env.ZERO3_REMOTE_HOST_ALLOW_HTTP ?? '').trim().toLowerCase()
  )
  const baseUrl = normalizeBaseUrl(
    process.env.ZERO3_CONTROL_BASE_URL?.trim() || process.env.ZERO3_REMOTE_HOST_BASE_URL?.trim() || null,
    developmentAllowHttp
  )
  const tokenFile = process.env.ZERO3_CONTROL_TOKEN_FILE?.trim() || null
  if (tokenFile && !fs.statSync(tokenFile).isFile()) throw new Error('ZERO3_CONTROL_TOKEN_FILE does not point to a file')
  return { baseUrl, tokenFile, developmentAllowHttp }
}

function normalizedTask(value: unknown): Record<string, unknown> {
  const task = record(value, 'task')
  if (task.protocol !== REMOTE_TASK_PROTOCOL) throw new Error('unsupported Zero3 remote task protocol')
  const target = record(task.target, 'task.target')
  const execution = task.execution == null ? {} : record(task.execution, 'task.execution')
  const permission = optionalText(task.permission_profile, 'task.permission_profile', 32) ?? 'standard'
  if (!['read_only', 'standard', 'elevated', 'full_control'].includes(permission)) {
    throw new Error('unsupported task.permission_profile')
  }
  const maxTurns = execution.max_turns == null ? 1 : Number(execution.max_turns)
  const timeoutSeconds = execution.timeout_seconds == null ? 3600 : Number(execution.timeout_seconds)
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) throw new Error('task.execution.max_turns must be 1..32')
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 28_800) {
    throw new Error('task.execution.timeout_seconds must be 30..28800')
  }
  const baseRef = optionalText(target.base_ref, 'task.target.base_ref', 256)
  if (baseRef?.startsWith('-')) throw new Error('task.target.base_ref must not start with a dash')

  return {
    protocol: REMOTE_TASK_PROTOCOL,
    task_id: requiredText(task.task_id, 'task.task_id', 128),
    execution_id: requiredText(task.execution_id, 'task.execution_id', 128),
    objective: requiredText(task.objective, 'task.objective', 64_000),
    target: {
      workspace: requiredText(target.workspace, 'task.target.workspace', 4096),
      ...(baseRef ? { base_ref: baseRef } : {})
    },
    ...(listOfText(task.constraints, 'task.constraints') ? { constraints: listOfText(task.constraints, 'task.constraints') } : {}),
    ...(listOfText(task.acceptance_criteria, 'task.acceptance_criteria')
      ? { acceptance_criteria: listOfText(task.acceptance_criteria, 'task.acceptance_criteria') }
      : {}),
    permission_profile: permission,
    execution: {
      max_turns: maxTurns,
      timeout_seconds: timeoutSeconds,
      require_clean_worktree: execution.require_clean_worktree === true
    }
  }
}

function normalizedExtension(task: Record<string, unknown>, value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  const input = record(value, 'extension')
  const hasExtension = ['project_context', 'handoff', 'provider', 'review'].some(key => input[key] != null)
  if (!hasExtension) return null
  return {
    schema: TASK_EXTENSION_SCHEMA,
    execution_id: requiredText(task.execution_id, 'task.execution_id', 128),
    expected_version: 0,
    ...(input.project_context == null ? {} : { project_context: input.project_context }),
    ...(input.handoff == null ? {} : { handoff: input.handoff }),
    ...(input.provider == null ? {} : { provider: input.provider }),
    ...(input.review == null ? {} : { review: input.review })
  }
}

export class Zero3ControlClient {
  readonly config: Zero3ControlConfig

  constructor(config: Zero3ControlConfig = loadZero3ControlConfig()) {
    this.config = config
  }

  status(): Zero3ControlStatus {
    return { configured: Boolean(this.config.baseUrl && this.config.tokenFile), baseUrl: this.config.baseUrl }
  }

  async listTasks(): Promise<unknown> {
    return this.request('/api/control/v1/tasks', { method: 'GET' })
  }

  async getTask(taskId: unknown): Promise<unknown> {
    const id = requiredText(taskId, 'taskId', 128)
    return this.request(`/api/control/v1/tasks/${encodeURIComponent(id)}`, { method: 'GET' })
  }

  async dispatchCodex(value: unknown): Promise<unknown> {
    const input = record(value, 'dispatch request')
    const task = normalizedTask(input.task)
    const taskId = requiredText(task.task_id, 'task.task_id', 128)
    const extension = normalizedExtension(task, input.extension)

    // Write the sidecar first. A sidecar without a core task cannot execute,
    // while queuing the core task before its context/handoff sidecar creates a
    // race where the Remote Host could lease incomplete task semantics.
    if (extension) {
      await this.request(`/api/control/v1/tasks/${encodeURIComponent(taskId)}/extensions`, {
        method: 'POST',
        body: JSON.stringify(extension)
      })
    }

    return this.request('/api/control/v1/tasks', {
      method: 'POST',
      body: JSON.stringify(task)
    })
  }

  async getTaskExtension(taskId: unknown): Promise<unknown> {
    const id = requiredText(taskId, 'taskId', 128)
    return this.request(`/api/control/v1/tasks/${encodeURIComponent(id)}/extensions`, { method: 'GET' })
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    if (!this.config.baseUrl || !this.config.tokenFile) throw new Error('Zero3 control plane is not configured')
    const body = typeof init.body === 'string' ? init.body : null
    if (body && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('Zero3 control request exceeds 2 MiB')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${readControlToken(this.config)}`)
      if (body != null) headers.set('content-type', 'application/json')
      const response = await fetch(`${this.config.baseUrl}${pathname}`, { ...init, headers, signal: controller.signal })
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Zero3 control response exceeds 2 MiB')
      const payload = text.trim() ? JSON.parse(text) : null
      if (!response.ok) {
        const detail = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error?: unknown }).error) : ''
        throw new Error(`Zero3 control request failed: HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      return payload
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Zero3 control request timed out')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

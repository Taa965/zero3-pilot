import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { createSqliteMemorySyncStore } from '../memory-sync-runtime/memory-sync-sqlite-store.mjs'
import { assertLogicalId, createProjectContextCore, EXECUTION_RESULT_PROTOCOL } from './project-context-core.mjs'

const EVENT_SCHEMA = 'zero3.memory.event.v1'
const DEFAULT_AUTHORITY = 60

export class MemoryAuthorityError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message)
    this.name = 'MemoryAuthorityError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

function required(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}
function bool(value) { return value === true || value === '1' }
function storageName(value) { return createHash('sha256').update(value, 'utf8').digest('hex') }
function authorityConfig(options = {}) {
  const env = options.env ?? process.env
  const enabled = options.enabled ?? bool(env.ZERO3_MEMORY_AUTHORITY_V2)
  if (!enabled) return { enabled: false }
  const authority = Number(env.ZERO3_MEMORY_MAX_AUTHORITY ?? DEFAULT_AUTHORITY)
  if (!Number.isInteger(authority) || authority < 0 || authority >= 100) throw new Error('ZERO3_MEMORY_MAX_AUTHORITY must be an integer from 0 to 99')
  return {
    enabled: true,
    baseUrl: required(options.baseUrl ?? env.ZERO3_MEMORY_AUTHORITY_URL, 'ZERO3_MEMORY_AUTHORITY_URL').replace(/\/+$/, ''),
    token: required(options.token ?? env.ZERO3_MEMORY_AUTHORITY_TOKEN ?? (env.ZERO3_MEMORY_AUTHORITY_TOKEN_FILE ? readFileSync(path.resolve(env.ZERO3_MEMORY_AUTHORITY_TOKEN_FILE), 'utf8').trim() : ''), 'ZERO3_MEMORY_AUTHORITY_TOKEN or ZERO3_MEMORY_AUTHORITY_TOKEN_FILE'),
    syncDb: path.resolve(required(options.syncDb ?? env.ZERO3_MEMORY_SYNC_DB, 'ZERO3_MEMORY_SYNC_DB')),
    agentId: required(options.agentId ?? env.ZERO3_MEMORY_AGENT_ID ?? 'zero3-mcp', 'ZERO3_MEMORY_AGENT_ID'),
    agentType: required(options.agentType ?? env.ZERO3_MEMORY_AGENT_TYPE ?? 'zero3', 'ZERO3_MEMORY_AGENT_TYPE'),
    deviceId: required(options.deviceId ?? env.ZERO3_MEMORY_DEVICE_ID ?? 'zero3-device', 'ZERO3_MEMORY_DEVICE_ID'),
    authority,
    taskId: typeof (options.taskId ?? env.ZERO3_MCP_TASK_ID) === 'string' ? (options.taskId ?? env.ZERO3_MCP_TASK_ID).trim() : ''
  }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await fs.rename(temp, file)
}
function responseError(status, body) {
  const code = typeof body?.error === 'string' ? body.error : `memory_http_${status}`
  if (status === 409) return new MemoryAuthorityError(code, body?.message ?? code, { status, retryable: false })
  if (status === 401 || status === 403) return new MemoryAuthorityError(code, body?.message ?? code, { status, retryable: false })
  if (status === 429 || status >= 500) return new MemoryAuthorityError(code, body?.message ?? code, { status, retryable: true })
  return new MemoryAuthorityError(code, body?.message ?? code, { status, retryable: false })
}

async function responseBody(response) {
  try { return await response.json() } catch { return {} }
}

function offlineError(error) {
  if (error instanceof MemoryAuthorityError) return error.retryable
  return true
}

function normalizeRemoteProject(value, projectId) {
  if (!value || typeof value !== 'object' || value.projectId !== projectId) throw new Error('memory authority returned an invalid project context')
  if (!Number.isSafeInteger(value.version) || value.version < 0) throw new Error('memory authority returned an invalid project version')
  return {
    projectId,
    version: value.version,
    payload: value.payload ?? null,
    sync: {
      source: 'memory_server', stale: false,
      last_sequence: Number.isSafeInteger(value.sync?.last_sequence) ? value.sync.last_sequence : value.version,
      remoteVersion: value.version
    }
  }
}

function normalizeRemoteHandoff(value, taskId) {
  if (!value || typeof value !== 'object' || value.taskId !== taskId) throw new Error('memory authority returned an invalid handoff')
  if (!Number.isSafeInteger(value.version) || value.version < 0) throw new Error('memory authority returned an invalid handoff version')
  return { taskId, version: value.version, result: value.result ?? null, sync: { source: 'memory_server', stale: false, remoteVersion: value.version } }
}
function baseEvent(config, projectId, eventType, memory, payload, taskId = null) {
  return {
    schema: EVENT_SCHEMA,
    event_id: randomUUID(),
    created_at: new Date().toISOString(),
    scope: { project_id: projectId, task_id: taskId, session_id: null, thread_id: null },
    actor: { agent_id: config.agentId, agent_type: config.agentType, device_id: config.deviceId },
    event_type: eventType,
    memory,
    source: { type: taskId ? 'task' : 'system', ref: taskId, hash: null },
    supersedes: [],
    payload
  }
}

function projectEvent(config, projectId, expectedVersion, payload) {
  return baseEvent(config, projectId, 'project.context.replaced', {
    class: 'project', entity_type: 'project_context', entity_id: 'project-context',
    authority: config.authority, confidence: 1, expected_entity_version: null
  }, { expectedVersion, context: payload }, config.taskId || null)
}

function handoffEvent(config, projectId, taskId, expectedVersion, result) {
  return baseEvent(config, projectId, 'handoff.published', {
    class: 'task', entity_type: 'handoff', entity_id: `handoff:${taskId}`,
    authority: config.authority, confidence: 1, expected_entity_version: expectedVersion
  }, result, taskId)
}

function pendingFor(items, predicate) {
  return items.find(item => {
    try { return predicate(item.payload, item) } catch { return false }
  }) ?? null
}
export function createProjectContextAuthorityAdapter(options = {}) {
  const rootDir = path.resolve(required(options.rootDir ?? process.env.ZERO3_PROJECT_CONTEXT_DIR, 'project context root'))
  const activeProjectId = options.activeProjectId ?? null
  const local = options.localCore ?? createProjectContextCore({ rootDir, activeProjectId })
  const config = authorityConfig(options)
  if (!config.enabled) return local

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
  const store = options.store ?? createSqliteMemorySyncStore(config.syncDb)
  const cacheRoot = path.join(rootDir, 'authority-cache')

  function assertProject(rawProjectId) {
    const projectId = assertLogicalId(rawProjectId, 'projectId')
    if (activeProjectId && activeProjectId !== projectId) throw new Error('project context access denied for inactive project')
    return projectId
  }
  function projectCacheFile(projectId) { return path.join(cacheRoot, 'projects', `${storageName(projectId)}.json`) }
  function handoffCacheFile(taskId) { return path.join(cacheRoot, 'handoffs', `${storageName(taskId)}.json`) }

  async function request(relativePath, init = {}) {
    let response
    try {
      response = await fetchImpl(`${config.baseUrl}${relativePath}`, {
        ...init,
        headers: { authorization: `Bearer ${config.token}`, accept: 'application/json', ...(init.headers ?? {}) }
      })
    } catch (error) {
      throw new MemoryAuthorityError('memory_network_error', error instanceof Error ? error.message : String(error), { retryable: true })
    }
    const body = await responseBody(response)
    if (!response.ok) throw responseError(response.status, body)
    return body
  }
  async function appendRemote(event) {
    return request('/v1/memory/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    })
  }
  async function unsettled() { return typeof store.unsettled === 'function' ? store.unsettled(500) : [] }
  async function pendingProject(projectId) {
    return pendingFor(await unsettled(), event =>
      event?.event_type === 'project.context.replaced' && event?.scope?.project_id === projectId)
  }
  async function pendingHandoff(projectId, taskId) {
    return pendingFor(await unsettled(), event =>
      event?.event_type === 'handoff.published' && event?.scope?.project_id === projectId && event?.scope?.task_id === taskId)
  }

  function overlayProject(remote, pending) {
    if (!pending) return remote
    const base = pending.payload?.payload?.expectedVersion
    if (base !== remote.version) return { ...remote, sync: { ...remote.sync, pendingConflict: true } }
    return {
      projectId: remote.projectId,
      version: remote.version + 1,
      payload: pending.payload.payload.context,
      sync: { source: 'local_pending', stale: true, remoteVersion: remote.version, pendingEventId: pending.event_id, pendingState: pending.state }
    }
  }
  function overlayHandoff(remote, pending) {
    if (!pending) return remote
    const base = pending.payload?.memory?.expected_entity_version
    if (base !== remote.version) return { ...remote, sync: { ...remote.sync, pendingConflict: true } }
    return {
      taskId: remote.taskId,
      version: remote.version + 1,
      result: pending.payload.payload,
      sync: { source: 'local_pending', stale: true, remoteVersion: remote.version, pendingEventId: pending.event_id, pendingState: pending.state }
    }
  }
  async function getProject(rawProjectId) {
    const projectId = assertProject(rawProjectId)
    const pending = await pendingProject(projectId)
    try {
      const remote = normalizeRemoteProject(
        await request(`/v1/projects/${encodeURIComponent(projectId)}/context`), projectId
      )
      await atomicJson(projectCacheFile(projectId), remote)
      return overlayProject(remote, pending)
    } catch (error) {
      if (!offlineError(error)) throw error
      const cached = await readJson(projectCacheFile(projectId))
      if (cached) {
        const normalized = { ...cached, sync: { ...(cached.sync ?? {}), source: 'local_offline', stale: true, remoteVersion: cached.version } }
        return overlayProject(normalized, pending)
      }
      const fallback = await local.getProject(projectId)
      return {
        ...fallback,
        sync: { source: 'legacy_local_offline', stale: true, remoteVersion: fallback.version }
      }
    }
  }

  async function putProject(rawProjectId, expectedVersion, payload) {
    const projectId = assertProject(rawProjectId)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('expectedVersion is required; read the project context first')
    JSON.stringify(payload)
    const current = await getProject(projectId)
    if (current.version !== expectedVersion) throw new Error(`project context version conflict: expected ${expectedVersion}, current ${current.version}`)
    const existing = await pendingProject(projectId)
    if (existing) {
      if (existing.state !== 'pending') throw new MemoryAuthorityError('project_context_sync_in_progress', 'project context is already being synchronized', { status: 409, retryable: true })
      const replacement = structuredClone(existing.payload)
      replacement.payload.context = payload
      const changed = await store.replacePending(existing.event_id, replacement)
      if (!changed) throw new Error('pending project context could not be coalesced')
      return { projectId, version: current.version, payload, sync: { ...current.sync, source: 'local_pending', stale: true, pendingEventId: existing.event_id, coalesced: true } }
    }
    const remoteBase = Number.isSafeInteger(current.sync?.remoteVersion) ? current.sync.remoteVersion : current.version
    const event = projectEvent(config, projectId, remoteBase, payload)
    try {
      await appendRemote(event)
      const remote = normalizeRemoteProject(
        await request(`/v1/projects/${encodeURIComponent(projectId)}/context`), projectId
      )
      await atomicJson(projectCacheFile(projectId), remote)
      return remote
    } catch (error) {
      if (!offlineError(error)) throw error
      await store.enqueue(event)
      if (!(await readJson(projectCacheFile(projectId)))) {
        await atomicJson(projectCacheFile(projectId), {
          projectId, version: remoteBase, payload: current.payload,
          sync: { source: 'local_offline_base', stale: true, remoteVersion: remoteBase }
        })
      }
      return {
        projectId,
        version: remoteBase + 1,
        payload,
        sync: { source: 'local_pending', stale: true, remoteVersion: remoteBase, pendingEventId: event.event_id, pendingState: 'pending' }
      }
    }
  }

  async function getHandoff(rawTaskId) {
    const taskId = assertLogicalId(rawTaskId, 'taskId')
    const projectId = assertProject(activeProjectId)
    const pending = await pendingHandoff(projectId, taskId)
    try {
      const remote = normalizeRemoteHandoff(
        await request(`/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/handoff`), taskId
      )
      await atomicJson(handoffCacheFile(taskId), remote)
      return overlayHandoff(remote, pending)
    } catch (error) {
      if (!offlineError(error)) throw error
      const cached = await readJson(handoffCacheFile(taskId))
      if (cached) {
        const normalized = { ...cached, sync: { ...(cached.sync ?? {}), source: 'local_offline', stale: true, remoteVersion: cached.version } }
        return overlayHandoff(normalized, pending)
      }
      const fallback = await local.getHandoff(taskId)
      return { ...fallback, sync: { source: 'legacy_local_offline', stale: true, remoteVersion: fallback.version } }
    }
  }
  async function putHandoff(rawTaskId, expectedVersion, result) {
    const taskId = assertLogicalId(rawTaskId, 'taskId')
    const projectId = assertProject(activeProjectId)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('handoff result must be an object')
    if (result.protocol !== EXECUTION_RESULT_PROTOCOL) throw new Error(`handoff result.protocol must be ${EXECUTION_RESULT_PROTOCOL}`)
    if (result.task_id !== taskId) throw new Error('handoff taskId must match result.task_id')
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('expectedVersion is required; read the handoff first')
    const current = await getHandoff(taskId)
    if (current.version !== expectedVersion) throw new Error(`handoff version conflict: expected ${expectedVersion}, current ${current.version}`)
    const existing = await pendingHandoff(projectId, taskId)
    if (existing) {
      if (existing.state !== 'pending') throw new MemoryAuthorityError('handoff_sync_in_progress', 'handoff is already being synchronized', { status: 409, retryable: true })
      const replacement = structuredClone(existing.payload)
      replacement.payload = result
      const changed = await store.replacePending(existing.event_id, replacement)
      if (!changed) throw new Error('pending handoff could not be coalesced')
      return { taskId, version: current.version, result, sync: { ...current.sync, source: 'local_pending', stale: true, pendingEventId: existing.event_id, coalesced: true } }
    }

    const remoteBase = Number.isSafeInteger(current.sync?.remoteVersion) ? current.sync.remoteVersion : current.version
    const event = handoffEvent(config, projectId, taskId, remoteBase, result)
    try {
      await appendRemote(event)
      const remote = normalizeRemoteHandoff(
        await request(`/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/handoff`), taskId
      )
      await atomicJson(handoffCacheFile(taskId), remote)
      return remote
    } catch (error) {
      if (!offlineError(error)) throw error
      await store.enqueue(event)
      if (!(await readJson(handoffCacheFile(taskId)))) {
        await atomicJson(handoffCacheFile(taskId), { taskId, version: remoteBase, result: current.result, sync: { source: 'local_offline_base', stale: true, remoteVersion: remoteBase } })
      }
      return { taskId, version: remoteBase + 1, result, sync: { source: 'local_pending', stale: true, remoteVersion: remoteBase, pendingEventId: event.event_id, pendingState: 'pending' } }
    }
  }

  return { getProject, putProject, getHandoff, putHandoff, close: () => store.close?.() }
}

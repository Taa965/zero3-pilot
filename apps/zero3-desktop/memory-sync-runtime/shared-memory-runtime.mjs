import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { MemorySyncClient } from './memory-sync-client.mjs'
import { SqliteMemorySyncStore } from './sqlite-sync-store.mjs'
import { createHttpSyncSocket } from './http-sync-socket.mjs'
import { assertSecretFree } from '../memory-v21-runtime/github-memory-inbox.mjs'
import { enforcePromotionPolicy } from '../agent-memory-runtime/agent-memory-governance.mjs'
import { validatePublishEvent } from './event-validation.mjs'

export function validateSharedMemoryConfig(config, projectId) {
  const url = new URL(config.baseUrl)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('shared memory requires HTTPS or loopback HTTP without URL credentials')
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(projectId ?? '') || !Array.isArray(config.projects) || (!config.projects.includes(projectId) && !config.projects.includes('*'))) throw new Error('shared memory project is not configured')
  for (const key of ['token', 'clientId', 'deviceId', 'cacheDir']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`shared memory ${key} is required`)
  }
  if (!path.isAbsolute(config.cacheDir)) throw new Error('shared memory cacheDir must be absolute')
  return config
}

export async function openSharedMemory({ configPath, projectId, fetchImpl = fetch, retryMs = 5000 }) {
  if (!path.isAbsolute(configPath)) throw new Error('shared memory config path must be absolute')
  const config = validateSharedMemoryConfig(JSON.parse(await fs.readFile(configPath, 'utf8')), projectId)
  // Separate authority/subscription/authentication domains: a changed server,
  // grant or project must never reuse another domain's cursor or cached data.
  const namespace = createHash('sha256').update(JSON.stringify([config.baseUrl, config.clientId, config.token, projectId])).digest('hex')
  const store = new SqliteMemorySyncStore(path.join(config.cacheDir, `${namespace}.sqlite`))
  let lastError = null, state = 'starting', closed = false
  const safeFetch = (input, options = {}) => fetchImpl(input, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(10000) })
  const client = new MemorySyncClient({
    ...config, projects: [projectId], store, fetchImpl: safeFetch,
    socketFactory: async () => createHttpSyncSocket({ baseUrl: config.baseUrl, token: config.token, fetchImpl: safeFetch }),
    onState: value => { state = value.state; if (state === 'ready') lastError = null },
    onError: error => { lastError = error.code ?? 'memory_sync_unavailable' }
  })
  await client.start()
  // Retry pending HTTP writes even while the subscription itself stays online.
  const retry = setInterval(() => { void client.flushPending().catch(() => { lastError = 'memory_sync_unavailable' }) }, retryMs)
  retry.unref?.()
  const headers = { authorization: `Bearer ${config.token}` }
  const assertScope = id => { if (id !== projectId) throw new Error('shared memory access denied for inactive project') }
  const sessionContextIdentity = input => {
    const identity = createHash('sha256').update(JSON.stringify([projectId, input.logicalSessionId])).digest('hex').slice(0, 32)
    const contentHash = createHash('sha256').update(JSON.stringify(input.events)).digest('hex')
    const eventHash = createHash('sha256').update(JSON.stringify(['zero3.session-context.v1', projectId, input.logicalSessionId, input.startSeq, input.endSeq, contentHash])).digest('hex')
    const eventId = `${eventHash.slice(0, 8)}-${eventHash.slice(8, 12)}-${eventHash.slice(12, 16)}-${eventHash.slice(16, 20)}-${eventHash.slice(20, 32)}`
    return { entityId: `session-context:${identity}:${input.startSeq}-${input.endSeq}:${contentHash.slice(0, 12)}`, contentHash, eventId }
  }
  const runtime = {
    async getProject(id) {
      assertScope(id)
      let response
      try { response = await safeFetch(new URL(`/v1/projects/${encodeURIComponent(id)}/context`, config.baseUrl), { headers }) } catch { /* offline cache below */ }
      if (response?.ok) {
        const context = await response.json()
        if (context.projectId !== id || !Number.isSafeInteger(context.version) || !context.sync || context.sync.stale !== false) throw new Error('invalid authoritative context response')
        store.cacheContext(context)
        lastError = null
        return context
      }
      // Authentication and permission failures must never expose cached data.
      if (response && response.status < 500) throw new Error(`shared memory context returned HTTP ${response.status}`)
      const cached = store.getContext(id)
      if (!cached) throw new Error('shared memory unavailable; no authoritative cached context exists')
      return { ...cached, sync: { ...cached.sync, source: 'offline_cache', stale: true } }
    },
    async publish(event) {
      assertScope(event?.scope?.project_id)
      validatePublishEvent(event, projectId)
      assertSecretFree(event)
      if (event?.schema !== 'zero3.memory.event.v1' || !['project', 'task'].includes(event.memory?.class)) throw new Error('shared memory event must have project or task scope')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.event_id ?? '')) throw new Error('event_id must be a UUID; preserve it across retries')
      if (!Number.isInteger(event.memory.authority) || event.memory.authority < 0) throw new Error('invalid memory authority')
      if (event.memory.class === 'task' && !event.scope.task_id) throw new Error('task_id is required')
      if (!Number.isSafeInteger(event.memory.expected_entity_version) || event.memory.expected_entity_version < 0) throw new Error('expected_entity_version is required')
      enforcePromotionPolicy({ scope: event.memory.class, proposed_authority: event.memory.authority, candidate_type: event.memory.authority <= 20 ? 'inference' : 'observation', verification_status: 'unverified' })
      store.enqueue(event)
      try { await client.flushPending() } catch { lastError = 'memory_sync_unavailable' }
      return store.status(event.event_id)
    },
    async publishSessionContext(input) {
      if (!input || typeof input.logicalSessionId !== 'string' || !input.logicalSessionId.trim() || input.logicalSessionId.length > 256) throw new Error('logicalSessionId is required')
      if (!Number.isSafeInteger(input.startSeq) || !Number.isSafeInteger(input.endSeq) || input.startSeq < 1 || input.endSeq < input.startSeq) throw new Error('invalid session context sequence range')
      if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 64) throw new Error('session context batch must contain 1..64 events')
      let expected = input.startSeq
      for (const item of input.events) {
        if (!item || typeof item !== 'object' || item.session_seq !== expected) throw new Error('session context events must be contiguous and ordered')
        expected += 1
      }
      if (expected - 1 !== input.endSeq) throw new Error('session context range does not match events')
      const { entityId, contentHash, eventId } = sessionContextIdentity(input)
      const createdAt = input.events[0]?.created_at
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new Error('session context events require a stable created_at')
      const payload = { protocol: 'zero3.session-context.v1', logical_session_id: input.logicalSessionId, start_seq: input.startSeq, end_seq: input.endSeq, event_count: input.events.length, content_hash: contentHash, events: input.events }
      const serialized = JSON.stringify(payload)
      if (Buffer.byteLength(serialized, 'utf8') > 768 * 1024) throw new Error('session context batch exceeds 768 KiB')
      try {
        const context = await runtime.getProject(projectId)
        const existing = Array.isArray(context.entities) ? context.entities.find(item => item?.entity_id === entityId) : null
        const content = existing?.content && typeof existing.content === 'object' ? existing.content : null
        if (content?.protocol === payload.protocol && content?.content_hash === contentHash && content?.start_seq === input.startSeq && content?.end_seq === input.endSeq) {
          return { state: 'acked', server_sequence: existing.updated_sequence ?? context.sync?.last_sequence ?? null, entity_id: entityId, content_hash: contentHash, reused: true }
        }
      } catch { /* publish() will preserve an offline pending write below */ }
      const status = await runtime.publish({ schema: 'zero3.memory.event.v1', event_id: eventId, created_at: createdAt,
        scope: { project_id: projectId, session_id: input.logicalSessionId }, actor: { agent_id: config.clientId, agent_type: 'zero3', device_id: config.deviceId },
        event_type: 'artifact.recorded', memory: { class: 'project', entity_type: 'session-context', entity_id: entityId, authority: 45, confidence: 1, expected_entity_version: 0 },
        source: { type: 'chat', ref: input.logicalSessionId }, supersedes: [], payload })
      return { ...status, entity_id: entityId, content_hash: contentHash, reused: false }
    },
    async getHandoff(taskId) {
      const context = await runtime.getProject(projectId)
      const item = context.entities?.filter(entity => entity.memory_class === 'task' && entity.task_id === taskId && entity.entity_type === 'handoff')
        .sort((a, b) => b.updated_sequence - a.updated_sequence)[0]
      return { taskId, version: item?.version ?? 0, result: item?.content ?? null, sync: context.sync }
    },
    async putHandoff(taskId, expectedVersion, result) {
      if (result?.protocol !== 'zero3.pilot.execution-result.v1' || result.task_id !== taskId) throw new Error('invalid handoff protocol or task_id')
      return runtime.publish({ schema: 'zero3.memory.event.v1', event_id: randomUUID(), created_at: new Date().toISOString(),
        scope: { project_id: projectId, task_id: taskId }, actor: { agent_id: config.clientId, agent_type: 'zero3', device_id: config.deviceId },
        event_type: 'handoff.published', memory: { class: 'task', entity_type: 'handoff', entity_id: 'execution-handoff', authority: 60, expected_entity_version: expectedVersion },
        source: { type: 'task' }, supersedes: [], payload: result })
    },
    async flush() {
      try { await client.flushPending(); if (state === 'ready') lastError = null }
      catch { lastError = 'memory_sync_unavailable' }
      return runtime.status()
    },
    status(eventId) { return { state, lastError, cursor: store.getCursor(config.clientId)?.last_sequence ?? 0, queue: store.counts(), event: eventId ? store.status(eventId) : null } },
    async close() {
      if (closed) return
      closed = true; clearInterval(retry)
      await client.stop()
      store.close()
    }
  }
  return runtime
}

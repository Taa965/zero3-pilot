import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SqliteMemorySyncStore } from './sqlite-sync-store.mjs'
import { openSharedMemory } from './shared-memory-runtime.mjs'
import { EVENT_TYPES } from './event-validation.mjs'

export function event(overrides = {}) {
  return { schema: 'zero3.memory.event.v1', event_id: randomUUID(), created_at: new Date().toISOString(),
    scope: { project_id: 'project-a' }, actor: { agent_id: 'test-agent', agent_type: 'codex' },
    event_type: 'decision.recorded', memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-1', authority: 60, expected_entity_version: 0 },
    source: { type: 'chat' }, supersedes: [], payload: { text: 'Use the event authority' }, ...overrides }
}
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('event validation enumerations stay aligned with the normative schema', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../../../schemas/zero3.memory.event.v1.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(EVENT_TYPES, schema.properties.event_type.enum)
})

test('SQLite persists queue and cursor; competing clients cannot claim active sends', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-store-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'cache.sqlite')
  let a = new SqliteMemorySyncStore(file)
  const e = event()
  a.enqueue(e)
  assert.equal(a.enqueue(e), false)
  assert.throws(() => a.enqueue({ ...e, payload: { other: true } }), /different payload/)
  assert.equal(a.claimBatch(100).length, 1)
  const b = new SqliteMemorySyncStore(file)
  b.resetInflight()
  assert.equal(b.claimBatch(100).length, 0)
  a.resetInflight()
  assert.equal(b.claimBatch(100).length, 1)
  b.markAcked(e.event_id, 5)
  b.cacheServerEvent(5, e.event_id, e)
  b.setCursor('client', 'device', 5)
  assert.throws(() => b.cacheServerEvent(5, e.event_id, { ...e, payload: {} }), /payload conflict/)
  b.close(); a.close()
  a = new SqliteMemorySyncStore(file)
  assert.equal(a.getCursor('client').last_sequence, 5)
  assert.equal(a.status(e.event_id).state, 'acked')
  a.close()
})

test('shared runtime queues offline writes, survives reopen and distinguishes stale cache from denied access', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-runtime-'))
  let shared
  t.after(async () => { await shared?.close(); await fs.rm(dir, { recursive: true, force: true }) })
  const configPath = path.join(dir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify({ baseUrl: 'http://127.0.0.1:8791', token: 'test-token', clientId: 'test', deviceId: 'test', projects: ['project-a'], cacheDir: dir }))
  let online = false, denied = false
  const context = { projectId: 'project-a', version: 5, payload: { decisions: [{ text: 'shared' }] }, sync: { source: 'memory_server', last_sequence: 5, stale: false } }
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error')
    if (!online) throw new Error('offline')
    if (denied) return response(403, {})
    if (String(url).endsWith('events:batch')) {
      const { events } = JSON.parse(options.body)
      return response(200, { results: events.map(e => ({ event_id: e.event_id, status: 'accepted', sequence: 5 })) })
    }
    if (String(url).includes('/context')) return response(200, context)
    return response(200, { events: [] })
  }
  shared = await openSharedMemory({ configPath, projectId: 'project-a', fetchImpl, retryMs: 60000 })
  const e = event()
  assert.equal((await shared.publish(e)).state, 'pending')
  await assert.rejects(() => shared.getProject('project-a'), /no authoritative cached/)
  await shared.close()
  online = true
  shared = await openSharedMemory({ configPath, projectId: 'project-a', fetchImpl, retryMs: 60000 })
  assert.equal((await shared.publish(e)).state, 'acked')
  assert.equal((await shared.getProject('project-a')).sync.stale, false)
  online = false
  assert.equal((await shared.getProject('project-a')).sync.stale, true)
  await assert.rejects(() => shared.getProject('project-b'), /inactive project/)
  online = true; denied = true
  await assert.rejects(() => shared.getProject('project-a'), /HTTP 403/)
  await assert.rejects(() => shared.publish(event({ payload: { api_key: 'secret' } })), /forbidden|secret/i)
  await assert.rejects(() => shared.publish(event({ event_type: 'made.up' })), /event type/)
})

test('session context coverage advances only after an acknowledged shared-memory write', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-context-'))
  let shared
  t.after(async () => { await shared?.close(); await fs.rm(dir, { recursive: true, force: true }) })
  const configPath = path.join(dir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify({ baseUrl: 'http://127.0.0.1:8792', token: 'test-token', clientId: 'test', deviceId: 'test', projects: ['project-a'], cacheDir: dir }))
  const submitted = []
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('events:batch')) {
      const { events } = JSON.parse(options.body)
      submitted.push(...events)
      return response(200, { results: events.map((item, index) => ({ event_id: item.event_id, status: 'accepted', sequence: 10 + index })) })
    }
    if (String(url).includes('/context')) return response(200, { projectId: 'project-a', version: 9, entities: [], sync: { source: 'memory_server', last_sequence: 9, stale: false } })
    return response(200, { events: [] })
  }
  shared = await openSharedMemory({ configPath, projectId: 'project-a', fetchImpl, retryMs: 60000 })
  const result = await shared.publishSessionContext({
    logicalSessionId: 'session-1', startSeq: 4, endSeq: 5,
    events: [{ session_seq: 4, created_at: '2026-09-12T01:00:00.000Z', type: 'userMessage', payload: { text: 'hello' } }, { session_seq: 5, created_at: '2026-09-12T01:00:01.000Z', type: 'agentMessage', payload: { text: 'world' } }]
  })
  assert.equal(result.state, 'acked')
  assert.equal(typeof result.entity_id, 'string')
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].event_type, 'artifact.recorded')
  assert.equal(submitted[0].memory.entity_type, 'session-context')
  assert.equal(submitted[0].memory.expected_entity_version, 0)
  assert.equal(submitted[0].payload.protocol, 'zero3.session-context.v1')
  assert.deepEqual(submitted[0].payload.events.map(item => item.session_seq), [4, 5])
  const retry = await shared.publishSessionContext({ logicalSessionId: 'session-1', startSeq: 4, endSeq: 5, events: submitted[0].payload.events })
  assert.equal(retry.state, 'acked')
  assert.equal(submitted.length, 1)
  assert.equal(retry.entity_id, result.entity_id)
})

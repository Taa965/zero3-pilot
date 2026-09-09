import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openSharedMemory } from './shared-memory-runtime.mjs'

const base = process.env.ZERO3_MEMORY_TEST_URL
const token = process.env.ZERO3_MEMORY_TEST_TOKEN
test('real PostgreSQL authority: idempotency, entity versions, conflicts, replay, task isolation and denial', { skip: !base }, async () => {
  assert.ok(token, 'test token is required')
  const projectId = `integration-${randomUUID()}`
  const e = { schema: 'zero3.memory.event.v1', event_id: randomUUID(), created_at: new Date().toISOString(), scope: { project_id: projectId }, actor: { agent_id: 'integration', agent_type: 'codex' }, event_type: 'decision.recorded', memory: { class: 'project', entity_type: 'decision', entity_id: 'one', authority: 60, confidence: 0.9, expected_entity_version: 0 }, source: { type: 'chat' }, supersedes: [], payload: { text: 'first decision' } }
  async function call(endpoint, body) {
    const res = await fetch(new URL(endpoint, base), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) })
    return { status: res.status, body: await res.json() }
  }
  const first = await call('/v1/memory/events', e)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.status, 'accepted')
  assert.equal((await call('/v1/memory/events', e)).body.status, 'duplicate')
  assert.equal((await call('/v1/memory/events', { ...e, payload: { changed: true } })).status, 400)
  const initial = await call(`/v1/projects/${projectId}/context`)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.entities[0].version, 1)
  assert.equal(initial.body.payload.decisions[0].text, 'first decision')
  const next = { ...e, event_id: randomUUID(), payload: { text: 'second decision' } }
  assert.equal((await call('/v1/memory/events', next)).status, 409)
  next.memory = { ...e.memory, expected_entity_version: 1 }
  assert.equal((await call('/v1/memory/events', next)).status, 200)
  const current = (await call(`/v1/projects/${projectId}/context`)).body
  assert.equal(current.entities[0].version, 2)
  assert.equal(current.payload.decisions.length, 1)
  assert.equal(current.payload.decisions[0].text, 'second decision')
  const replay = await call(`/v1/memory/events?project_id=${projectId}&after=${first.body.sequence}`)
  assert.equal(replay.body.events.length, 1)
  assert.equal(replay.body.events[0].event.memory.expected_entity_version, 1)
  assert.ok(Math.abs(replay.body.events[0].event.memory.confidence - 0.9) < 0.001)
  const task = { ...e, event_id: randomUUID(), scope: { project_id: projectId, task_id: randomUUID() }, event_type: 'handoff.published', memory: { ...e.memory, class: 'task', entity_type: 'handoff' } }
  assert.equal((await call('/v1/memory/events', task)).status, 200)
  assert.equal((await call('/v1/memory/events', { ...task, event_id: randomUUID(), scope: { ...task.scope, project_id: 'another-project' }, memory: { ...task.memory, entity_id: 'other' } })).status, 400)
  assert.equal((await fetch(new URL(`/v1/projects/${projectId}/context`, base))).status, 401)
  assert.equal((await call('/v1/memory/events', { ...e, event_id: randomUUID(), memory: { ...e.memory, authority: 100 } })).status, 403)
})

test('independent shared runtimes exchange handoffs and reject stale versions', { skip: !base }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-handoff-integration-'))
  const runtimes = []
  t.after(async () => { await Promise.all(runtimes.map(runtime => runtime.close())); await fs.rm(dir, { recursive: true, force: true }) })
  const projectId = `integration-${randomUUID()}`, taskId = randomUUID()
  for (const clientId of ['writer', 'reader']) {
    const configPath = path.join(dir, `${clientId}.json`)
    await fs.writeFile(configPath, JSON.stringify({ baseUrl: base, token, clientId, deviceId: clientId, projects: [projectId], cacheDir: path.join(dir, clientId) }))
    runtimes.push(await openSharedMemory({ configPath, projectId }))
  }
  const [writer, reader] = runtimes
  const result = { protocol: 'zero3.pilot.execution-result.v1', task_id: taskId, summary: 'Cross-device handoff acceptance' }
  assert.equal((await writer.putHandoff(taskId, 0, result)).state, 'acked')
  const received = await reader.getHandoff(taskId)
  assert.equal(received.version, 1)
  assert.deepEqual(received.result, result)
  assert.equal(received.sync.stale, false)
  assert.equal((await reader.putHandoff(taskId, 0, { ...result, summary: 'stale writer' })).state, 'conflict')
  const updated = { ...result, summary: 'Confirmed by the second device' }
  assert.equal((await reader.putHandoff(taskId, 1, updated)).state, 'acked')
  assert.deepEqual((await writer.getHandoff(taskId)).result, updated)
})

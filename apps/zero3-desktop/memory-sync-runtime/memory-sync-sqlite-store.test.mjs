import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSqliteMemorySyncStore } from './memory-sync-sqlite-store.mjs'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-memory-sync-'))
  const store = createSqliteMemorySyncStore(path.join(root, 'memory-sync.sqlite'))
  return { root, store }
}

const event = id => ({
  schema: 'zero3.memory.event.v1',
  event_id: id,
  created_at: new Date().toISOString(),
  scope: { project_id: 'project-a' },
  actor: { agent_id: 'codex-test', agent_type: 'codex' },
  event_type: 'decision.recorded',
  memory: { class: 'project', entity_type: 'decision', entity_id: `decision-${id}`, authority: 60 },
  source: { type: 'task' },
  supersedes: [], payload: { text: id }
})
test('queue is durable, idempotent, and crash-safe', async () => {
  const { root, store } = await fixture()
  try {
    assert.equal(await store.enqueue(event('evt-1')), true)
    assert.equal(await store.enqueue(event('evt-1')), false)
    assert.equal((await store.nextBatch(10)).length, 1)
    assert.equal(await store.markSending(['evt-1']), 1)
    assert.equal((await store.nextBatch(10)).length, 0)
    assert.equal(await store.resetInflight(), 1)
    assert.equal((await store.nextBatch(10))[0].event_id, 'evt-1')
    assert.equal(await store.pendingCount(), 1)
  } finally {
    store.close(); await fs.rm(root, { recursive: true, force: true })
  }
})

test('cursor is monotonic and server cache is idempotent', async () => {
  const { root, store } = await fixture()
  try {
    await store.setCursor('pilot', 'desktop', 10)
    await store.setCursor('pilot', 'desktop', 7)
    assert.equal((await store.getCursor('pilot')).last_sequence, 10)
    assert.equal(await store.cacheServerEvent(11, 'evt-11', event('evt-11')), true)
    assert.equal(await store.cacheServerEvent(11, 'evt-11', event('evt-11')), false)
  } finally {
    store.close(); await fs.rm(root, { recursive: true, force: true })
  }
})
test('ack/conflict/rejected are terminal states', async () => {
  const { root, store } = await fixture()
  try {
    await store.enqueue(event('evt-a'))
    await store.enqueue(event('evt-b'))
    await store.enqueue(event('evt-c'))
    await store.markSending(['evt-a', 'evt-b', 'evt-c'])
    assert.equal(await store.markAcked('evt-a', 21), true)
    assert.equal(await store.markConflict('evt-b', 'entity_version_conflict'), true)
    assert.equal(await store.markRejected('evt-c', 'authority_denied'), true)
    assert.equal(await store.pendingCount(), 0)
    assert.equal((await store.nextBatch(10)).length, 0)
  } finally {
    store.close(); await fs.rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createProjectContextAuthorityAdapter, MemoryAuthorityError } from './project-context-authority-adapter.mjs'
import { createSqliteMemorySyncStore } from '../memory-sync-runtime/memory-sync-sqlite-store.mjs'

async function fixture(fetchImpl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-authority-adapter-'))
  const syncDb = path.join(root, 'sync.sqlite')
  const adapter = createProjectContextAuthorityAdapter({
    rootDir: path.join(root, 'context'), activeProjectId: 'project-a', enabled: true,
    baseUrl: 'https://memory.example.test', token: 'abcdefghijklmnopqrstuvwxyz123456',
    syncDb, agentId: 'codex-test', agentType: 'codex',
    deviceId: 'desktop-test', fetchImpl
  })
  return { root, adapter, syncDb }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function fakeAuthority() {
  let project = { projectId: 'project-a', version: 0, payload: null, sync: { last_sequence: 0 } }
  let handoff = { taskId: 'task-1', version: 0, result: null }
  return {
    async fetch(url, init = {}) {
      const pathname = new URL(url).pathname
      if (pathname === '/v1/projects/project-a/context') return response(200, project)
      if (pathname === '/v1/projects/project-a/tasks/task-1/handoff') return response(200, handoff)
      if (pathname === '/v1/memory/events') {
        const event = JSON.parse(init.body)
        if (event.event_type === 'project.context.replaced') {
          if (event.payload.expectedVersion !== project.version) return response(409, { error: 'project_context_version_conflict' })
          project = { projectId: 'project-a', version: project.version + 1, payload: event.payload.context, sync: { last_sequence: project.version + 1 } }
        } else if (event.event_type === 'handoff.published') {
          if (event.memory.expected_entity_version !== handoff.version) return response(409, { error: 'entity_version_conflict' })
          handoff = { taskId: 'task-1', version: handoff.version + 1, result: event.payload }
        }
        return response(200, { event_id: event.event_id, status: 'accepted', sequence: 1 })
      }
      return response(404, { error: 'not_found' })
    }
  }
}
test('online project context and handoff use authority', async () => {
  const authority = fakeAuthority()
  const { root, adapter } = await fixture(authority.fetch)
  try {
    const initial = await adapter.getProject('project-a')
    assert.equal(initial.version, 0)
    const written = await adapter.putProject('project-a', 0, { decisions: [{ text: 'AWS' }] })
    assert.equal(written.version, 1)
    assert.equal(written.payload.decisions[0].text, 'AWS')

    const handoff = { protocol: 'zero3.pilot.execution-result.v1', task_id: 'task-1', status: 'COMPLETED' }
    const published = await adapter.putHandoff('task-1', 0, handoff)
    assert.equal(published.version, 1)
    assert.equal((await adapter.getHandoff('task-1')).result.task_id, 'task-1')
  } finally {
    adapter.close(); await fs.rm(root, { recursive: true, force: true })
  }
})

test('auth and conflict errors never downgrade to offline fallback', async () => {
  for (const [status, code] of [[401, 'invalid_bearer_token'], [409, 'project_context_version_conflict']]) {
    const { root, adapter } = await fixture(async () => response(status, { error: code }))
    try {
      await assert.rejects(() => adapter.getProject('project-a'), error =>
        error instanceof MemoryAuthorityError && error.code === code && error.status === status)
    } finally {
      adapter.close(); await fs.rm(root, { recursive: true, force: true })
    }
  }
})
test('offline project writes stay operational and coalesce before sync', async () => {
  const { root, adapter, syncDb } = await fixture(async () => { throw new Error('offline') })
  try {
    assert.equal((await adapter.getProject('project-a')).version, 0)
    const first = await adapter.putProject('project-a', 0, { decisions: [{ text: 'first' }] })
    assert.equal(first.version, 1)
    assert.equal(first.sync.source, 'local_pending')
    const second = await adapter.putProject('project-a', 1, { decisions: [{ text: 'latest' }] })
    assert.equal(second.version, 1)
    assert.equal((await adapter.getProject('project-a')).payload.decisions[0].text, 'latest')
    adapter.close()
    const store = createSqliteMemorySyncStore(syncDb)
    try {
      const pending = await store.unsettled()
      assert.equal(pending.length, 1)
      assert.equal(pending[0].payload.payload.expectedVersion, 0)
      assert.equal(pending[0].payload.payload.context.decisions[0].text, 'latest')
    } finally { store.close() }
  } finally {
    try { adapter.close() } catch {}
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('offline handoff remains available to the next agent', async () => {
  const { root, adapter } = await fixture(async () => { throw new Error('offline') })
  try {
    const result = { protocol: 'zero3.pilot.execution-result.v1', task_id: 'task-1', status: 'COMPLETED', summary: 'done' }
    const written = await adapter.putHandoff('task-1', 0, result)
    assert.equal(written.version, 1)
    assert.equal((await adapter.getHandoff('task-1')).result.summary, 'done')
  } finally {
    adapter.close(); await fs.rm(root, { recursive: true, force: true })
  }
})

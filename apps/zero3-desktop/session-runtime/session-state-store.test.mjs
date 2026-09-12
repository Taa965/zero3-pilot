import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Zero3SessionStateStore } from './session-state-store.mjs'

function state(revision, text = 'hello') {
  return {
    schemaVersion: 2,
    migrationVersion: 1,
    revision,
    version: 1,
    nextSeq: 2,
    events: [{ eventId: 'evt-1', logicalSessionId: 'session-a', sessionSeq: 1, type: 'userMessage', createdAt: '2026-09-12T00:00:00.000Z', payload: { text } }],
    binding: { generation: 1 },
    coverage: { coveredSessionSeq: 0, coveredRanges: [] },
    switchState: { phase: 'ACTIVE' },
    pendingHandoff: null
  }
}
test('session state survives reopen and stale revisions cannot replace newer history', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-session-state-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  const first = new Zero3SessionStateStore({ rootDir })
  await first.write({ logicalSessionId: 'session-a', revision: 1, state: state(1, 'one') })
  await first.write({ logicalSessionId: 'session-a', revision: 2, state: state(2, 'two') })
  const stale = await first.write({ logicalSessionId: 'session-a', revision: 1, state: state(1, 'stale') })
  assert.equal(stale.revision, 2)
  await first.close()

  const reopened = new Zero3SessionStateStore({ rootDir })
  const restored = await reopened.read('session-a')
  assert.equal(restored.revision, 2)
  assert.equal(restored.state.events[0].payload.text, 'two')
  await reopened.close()
})

test('same revision with different content fails closed', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-session-conflict-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  const store = new Zero3SessionStateStore({ rootDir })
  await store.write({ logicalSessionId: 'session-a', revision: 3, state: state(3, 'authoritative') })
  await assert.rejects(() => store.write({ logicalSessionId: 'session-a', revision: 3, state: state(3, 'different') }), /revision conflict/)
  await store.close()
})

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')

const sourcePath = path.resolve(__dirname, '../ui-v2/adapters/Zero3SessionEventStore.ts')
let source = fs.readFileSync(sourcePath, 'utf8')
source = source.replace(/^import type .*\r?\n/, '')
source = source.replace(/\bexport\s+(?=(?:type|const|function)\b)/g, '')

function createStore(bridge = undefined) {
  const values = new Map()
  const window = {
    zero3SessionProviders: bridge,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {}
  }
  let nextId = 0
  const context = { window, crypto: { randomUUID: () => `id-${++nextId}` }, CustomEvent: class {}, TextEncoder, Date, JSON, Math, Array, Object, String, Number, Boolean, Error, Set, Map }
  return vm.runInNewContext(stripTypeScriptTypes(source + '\n;Zero3SessionEventStore'), context)
}
test('coverage compacts acknowledged ranges and transfer batches contain only uncovered events', () => {
  const store = createStore()
  for (let index = 1; index <= 5; index += 1) store.appendUser('session-a', `message-${index}`)
  assert.deepEqual(JSON.parse(JSON.stringify(store.markCoveredRange('session-a', 3, 4))), { coveredSessionSeq: 0, coveredRanges: [[3, 4]] })
  assert.deepEqual(JSON.parse(JSON.stringify(store.markCoveredRange('session-a', 1, 2))), { coveredSessionSeq: 4, coveredRanges: [] })
  const batches = store.transferBatches('session-a')
  assert.equal(batches.length, 1)
  assert.equal(batches[0].startSeq, 5)
  assert.equal(batches[0].endSeq, 5)
  assert.equal(JSON.stringify(batches[0].events.map(item => item.session_seq)), '[5]')
})

test('provider switch follows pending -> verifying -> switching -> active and advances generation once', () => {
  const store = createStore()
  store.appendUser('session-b', 'goal')
  store.setBinding('session-b', { profileId: 'profile-a', model: 'model-a', projectId: 'project-a' })
  const started = store.beginProviderSwitch('session-b', { token: 'token-1', targetGeneration: 2, targetProfileId: 'profile-b' })
  assert.equal(started.phase, 'HANDOFF_PENDING')
  assert.equal(store.markProviderSwitchVerifying('session-b', 'token-1').phase, 'HANDOFF_VERIFYING')
  const handoff = store.buildProviderHandoff('session-b', {
    projectId: 'project-a', fromProfile: { profileId: 'profile-a' }, toProfile: { profileId: 'profile-b' }, sharedMemory: { status: 'ready' }
  })
  assert.equal(handoff.handoff.source_runtime_generation, 1)
  assert.equal(handoff.handoff.target_runtime_generation, 2)
  const staged = store.stageProviderSwitch('session-b', handoff, { profileId: 'profile-b', model: 'model-b', thinkingEffort: 'high', projectId: 'project-a' })
  assert.equal(staged.binding.generation, 2)
  assert.equal(staged.switchState.phase, 'SWITCHING')
  assert.equal(staged.pendingHandoff.protocol, 'zero3.session-provider-handoff.v1')
  const completed = store.completeProviderSwitch('session-b')
  assert.equal(completed.switchState.phase, 'ACTIVE')
  assert.equal(completed.binding.generation, 2)
  assert.equal(completed.pendingHandoff, null)
  assert.throws(() => store.beginProviderSwitch('session-b', { token: 'bad', targetGeneration: 4, targetProfileId: 'profile-c' }), /target generation is stale/)
})

test('persisted session state restores into a fresh renderer cache before use', async () => {
  let persisted = null
  const bridge = {
    writeZero3SessionState: async request => {
      persisted = JSON.parse(JSON.stringify({ revision: request.revision, state: request.state }))
      return persisted
    },
    readZero3SessionState: async () => persisted
  }
  const first = createStore(bridge)
  first.appendUser('session-persisted', 'restored goal')
  first.setBinding('session-persisted', { profileId: 'profile-a', projectId: 'project-a', runtimeThreadId: 'thread-a' })
  first.ingestCodexEvent('session-persisted', { kind: 'notification', method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'reason-1', type: 'reasoning' } } })
  first.ingestCodexEvent('session-persisted', { kind: 'notification', method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'reason-1', delta: 'thinking' } })
  first.ingestCodexEvent('session-persisted', { kind: 'notification', method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'cmd-1', type: 'commandExecution', command: 'echo ok' } } })
  first.ingestCodexEvent('session-persisted', { kind: 'notification', method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'cmd-1', delta: 'ok' } })
  first.ingestCodexEvent('session-persisted', { kind: 'notification', method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'file-1', type: 'fileChange' } } })
  first.ingestCodexEvent('session-persisted', { kind: 'notification', method: 'item/fileChange/patchUpdated', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'file-1', changes: [{ path: 'a.ts' }] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(persisted.state.schemaVersion, 2)
  const fresh = createStore(bridge)
  const restored = await fresh.restorePersisted('session-persisted')
  assert.equal(restored.events[0].payload.text, 'restored goal')
  assert.equal(restored.binding.runtimeThreadId, 'thread-a')
  const restoredTypes = new Set(restored.events.map(event => event.type))
  assert.equal(restoredTypes.has('reasoning'), true)
  assert.equal(restoredTypes.has('commandExecution'), true)
  assert.equal(restoredTypes.has('fileChange'), true)
  assert.equal(fresh.snapshot('session-persisted').revision, restored.revision)
})

test('recovery handoff carries persisted logical-session context without changing generation', () => {
  const store = createStore()
  store.appendUser('session-recovery', 'continue this work')
  store.appendAssistant('session-recovery', 'last known result')
  store.setBinding('session-recovery', { generation: 3, profileId: 'profile-a', projectId: 'project-a', runtimeThreadId: 'dead-thread' })
  const handoff = store.buildRecoveryHandoff('session-recovery')
  assert.equal(handoff.protocol, 'zero3.session-recovery-handoff.v1')
  assert.equal(handoff.generation, 3)
  assert.equal(handoff.failed_runtime_thread_id, 'dead-thread')
  assert.equal(handoff.runtime_state.current_goal, 'continue this work')
  assert.ok(handoff.session_delta.events.length >= 2)
})

test('runtime echo of the caller\'s own input merges into the optimistic user bubble instead of duplicating it', () => {
  const store = createStore()
  store.appendUser('session-echo', 'hello there')
  store.ingestCodexEvent('session-echo', { kind: 'notification', method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello there' }] } } })
  store.ingestCodexEvent('session-echo', { kind: 'notification', method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello there' }] } } })
  const userEvents = store.events('session-echo').filter(event => event.type === 'userMessage')
  assert.equal(userEvents.length, 1)
  assert.equal(userEvents[0].itemId, 'user-1')
  assert.equal(userEvents[0].payload.status, 'completed')
})

test('runtime echo of a distinct user item is not merged into an unrelated optimistic message', () => {
  const store = createStore()
  store.appendUser('session-distinct', 'first message')
  store.ingestCodexEvent('session-distinct', { kind: 'notification', method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'a different message' }] } } })
  const userEvents = store.events('session-distinct').filter(event => event.type === 'userMessage')
  assert.equal(userEvents.length, 2)
})

test('legacy messages migrate once while the legacy source remains unchanged for rollback', () => {
  const store = createStore()
  const legacy = {
    id: 'legacy-session', projectId: 'project-a', zero3ProfileId: 'profile-a', model: 'model-a', thinkingEffort: 'high', runtimeId: null,
    messages: [
      { id: 'legacy-u', role: 'user', content: 'legacy question', createdAt: '2026-09-11T00:00:00.000Z' },
      { id: 'legacy-a', role: 'assistant', content: 'legacy answer', createdAt: '2026-09-11T00:00:01.000Z' }
    ]
  }
  const original = JSON.stringify(legacy.messages)
  const migrated = store.ensureMigrated(legacy)
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.migrationVersion, 1)
  assert.equal(migrated.events.length, 2)
  assert.equal(migrated.events[0].eventId, 'legacy-legacy-u')
  assert.equal(migrated.events[1].payload.text, 'legacy answer')
  assert.equal(JSON.stringify(legacy.messages), original)
  const again = store.ensureMigrated(legacy)
  assert.equal(again.events.length, 2)
})

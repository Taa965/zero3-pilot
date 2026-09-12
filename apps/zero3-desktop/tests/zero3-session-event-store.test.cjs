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

function createStore() {
  const values = new Map()
  const window = {
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

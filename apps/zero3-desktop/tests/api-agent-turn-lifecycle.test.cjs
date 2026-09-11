const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')
const source = fs.readFileSync(path.join(__dirname, '../scripts/apply-session-provider-runtime.mjs'), 'utf8')
const idHelper = source.slice(source.indexOf('function zero3ApiAgentId('), source.indexOf('function zero3ApiAgentHistory('))
const helpers = source.slice(source.indexOf('function zero3ApiAgentTurnFromRead('), source.indexOf('async function zero3ApiAgentTurn('))
const terminal = (status = 'completed', threadId = 'thread-1', turnId = 'turn-1', items = [{ type: 'agentMessage', text: '真实最终回复' }]) => ({
  kind: 'notification', method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items, error: { message: 'model error' } } }
})
function fixture({ onStart, onSleep, read, timeout = 2000 } = {}) {
  let listener, now = 0, tick = 0, subscriptions = 0
  const calls = []
  const emit = event => listener?.(event)
  const context = {
    Error, Date: { now: () => now },
    ZERO3_API_TIMEOUT_MS: timeout, ZERO3_API_AGENT_BRIDGE_POLL_MS: 250,
    zero3SessionRecord: value => value && typeof value === 'object' ? value : {},
    zero3CodexAppServer: {
      subscribe(callback) { listener = callback; subscriptions++; return () => { listener = undefined; subscriptions-- } },
      request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'turn/start') { onStart?.(emit); return { turn: { id: 'turn-1' } } }
        if (method === 'thread/read' && read) return read()
        throw new Error('Unexpected history read while turn is active')
      }
    },
    setTimeout(callback, ms) { now += ms; onSleep?.(++tick, emit); callback() }
  }
  vm.runInNewContext(stripTypeScriptTypes(idHelper + helpers), context)
  return { run: () => context.zero3ApiAgentRunTurn('thread-1', [{ type: 'text', text: 'test' }]), calls, subscriptions: () => subscriptions }
}

test('tool work waits for authoritative completion without consulting misleading interrupted snapshots', async () => {
  const f = fixture({ onSleep: (tick, emit) => {
    emit({ kind: 'notification', method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution' } } })
    if (tick === 3) emit(terminal())
  } })
  assert.equal(await f.run(), '真实最终回复')
  assert.deepEqual(f.calls.map(call => call.method), ['turn/start'])
  assert.equal(f.subscriptions(), 0)
})

test('completion before turn/start returns is retained', async () => {
  const f = fixture({ onStart: emit => emit(terminal()) })
  assert.equal(await f.run(), '真实最终回复')
  assert.equal(f.subscriptions(), 0)
})

test('notifications must match both thread and turn', async () => {
  const f = fixture({ onStart: emit => { emit(terminal('interrupted', 'other-thread')); emit(terminal('failed', 'thread-1', 'other-turn')) },
    onSleep: (_, emit) => emit(terminal()) })
  assert.equal(await f.run(), '真实最终回复')
})

for (const [status, expected] of [['interrupted', /turn 已被中断/], ['failed', /turn 失败.*model error/]]) {
  test(`real ${status} notifications fail without retrying the task`, async () => {
    const f = fixture({ onStart: emit => emit(terminal(status)) })
    await assert.rejects(f.run(), expected)
    assert.equal(f.calls.length, 1)
    assert.equal(f.subscriptions(), 0)
  })
}

for (const state of ['stopped', 'error']) test(`transport ${state} does not leave a waiting subscription`, async () => {
  const f = fixture({ onSleep: (_, emit) => emit({ kind: 'lifecycle', state, detail: 'test disconnect' }) })
  await assert.rejects(f.run(), /连接已关闭/)
  assert.equal(f.subscriptions(), 0)
})

test('request rejection cleans up the listener', async () => {
  const failure = new Error('turn/start rejected')
  const f = fixture({ onStart: () => { throw failure } })
  await assert.rejects(f.run(), error => error === failure)
  assert.equal(f.subscriptions(), 0)
})

test('a missing terminal notification is bounded and never resubmits', async () => {
  const f = fixture({ timeout: 500 })
  await assert.rejects(f.run(), /turn 超时/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.subscriptions(), 0)
})

test('history is used only after confirmed completion if a server omits final items', async () => {
  const f = fixture({ onStart: emit => emit(terminal('completed', 'thread-1', 'turn-1', [])),
    read: () => ({ thread: { turns: [terminal().params.turn] } }) })
  assert.equal(await f.run(), '真实最终回复')
  assert.deepEqual(f.calls.map(call => call.method), ['turn/start', 'thread/read'])
  assert.equal(f.subscriptions(), 0)
})

test('both desktop API and robot entrypoints use the notification-backed runner', () => {
  const robot = fs.readFileSync(path.join(__dirname, '../scripts/apply-weixin-robot-runtime.mjs'), 'utf8')
  assert.match(robot, /await zero3ApiAgentRunTurn\(threadId/)
  assert.match(source.slice(source.indexOf('async function zero3ApiAgentTurn(')), /await zero3ApiAgentRunTurn\(threadId/)
  assert.doesNotMatch(robot, /await zero3ApiAgentWaitForTurn\(threadId/)
})

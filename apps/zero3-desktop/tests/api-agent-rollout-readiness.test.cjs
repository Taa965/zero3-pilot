const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../scripts/apply-session-provider-runtime.mjs'), 'utf8')
const helpers = source.slice(source.indexOf('function zero3ApiAgentTurnFromRead('), source.indexOf('async function zero3ApiAgentTurn('))
const empty = new Error('[-32603] failed to read thread: thread-store internal error: failed to read session metadata C:\\sessions\\rollout.jsonl: rollout at C:\\sessions\\rollout.jsonl is empty')
const completed = { thread: { turns: [{ id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: '微信回复正常' }] }] } }
function fixture(responses, timeout = 60_000) {
  let now = 0
  const calls = []
  const sleeps = []
  const context = {
    Error, Date: { now: () => now },
    ZERO3_API_TIMEOUT_MS: timeout, ZERO3_API_AGENT_BRIDGE_POLL_MS: 250,
    zero3SessionRecord: value => value && typeof value === 'object' ? value : {},
    zero3CodexAppServer: { request: async (method, params) => {
      calls.push({ method, threadId: params.threadId, includeTurns: params.includeTurns })
      const result = responses[Math.min(calls.length - 1, responses.length - 1)]
      if (result instanceof Error) throw result
      return result
    } },
    setTimeout: (callback, ms) => { now += ms; sleeps.push(ms); callback() }
  }
  vm.runInNewContext(stripTypeScriptTypes(helpers), context)
  return { wait: () => context.zero3ApiAgentWaitForTurn('thread-1', 'turn-1'), calls, sleeps }
}

test('a fresh rollout can be empty before returning the original turn reply', async () => {
  const f = fixture([empty, empty, { thread: { turns: [] } }, completed])
  assert.equal(await f.wait(), '微信回复正常')
  assert.equal(f.calls.length, 4)
  assert.ok(f.calls.every(call => call.method === 'thread/read' && call.threadId === 'thread-1' && call.includeTurns === true))
  assert.deepEqual(f.sleeps, [250, 250, 250])
})

test('a persistently empty rollout stops after the startup grace period with the original error', async () => {
  const f = fixture([empty])
  await assert.rejects(f.wait(), error => error === empty)
  assert.equal(f.sleeps.reduce((a, b) => a + b, 0), 10_000)
})

test('the overall turn deadline still limits persistence retries', async () => {
  const f = fixture([empty], 500)
  await assert.rejects(f.wait(), /turn 超时/)
  assert.equal(f.calls.length, 2)
})

for (const message of [
  '[-32603] failed to read thread: permission denied',
  'failed to read session metadata C:\\sessions\\rollout.jsonl: malformed JSON',
  'thread not found',
  'upstream response is empty'
]) test(`unrelated read errors are not retried: ${message}`, async () => {
  const failure = new Error(message)
  const f = fixture([failure, completed])
  await assert.rejects(f.wait(), error => error === failure)
  assert.equal(f.calls.length, 1)
})

for (const [status, expected] of [['failed', /turn 失败/], ['interrupted', /turn 已被中断/]]) {
  test(`turn ${status} after persistence recovery is still reported`, async () => {
    const f = fixture([empty, { thread: { turns: [{ id: 'turn-1', status, error: 'model rejected' }] } }])
    await assert.rejects(f.wait(), expected)
    assert.equal(f.calls.length, 2)
  })
}

test('normal completion returns without an added delay', async () => {
  const f = fixture([completed])
  assert.equal(await f.wait(), '微信回复正常')
  assert.equal(f.sleeps.length, 0)
})

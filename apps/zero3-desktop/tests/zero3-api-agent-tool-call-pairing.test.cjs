const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')

// DeepSeek and GLM both reject a chat-completions payload with
// "An assistant message with 'tool_calls' must be followed by tool messages
// responding to each 'tool_call_id'." Codex sends every tool call as its own
// Responses item, so the conversion into chat messages has to re-group them and
// make sure the pairing survives whatever the kernel recorded.
const runtime = fs.readFileSync(path.join(__dirname, '../scripts/apply-codex-transport.mjs'), 'utf8')
const sessionProvider = fs.readFileSync(path.join(__dirname, '../scripts/apply-session-provider-runtime.mjs'), 'utf8')
const conversion = runtime.slice(runtime.indexOf('function zero3CodexRecord('), runtime.indexOf('function zero3CodexRequiredString(')) +
  runtime.slice(runtime.indexOf('function zero3GlmText('), runtime.indexOf('function zero3GlmTools('))

function convert(input, instructions) {
  const context = {}
  vm.runInNewContext(stripTypeScriptTypes(conversion), context)
  return context.zero3GlmMessages(input, instructions)
}

function message(role, text) {
  return { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }
}
function call(id, name, args = '{}') {
  return { type: 'function_call', call_id: id, name, arguments: args }
}
function output(id, text = 'ok') {
  return { type: 'function_call_output', call_id: id, output: text }
}

// The rule the upstream APIs enforce, checked on the exact message list that
// leaves the bridge.
function assertUpstreamValid(messages) {
  const declared = new Set()
  for (let index = 0; index < messages.length; index++) {
    const item = messages[index]
    assert.ok(item && typeof item === 'object', `message ${index} must be an object`)
    if (item.role === 'tool') {
      assert.ok(declared.has(item.tool_call_id),
        `message ${index} is a tool reply for ${String(item.tool_call_id)} that no assistant message requested`)
      assert.equal(typeof item.content, 'string', `tool reply ${index} needs string content`)
      assert.ok(item.content.length > 0, `tool reply ${index} must not be empty`)
      continue
    }
    const calls = Array.isArray(item.tool_calls) ? item.tool_calls : []
    if (!calls.length) continue
    assert.equal(item.role, 'assistant', `message ${index} carries tool_calls but is ${String(item.role)}`)
    const ids = calls.map(entry => entry.id)
    for (const id of ids) {
      assert.equal(typeof id, 'string')
      assert.ok(id.length > 0)
      assert.ok(!declared.has(id), `tool_call_id ${id} was requested twice`)
      declared.add(id)
    }
    const replies = messages.slice(index + 1, index + 1 + ids.length)
    assert.equal(replies.length, ids.length, `message ${index} requests ${ids.length} calls but only ${replies.length} messages follow`)
    ids.forEach((id, position) => {
      assert.equal(replies[position].role, 'tool',
        `message ${index} call ${id} is followed by a ${String(replies[position].role)} message`)
      assert.equal(replies[position].tool_call_id, id)
    })
  }
}

test('a single tool round trip keeps the call and its reply adjacent', () => {
  assertUpstreamValid(convert([message('user', 'hi'), call('c1', 'shell'), output('c1')]))
})

test('parallel tool calls are grouped into one assistant message', () => {
  // Codex records each call of one model response as its own item, so a
  // two-call response arrives as call, call, output, output. Sending that as
  // two assistant messages makes every upstream API reject the request.
  const messages = convert([
    message('user', 'inspect the repo'),
    call('c1', 'shell', '{"command":["git","status"]}'),
    call('c2', 'shell', '{"command":["ls"]}'),
    output('c1', 'clean'),
    output('c2', 'README.md')
  ])
  assertUpstreamValid(messages)
  const grouped = messages.filter(item => Array.isArray(item.tool_calls))
  assert.equal(grouped.length, 1)
  // The conversion runs in its own vm realm, so compare plain copies.
  assert.deepEqual([...grouped[0].tool_calls].map(entry => entry.id), ['c1', 'c2'])
  assert.equal(messages.filter(item => item.role === 'tool').length, 2)
})

test('an unsanswered call never leaves an assistant tool_calls message dangling', () => {
  // An interrupted or failed tool leaves exactly this history behind.
  const messages = convert([message('user', 'run it'), call('c1', 'shell'), call('c2', 'shell'), output('c1'), message('user', 'and now?')])
  assertUpstreamValid(messages)
  assert.equal(messages.at(-1).role, 'user')
})

test('a partially recorded turn still answers every requested call id', () => {
  const messages = convert([message('user', 'go'), call('c1', 'shell'), call('c2', 'shell'), output('c2', 'only the second one came back')])
  assertUpstreamValid(messages)
})

test('orphan tool replies from a truncated history are dropped', () => {
  // Context compaction can keep the output whose call was trimmed away.
  const messages = convert([output('gone', 'stale'), message('user', 'hi'), call('c1', 'shell'), output('c1')])
  assertUpstreamValid(messages)
  assert.ok(!messages.some(item => item.role === 'tool' && item.tool_call_id === 'gone'))
})

test('interleaved assistant text still leaves the reply right after the call', () => {
  const messages = convert([message('user', 'hi'), call('c1', 'shell'), message('assistant', 'thinking out loud'), output('c1')])
  assertUpstreamValid(messages)
})

test('custom tool calls pair like function calls', () => {
  const messages = convert([
    message('user', 'patch it'),
    { type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: '*** Begin Patch' },
    { type: 'custom_tool_call_output', call_id: 'p1', output: 'Success' }
  ])
  assertUpstreamValid(messages)
})

test('tool replies carry content even when the kernel recorded none', () => {
  const messages = convert([message('user', 'hi'), call('c1', 'shell'), { type: 'function_call_output', call_id: 'c1', output: '' }])
  assertUpstreamValid(messages)
})

test('the Zero3 API Agent bridge converts through the repaired helper', () => {
  const openAi = sessionProvider.slice(sessionProvider.indexOf('private async fetchOpenAiCompatible('), sessionProvider.indexOf('private async fetchAnthropic('))
  assert.match(openAi, /zero3GlmMessages\(body\.input, body\.instructions\)/)
  assert.doesNotMatch(sessionProvider, /function zero3GlmMessages\(/)
  // The constants that label an unrecorded result are shared by every protocol.
  assert.match(runtime, /const ZERO3_TOOL_OUTPUT_UNRECORDED = /)
  assert.match(sessionProvider, /ZERO3_TOOL_OUTPUT_UNRECORDED/)
})

// Anthropic and Gemini enforce the same pairing with their own vocabulary, so
// the two other protocols the Zero3 API profiles can speak are checked too.
const shared = {}
vm.runInNewContext(stripTypeScriptTypes(
  runtime.slice(runtime.indexOf('function zero3CodexRecord('), runtime.indexOf('function zero3CodexRequiredString(')) +
  runtime.slice(runtime.indexOf('function zero3GlmText('), runtime.indexOf('function zero3GlmTools(')) +
  runtime.slice(runtime.indexOf('function zero3GlmTools('), runtime.indexOf('function zero3GlmResponseUsage('))
), shared)
vm.runInNewContext(stripTypeScriptTypes(
  sessionProvider.slice(sessionProvider.indexOf('function zero3SessionRecord('), sessionProvider.indexOf('function zero3SessionText(')) +
  sessionProvider.slice(sessionProvider.indexOf('function zero3ApiAgentToolArguments('), sessionProvider.indexOf('function zero3ApiAnthropicPayload(')) +
  sessionProvider.slice(sessionProvider.indexOf('function zero3ApiAnthropicPayload('), sessionProvider.indexOf('function zero3ApiAnthropicResponse(')) +
  sessionProvider.slice(sessionProvider.indexOf('function zero3ApiGeminiPayload('), sessionProvider.indexOf('function zero3ApiGeminiResponse('))
), Object.assign(shared, {
  Map, Set, JSON,
  ZERO3_TOOL_OUTPUT_UNRECORDED: 'Zero3 bridge: missing',
  ZERO3_TOOL_OUTPUT_EMPTY: 'Zero3 bridge: empty'
}))

function assertAnthropicValid(messages) {
  const declared = new Set()
  for (let index = 0; index < messages.length; index++) {
    const item = messages[index]
    if (index > 0) assert.notEqual(messages[index - 1].role, item.role, 'Anthropic requires alternating roles')
    const blocks = item.content
    if (item.role === 'assistant') {
      // Values cross a vm realm boundary, so everything compared is copied first.
      const calls = [...blocks].filter(block => block.type === 'tool_use')
      if (!calls.length) continue
      const replies = messages[index + 1]
      assert.equal(replies?.role, 'user', `tool_use at ${index} must be answered by the next message`)
      const results = [...replies.content].filter(block => block.type === 'tool_result')
      assert.deepEqual(results.map(block => block.tool_use_id), calls.map(block => block.id))
      assert.deepEqual([...replies.content].slice(0, results.length).map(block => block.type), results.map(() => 'tool_result'))
      for (const block of results) assert.ok(String(block.content).length > 0)
      for (const block of calls) {
        assert.ok(!declared.has(block.id))
        declared.add(block.id)
      }
      continue
    }
    for (const block of blocks.filter(entry => entry.type === 'tool_result')) {
      assert.ok(declared.has(block.tool_use_id), `tool_result ${block.tool_use_id} has no tool_use`)
    }
  }
}

function assertGeminiValid(contents) {
  for (let index = 0; index < contents.length; index++) {
    const parts = contents[index].parts
    const calls = parts.filter(part => part.functionCall)
    if (contents[index].role !== 'model' || !calls.length) continue
    const replies = contents[index + 1]
    assert.equal(replies?.role, 'user', `functionCall at ${index} must be answered by the next turn`)
    const results = replies.parts.filter(part => part.functionResponse)
    assert.deepEqual([...results].map(part => part.functionResponse.name), [...calls].map(part => part.functionCall.name))
    for (const part of results) assert.ok(String(part.functionResponse.response.result).length > 0)
  }
}

test('the Anthropic payload answers every tool_use in the next message', () => {
  const payload = shared.zero3ApiAnthropicPayload({
    input: [message('user', 'go'), call('c1', 'shell'), call('c2', 'shell'), output('c2', 'second'), message('user', 'and now?')]
  }, 'claude-test')
  assertAnthropicValid([...payload.messages])
  assert.equal([...payload.messages].filter(item => item.content.some(block => block.type === 'tool_use')).length, 1)
})

test('the Gemini payload answers every functionCall in the next turn', () => {
  const payload = shared.zero3ApiGeminiPayload({
    input: [message('user', 'go'), call('c1', 'shell'), call('c2', 'shell'), output('c1', 'first'), message('user', 'and now?')]
  })
  assertGeminiValid([...payload.contents])
  assert.equal([...payload.contents].filter(item => item.parts.some(part => part.functionCall)).length, 1)
})

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
const transport = fs.readFileSync(path.join(root, 'scripts', 'apply-codex-transport.mjs'), 'utf8')

function slice(text, from, to) {
  const start = text.indexOf(from)
  const end = to == null ? undefined : text.indexOf(to, start)
  assert.ok(start >= 0, `marker not found: ${from}`)
  assert.ok(end === undefined || end > start, `marker not found: ${to}`)
  return text.slice(start, end)
}

// Production conversion helpers, extracted verbatim so the tests exercise the
// same code the electron main process runs.
const helpers = [
  slice(source, 'function zero3SessionRecord(', 'function zero3SessionText('),
  slice(source, 'function zero3Endpoint(', 'type Zero3ApiAgentBridgeProfile'),
  slice(source, 'function zero3ApiAgentResponseItems(', 'function zero3ApiAgentStreamItems('),
  slice(source, 'function zero3ApiAgentStreamItems(', 'function zero3ApiAgentUsage('),
  slice(source, 'function zero3ApiAgentUsage(', 'function zero3ApiAgentToolArguments('),
  slice(source, 'function zero3ApiAgentToolArguments(', 'function zero3ApiAnthropicPayload('),
  slice(source, 'function zero3ApiAnthropicPayload(', 'function zero3ApiAnthropicResponse('),
  slice(source, 'function zero3ApiGeminiPayload(', 'function zero3ApiGeminiResponse('),
  slice(source, 'async function zero3ApiAgentStreamSse(', 'class Zero3ApiAgentStreamEmitter'),
  slice(source, 'class Zero3ApiAgentStreamEmitter', 'function zero3ApiAgentUpstreamError'),
  slice(source, 'function zero3ApiAgentUpstreamError', 'class Zero3ApiAgentResponsesBridge'),
  slice(transport, 'const ZERO3_TOOL_OUTPUT_UNRECORDED', 'const ZERO3_REASONING_UNRECORDED'),
  slice(transport, 'function zero3GlmText(', 'function zero3GlmToolOutput('),
  slice(transport, 'function zero3GlmToolOutput(', 'function zero3GlmMessageContent('),
  slice(transport, 'function zero3GlmResponseUsage(', 'function zero3GlmResponseItems(')
].join('\n')

// The streaming methods stay inside the generated class body; wrap them in a
// test bridge whose fetchUpstream fallback is replaced by a stub.
const streamMethods = slice(source, '  // Streaming counterpart of fetchUpstream.', '  private async upstreamJson(')

const context = {
  Error, JSON, Map, Object, Array, String, Number, Date, Buffer, TextDecoder, Uint8Array,
  setTimeout, clearTimeout, AbortController,
  ZERO3_API_TIMEOUT_MS: 60_000,
  ZERO3_API_MAX_RESPONSE_BYTES: 16 * 1024 * 1024,
  zero3SessionRecord: value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  zero3CodexRecord: value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  zero3GlmMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  zero3GlmTools: value => (Array.isArray(value) ? value : [])
}
// Class declarations create global lexical bindings, not sandbox properties, so
// the pieces the class methods reference are captured via a completion value.
const exposed = vm.runInNewContext(stripTypeScriptTypes(
  helpers + '\n;({ zero3ApiAgentStreamSse, Zero3ApiAgentStreamEmitter, zero3ApiAgentUpstreamError })'
), context)
Object.assign(context, exposed)

const fetchCalls = []
let upstreamResponses = []
let fetchUpstreamResult = null
let fetchUpstreamCalls = 0

function sseResponse(frames, { chunkSplit = 0 } = {}) {
  const text = frames.map(frame => {
    const data = typeof frame === 'string' ? frame : 'data: ' + JSON.stringify(frame)
    return data + '\n\n'
  }).join('')
  const encoded = Buffer.from(text, 'utf8')
  async function* body() {
    if (chunkSplit <= 0) {
      yield encoded
      return
    }
    for (let index = 0; index < encoded.length; index += chunkSplit) {
      yield encoded.subarray(index, index + chunkSplit)
    }
  }
  return { ok: true, status: 200, body: body(), text: async () => text }
}

function errorResponse(status, message) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message } })
  }
}

function makeBridge() {
  const TestBridge = vm.runInNewContext(stripTypeScriptTypes(
    'class TestBridge extends __BridgeBase {\n' + streamMethods + '\n};TestBridge'
  ), {
    ...context,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null })
      const next = upstreamResponses.shift()
      if (!next) throw new Error('no queued upstream response')
      if (typeof next === 'function') return next()
      return next
    },
    __BridgeBase: class {
      async fetchUpstream() {
        fetchUpstreamCalls += 1
        if (fetchUpstreamResult instanceof Error) throw fetchUpstreamResult
        return fetchUpstreamResult
      }
    }
  })
  return new TestBridge()
}

const profile = (protocol = 'openai_compatible', baseUrl = 'https://provider.example/v1') => ({
  profileId: 'profile-1',
  protocol,
  baseUrl,
  apiKey: 'sk-test',
  token: 'token'
})

function eventsOf(emitCalls) {
  return emitCalls.map(([kind]) => kind)
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('OpenAI-compatible upstream streams reasoning, text and tool calls as real Responses deltas', async () => {
  fetchCalls.length = 0
  upstreamResponses = [sseResponse([
    { choices: [{ delta: { reasoning_content: '先想' } }] },
    { choices: [{ delta: { reasoning_content: '一步' } }] },
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { content: '，世界' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'shell', arguments: '{"cmd"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
    '[DONE]'
  ], { chunkSplit: 7 })]
  const emitCalls = []
  const bridge = makeBridge()
  const result = await bridge.streamOpenAiCompatible(profile(), { input: [], instructions: '' }, 'test-model', (kind, payload) => emitCalls.push([kind, payload]))
  assert.deepEqual(eventsOf(emitCalls), [
    'response.output_item.added',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.delta',
    'response.output_item.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_item.done',
    'response.output_item.done',
    'response.output_item.done'
  ])
  const addedReasoning = emitCalls[0][1]
  assert.equal(addedReasoning.item.type, 'reasoning')
  const textDelta = emitCalls[4][1]
  assert.equal(textDelta.delta, '你好')
  const doneReasoning = emitCalls[6][1].item
  assert.equal(doneReasoning.type, 'reasoning')
  assert.equal(doneReasoning.summary[0].text, '先想一步')
  const doneMessage = emitCalls[7][1].item
  assert.equal(doneMessage.type, 'message')
  assert.equal(doneMessage.content[0].text, '你好，世界')
  const doneCall = emitCalls[8][1].item
  assert.deepEqual(plain(doneCall), { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}' })
  assert.deepEqual(plain(result.usage), { input_tokens: 11, input_tokens_details: null, output_tokens: 7, output_tokens_details: null, total_tokens: 18 })
  assert.equal(result.items.length, 3)
  assert.equal(fetchCalls[0].body.stream, true)
  assert.deepEqual(fetchCalls[0].body.stream_options, { include_usage: true })
})

test('stream_options rejection retries without the OpenAI extension before giving up', async () => {
  fetchCalls.length = 0
  upstreamResponses = [
    () => errorResponse(400, 'Unknown field: stream_options'),
    sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]'])
  ]
  const bridge = makeBridge()
  const result = await bridge.streamOpenAiCompatible(profile(), { input: [] }, 'm', () => {})
  assert.equal(fetchCalls.length, 2)
  assert.equal(fetchCalls[0].body.stream_options.include_usage, true)
  assert.equal('stream_options' in fetchCalls[1].body, false)
  assert.equal(result.items[0].content[0].text, 'ok')
})

test('a provider that rejects streaming falls back to one non-streaming request with no fake deltas', async () => {
  fetchCalls.length = 0
  upstreamResponses = [
    () => errorResponse(400, 'streaming is not supported'),
    () => errorResponse(400, 'streaming is not supported')
  ]
  fetchUpstreamCalls = 0
  fetchUpstreamResult = { items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '一次给全' }] }], usage: { input_tokens: 3, output_tokens: 2 } }
  const emitCalls = []
  const bridge = makeBridge()
  const result = await bridge.streamUpstream(profile(), { model: 'test-model', input: [], stream: true }, (kind, payload) => emitCalls.push([kind, payload]))
  assert.equal(fetchUpstreamCalls, 1)
  assert.deepEqual(eventsOf(emitCalls), ['response.output_item.done'])
  assert.equal(result.items[0].content[0].text, '一次给全')
})

test('a stream that breaks after emitting deltas surfaces the error instead of double-sending', async () => {
  fetchCalls.length = 0
  async function* brokenBody() {
    yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '前半' } }] }) + '\n\n', 'utf8')
    throw new Error('connection reset mid-stream')
  }
  upstreamResponses = [{ ok: true, status: 200, body: brokenBody(), text: async () => '' }]
  fetchUpstreamCalls = 0
  fetchUpstreamResult = { items: [], usage: {} }
  const emitCalls = []
  const bridge = makeBridge()
  await assert.rejects(bridge.streamUpstream(profile(), { model: 'test-model', input: [], stream: true }, (kind, payload) => emitCalls.push([kind, payload])), /connection reset/)
  assert.equal(fetchUpstreamCalls, 0)
  assert.equal(emitCalls.filter(([kind]) => kind === 'response.output_text.delta').length, 1)
})

test('Anthropic content-block streaming maps thinking, text, tool_use and usage', async () => {
  fetchCalls.length = 0
  upstreamResponses = [sseResponse([
    { type: 'message_start', message: { usage: { input_tokens: 21 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '中' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu-1', name: 'read_file' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"a.ts"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' }
  ])]
  const emitCalls = []
  const bridge = makeBridge()
  const result = await bridge.streamAnthropic(profile('anthropic', 'https://api.anthropic.com/v1'), { input: [] }, 'claude-test', (kind, payload) => emitCalls.push([kind, payload]))
  const deltas = emitCalls.filter(([kind]) => kind === 'response.output_text.delta')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0][1].delta, '答案')
  const reasoningDeltas = emitCalls.filter(([kind]) => kind === 'response.reasoning_summary_text.delta')
  assert.equal(reasoningDeltas.length, 2)
  const doneCalls = emitCalls.filter(([kind]) => kind === 'response.output_item.done')
  assert.equal(doneCalls.length, 3)
  assert.equal(doneCalls[0][1].item.type, 'reasoning')
  assert.equal(doneCalls[0][1].item.summary[0].text, '思考中')
  assert.equal(doneCalls[2][1].item.call_id, 'toolu-1')
  assert.equal(doneCalls[2][1].item.arguments, '{"path":"a.ts"}')
  assert.deepEqual(plain(result.usage), { input_tokens: 21, input_tokens_details: null, output_tokens: 9, output_tokens_details: null, total_tokens: 30 })
  assert.equal(fetchCalls[0].body.stream, true)
})

test('Gemini alt=sse streaming maps text parts, functionCall parts and usageMetadata', async () => {
  fetchCalls.length = 0
  upstreamResponses = [sseResponse([
    { candidates: [{ content: { parts: [{ text: '你好' }] } }] },
    { candidates: [{ content: { parts: [{ text: '，回答' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'shell', args: { cmd: 'ls' } } }] } }] },
    { usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 5 } }
  ])]
  const emitCalls = []
  const bridge = makeBridge()
  const result = await bridge.streamGemini(profile('google_gemini', 'https://gemini.example/v1beta'), { input: [] }, 'gemini-test', (kind, payload) => emitCalls.push([kind, payload]))
  const deltas = emitCalls.filter(([kind]) => kind === 'response.output_text.delta')
  assert.equal(deltas.length, 2)
  assert.deepEqual(deltas.map(call => call[1].delta), ['你好', '，回答'])
  const doneItems = emitCalls.filter(([kind]) => kind === 'response.output_item.done').map(call => call[1].item)
  assert.equal(doneItems.length, 2)
  assert.equal(doneItems[1].type, 'function_call')
  assert.equal(doneItems[1].name, 'shell')
  assert.equal(doneItems[1].arguments, '{"cmd":"ls"}')
  assert.deepEqual(plain(result.usage), { input_tokens: 13, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 18 })
  assert.ok(fetchCalls[0].url.includes(':streamGenerateContent'))
  assert.ok(fetchCalls[0].url.includes('alt=sse'))
})

test('the SSE frame parser survives CRLF frames, comments and frames split across chunks', async () => {
  const frames = []
  async function* body() {
    yield Buffer.from('dat', 'utf8')
    yield Buffer.from('a: {"n":1}\r\n: keep-alive comment\r\n\r\ndata: [DO', 'utf8')
    yield Buffer.from('NE]\n\nevent: custom\ndata: first\ndata: second\n\n', 'utf8')
  }
  await context.zero3ApiAgentStreamSse({ ok: true, body: body() }, 16 * 1024 * 1024, frame => frames.push(frame))
  assert.equal(frames.length, 3)
  assert.equal(frames[0].data, '{"n":1}')
  assert.equal(frames[1].data, '[DONE]')
  assert.equal(frames[2].event, 'custom')
  assert.equal(frames[2].data, 'first\nsecond')
})

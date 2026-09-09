const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.resolve(root, '../../upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')

function evaluate(source, globals = {}, overrides = {}) {
  const exports = {}
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
  vm.runInNewContext(result.outputText, {
    exports, require: name => overrides[name] ?? require(name), Error, Buffer, console,
    setTimeout, clearTimeout, ...globals
  })
  return exports
}
function load(relative, globals, overrides) {
  return evaluate(fs.readFileSync(path.join(root, relative), 'utf8'), globals, overrides)
}
const recovery = load('ui-v2/conversations/local-turn-failure.ts')

test('recover historical Claude JSON and Codex progress-only errors', () => {
  const message = recovery.localTurnFailureMessage(new Error("Error invoking remote method 'zero3:session-providers:claude-turn': Error: " + JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 403 Request not allowed', usage: {} })))
  assert.equal(message, 'Failed to authenticate. API Error: 403 Request not allowed')
  assert.equal(recovery.localTurnRecovery('claude', message), 'auth')
  assert.equal(recovery.localTurnRecovery('codex', 'Reading prompt from stdin...'), 'model')
  assert.equal(recovery.localTurnRecovery('codex', "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."), 'model')
  assert.equal(recovery.localTurnRecovery('claude', 'output exceeded 16 MiB'), null)
  const wrapped = 'Claude CLI 执行失败：' + JSON.stringify({ is_error: true, result: '403 Request not allowed', usage: {} }) + '（完整输出见 log）'
  assert.equal(recovery.localTurnFailureMessage(wrapped), 'Claude CLI 执行失败：403 Request not allowed（完整输出见 log）')
  const truncated = recovery.localTurnFailureMessage('Claude CLI 执行失败：{"duration_api_ms":0,"usage":{"web_sear（完整输出见 log）')
  assert.match(truncated, /旧版本截断了错误详情/)
  assert.match(truncated, /完整输出见 log/)
  assert.equal(recovery.localTurnRecovery('claude', truncated), null)
})

function sessionStore() {
  const storage = new Map()
  return load('ui-v2/adapters/LocalSessionAdapter.ts', {
    window: { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} },
    CustomEvent: class {}, crypto: require('node:crypto').webcrypto
  }).LocalSessionAdapter
}

test('reset rejected model without losing messages, runtime id or project binding', () => {
  const store = sessionStore()
  const session = store.create('codex', 'project-1', null, { model: 'rejected-model', thinkingEffort: 'high', projectBinding: { provider: 'codex', rootPath: 'C:/work', revision: 1, externalId: 'native-project' } })
  store.setRuntimeId(session.id, 'existing-thread')
  store.appendMessage(session.id, 'user', 'Please continue')
  const result = store.resetRuntimeConfig(session.id)
  assert.equal(result.model, null)
  assert.equal(result.thinkingEffort, null)
  assert.equal(result.runtimeId, 'existing-thread')
  assert.equal(result.projectId, 'project-1')
  assert.equal(result.projectBinding.externalId, 'native-project')
  assert.equal(result.messages[0].content, 'Please continue')
})

function runtimeFixture({ output, stderr = '', code = 0 }) {
  const source = fs.readFileSync(path.join(root, 'scripts/apply-session-provider-runtime.mjs'), 'utf8')
  const helpers = source.slice(source.indexOf('function zero3SessionRecord('), source.indexOf('function zero3SessionProvider('))
  const runtime = source.slice(source.indexOf('const ZERO3_TURN_LOG_FILE'), source.indexOf('async function zero3OpenProviderAuthorization('))
  const calls = []
  const logs = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.kill = () => {}
    child.stdin.end = prompt => {
      calls.push({ command, args, options, prompt })
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(output))
        child.stderr.emit('data', Buffer.from(stderr))
        child.emit('close', code)
      })
    }
    return child
  }
  const exports = evaluate(helpers + runtime + '\nexport { zero3RunCodexCliTurn, zero3RunClaudeTurn };', {
    path, app: { getPath: () => '/fixture' },
    process: { env: { CODEX_HOME: '/isolated-kernel' } },
    ZERO3_API_TIMEOUT_MS: 1000, ZERO3_LOCAL_AGENT_TIMEOUT_MS: 1000, ZERO3_API_MAX_RESPONSE_BYTES: 16 * 1024 * 1024,
    resolveWindowsCommand: command => ({ command, args: [] })
  }, {
    'node:child_process': { spawn },
    'node:fs/promises': { mkdir: async () => {}, stat: async () => ({ size: 0 }), appendFile: async (_, entry) => logs.push(JSON.parse(entry)) }
  })
  return { ...exports, calls, logs }
}

test('Codex reports the rejected model from JSON, ahead of stdin progress', async () => {
  const f = runtimeFixture({ code: 1, stderr: 'Reading prompt from stdin...\n', output: JSON.stringify({ type: 'turn.failed', error: { message: JSON.stringify({ detail: 'The selected model is not supported' }) } }) })
  await assert.rejects(f.zero3RunCodexCliTurn({ text: 'private prompt' }), /The selected model is not supported/)
  assert.equal(f.logs[0].promptChars, 14)
  assert.equal(JSON.stringify(f.logs).includes('private prompt'), false)
})

test('default Codex uses CLI config and preserves thread id on success', async () => {
  const f = runtimeFixture({ output: [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }
  ].map(JSON.stringify).join('\n') })
  const result = await f.zero3RunCodexCliTurn({ text: 'Reply OK', model: null, effort: null })
  assert.equal(result.text, 'OK')
  assert.equal(result.threadId, 'thread-1')
  assert.equal(f.calls[0].args.includes('--model'), false)
  assert.equal(f.calls[0].options.env.CODEX_HOME, undefined)
})

for (const code of [0, 1]) test(`Claude rejects authentication failure even with exit code ${code}, without logging prompt`, async () => {
  const f = runtimeFixture({ code, output: JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 403 Request not allowed' }) })
  await assert.rejects(f.zero3RunClaudeTurn({ text: 'private & prompt' }), /Failed to authenticate/)
  assert.equal(f.calls[0].prompt, 'private & prompt')
  assert.equal(f.calls[0].args.includes('private & prompt'), false)
  assert.equal(JSON.stringify(f.logs).includes('private & prompt'), false)
})

test('Claude stdin transport returns the real reply and resumed session id', async () => {
  const f = runtimeFixture({ output: JSON.stringify({ result: 'OK', session_id: 'session-1' }) })
  const result = await f.zero3RunClaudeTurn({ text: 'Reply OK', sessionId: 'session-1' })
  assert.equal(result.text, 'OK')
  assert.equal(result.sessionId, 'session-1')
  assert.equal(f.calls[0].args.at(-2), '--resume')
})

test('the actual conversation restores a failed prompt, resets its model, and sends successfully', async () => {
  const { JSDOM } = desktopRequire('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const before = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const React = desktopRequire('react')
  const { render, fireEvent, cleanup, act } = desktopRequire('@testing-library/react')
  const store = sessionStore()
  const session = store.create('codex', 'p1', null, { model: 'rejected-model', thinkingEffort: 'high' })
  store.appendMessage(session.id, 'user', 'Reply OK')
  store.appendMessage(session.id, 'assistant', '执行失败：Reading prompt from stdin...')
  const requests = []
  dom.window.zero3SessionProviders = { codexTurn: async request => { requests.push(request); return { text: 'OK', threadId: 'thread-ok' } } }
  const { LocalConversationSurface } = load('ui-v2/conversations/LocalConversationSurface.tsx', {
    window: dom.window, crypto: require('node:crypto').webcrypto
  }, {
    react: React, 'react/jsx-runtime': desktopRequire('react/jsx-runtime'),
    '@/components/ui/codicon': { Codicon: () => null },
    '../adapters/LocalSessionAdapter': { LocalSessionAdapter: store },
    '../adapters/ProjectLinkAdapter': { ProjectLinkAdapter: {} },
    './local-turn-failure': recovery
  })
  function Harness() {
    const [current, setCurrent] = React.useState(store.get(session.id))
    return React.createElement(LocalConversationSurface, { provider: 'codex', session: current, project: { id: 'p1', name: 'Project', rootPath: 'C:/work' }, onChanged: () => setCurrent(store.get(session.id)) })
  }
  try {
    const view = render(React.createElement(Harness))
    fireEvent.click(view.getByRole('button', { name: '恢复本机默认设置' }))
    assert.equal(view.getByRole('textbox').value, 'Reply OK')
    assert.equal(store.get(session.id).model, null)
    await act(async () => fireEvent.click(view.getByRole('button', { name: '发送' })))
    assert.equal(requests[0].model, null)
    assert.equal(requests[0].effort, null)
    assert.equal(store.get(session.id).runtimeId, 'thread-ok')
    assert.equal(store.get(session.id).messages.at(-1).content, 'OK')
    assert.equal(view.queryByRole('alert'), null)
  } finally {
    cleanup()
    dom.window.close()
    Object.assign(globalThis, before)
  }
})

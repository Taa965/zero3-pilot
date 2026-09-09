const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.resolve(root, '../../upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')
function evaluate(source, globals = {}, overrides = {}) {
  const exports = {}
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
  vm.runInNewContext(result.outputText, { exports, require: name => overrides[name] ?? require(name), Error, console, setTimeout, clearTimeout, ...globals })
  return exports
}
const source = name => fs.readFileSync(path.join(root, name), 'utf8')
const { createProviderReadiness } = evaluate(source('ui-v2/conversations/provider-readiness.ts'))
const ready = { available: true, authenticated: true, authMode: 'cli', detail: 'private CLI output' }
function storage() {
  const values = new Map()
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), values }
}

test('ready providers persist across reopen/restart without repeated detection or storing output', async () => {
  const saved = storage()
  let calls = 0
  const probe = async provider => { calls++; return { [provider]: ready } }
  const cache = createProviderReadiness(saved, probe)
  await Promise.all([cache.ensure('codex'), cache.ensure('codex')])
  await cache.ensure('codex')
  await createProviderReadiness(saved, probe).ensure('codex')
  assert.equal(calls, 1)
  assert.doesNotMatch([...saved.values.values()].join(), /private CLI output/)
})

test('success beats an older failed probe; invalidation removes persistent readiness; manual retry is available', async () => {
  const saved = storage()
  let resolve
  const cache = createProviderReadiness(saved, () => new Promise(r => { resolve = r }))
  const pending = cache.ensure('claude')
  await Promise.resolve()
  cache.markReady('claude')
  resolve({ claude: { ...ready, authenticated: false } })
  await pending
  assert.equal(cache.getSnapshot().statuses.claude.authenticated, true)
  cache.invalidate('claude')
  let calls = 0
  const restarted = createProviderReadiness(saved, async provider => { calls++; return { [provider]: { ...ready, authenticated: false } } })
  await restarted.ensure('claude')
  await restarted.ensure('claude')
  assert.equal(calls, 1)
  await restarted.ensure('claude', true)
  assert.equal(calls, 2)
})

test('slow unused provider cannot delay another provider; storage and IPC errors remain retryable', async () => {
  const cache = createProviderReadiness({ getItem() { throw Error('denied') }, setItem() { throw Error('denied') } },
    async provider => provider === 'antigravity' ? new Promise(() => {}) : { [provider]: ready })
  void cache.ensure('antigravity')
  await cache.ensure('codex')
  assert.equal(cache.getSnapshot().statuses.codex.authenticated, true)
  assert.equal(cache.getSnapshot().checking.antigravity, true)
  const failed = createProviderReadiness(storage(), async () => { throw Error('IPC disconnected') })
  await failed.ensure('claude')
  assert.equal(failed.getSnapshot().checking.claude, false)
  assert.equal(failed.getSnapshot().statuses.claude.available, null)
})

test('single-provider IPC runs only the requested CLI, including skipping Antigravity discovery', async () => {
  const runtime = source('scripts/apply-session-provider-runtime.mjs')
  const start = runtime.indexOf('const ZERO3_PROVIDER_PROBE_DEADLINE_MS')
  const end = runtime.indexOf("ipcMain.handle('zero3:session-providers:status'", start)
  const calls = []
  const api = evaluate(runtime.slice(start, end) + '\nexport { zero3SessionProviderStatus };', {
    zero3ProbeCodexCli: async () => { calls.push('codex'); return ready },
    zero3ClaudeTaskAdapter: { availability: async () => { calls.push('claude'); return ready } },
    zero3Antigravity: { status() { throw Error('unselected provider must not run') } },
    zero3ListApiProfiles: async () => { throw Error('profiles must not run') },
    zero3SandboxRestriction: () => null, process: { env: {} }
  })
  const result = await api.zero3SessionProviderStatus('codex')
  assert.deepEqual(calls, ['codex'])
  assert.deepEqual(Object.keys(result), ['codex'])
})

test('picker reopens instantly, ordinary focus/card clicks reuse readiness, manual retry and login return refresh only selected provider', async () => {
  const { JSDOM } = desktopRequire('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const before = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const React = desktopRequire('react')
  const { render, fireEvent, cleanup, act } = desktopRequire('@testing-library/react')
  const calls = []
  let authenticated = true
  const cache = createProviderReadiness(storage(), async provider => { calls.push(provider); return { [provider]: { ...ready, authenticated } } })
  dom.window.zero3SessionProviders = { listZero3Profiles: async () => [], authorize: async () => ({ opened: true, detail: 'login opened' }) }
  const { SessionProviderPickerDialog } = evaluate(source('ui-v2/conversations/SessionProviderPickerDialog.tsx'), { window: dom.window }, {
    react: React, 'react/jsx-runtime': desktopRequire('react/jsx-runtime'), '@/components/ui/codicon': { Codicon: () => null }, './provider-readiness': { providerReadiness: cache }
  })
  const props = { project: { id: 'p', name: 'Project' }, onCancel() {}, onCreate() {} }
  try {
    let view
    await act(async () => { view = render(React.createElement(SessionProviderPickerDialog, props)) })
    assert.equal(calls.length, 0)
    await act(async () => fireEvent.click(view.getByRole('button', { name: /本地 Codex.*选择后检测/ })))
    assert.deepEqual(calls, ['codex'])
    view.unmount()
    await act(async () => { view = render(React.createElement(SessionProviderPickerDialog, props)) })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: /本地 Codex.*已就绪/ }))
      dom.window.dispatchEvent(new dom.window.Event('focus'))
    })
    assert.equal(view.getByRole('button', { name: '创建 本地 Codex 会话' }).disabled, false)
    assert.deepEqual(calls, ['codex'])
    authenticated = false
    await act(async () => fireEvent.click(view.getByRole('button', { name: '重新检测' })))
    assert.equal(calls.length, 2)
    await act(async () => fireEvent.click(view.getByRole('button', { name: '打开官方 CLI 授权' })))
    authenticated = true
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')))
    assert.equal(calls.length, 3)
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')))
    assert.equal(calls.length, 3)
    assert.equal(view.getByRole('button', { name: '创建 本地 Codex 会话' }).disabled, false)
  } finally { cleanup(); dom.window.close(); Object.assign(globalThis, before) }
})

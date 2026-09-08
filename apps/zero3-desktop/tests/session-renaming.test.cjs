const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.resolve(root, '../..', 'upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')

// The source templates are deployed under electron/zero3/{gpt-web,workspace}.
// Load those same files in memory, mapping only that deployment path and Electron.
function load(relative, overrides = {}, globals = {}) {
  const filename = path.join(root, relative)
  const source = fs.readFileSync(filename, 'utf8')
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true, fileName: filename })
  assert.equal(result.diagnostics?.length ?? 0, 0, relative)
  const exports = {}
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name]
    if (name.startsWith('../workspace/')) return load('workspace-runtime/' + name.split('/').at(-1) + '.ts', overrides, globals)
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name + '.ts')), overrides, globals)
    return require(name)
  }
  vm.runInNewContext(result.outputText, { exports, require: localRequire, URL, Error, console, process, setTimeout, clearTimeout, setInterval, clearInterval, ...globals }, { filename })
  return exports
}
const names = load('gpt-web-runtime/chatgpt-conversation-name.ts')
const url = 'https://chatgpt.com/g/g-p-project/c/conversation-123'
const { webSessionTitle } = load('ui-v2/adapters/web-session-title.ts')
const { resolveCreateProjectId } = load('ui-v2/conversations/session-create-target.ts')
const base = { kind: 'gpt_web', localDisplayTitle: null, pageTitle: '项目 - 标题 - 第二部分', currentUrl: url, conversationUrl: url }

test('all-session creation resolves the selected session or project context before falling back to unassigned', () => {
  const session = { projectId: 'p1' }
  assert.equal(resolveCreateProjectId(null, null, session), 'p1')
  assert.equal(resolveCreateProjectId(null, 'p2', session), 'p2')
  assert.equal(resolveCreateProjectId('p3', 'p2', session), 'p3')
  assert.equal(resolveCreateProjectId(null, null, { projectId: null }), null)
})

test('project prefix removed, rest of title and explicit user names preserved', () => {
  assert.equal(webSessionTitle(base), '标题 - 第二部分')
  assert.equal(webSessionTitle({ ...base, localDisplayTitle: '项目 - 手动名称' }), '项目 - 手动名称')
  assert.equal(webSessionTitle({ ...base, kind: 'gemini_web' }), base.pageTitle)
  assert.equal(webSessionTitle({ ...base, conversationUrl: 'https://chatgpt.com/c/id' }), base.pageTitle)
})

test('rejects unsupported origins, unsaved chats and invalid names before any page execution', () => {
  for (const invalid of ['https://evil.test/c/id', 'http://chatgpt.com/c/id', 'https://user@chatgpt.com/c/id', 'https://chatgpt.com/g/g-p-project/project']) {
    assert.throws(() => names.chatGptRenameScript(invalid, 'title'))
  }
  assert.throws(() => names.chatGptRenameScript(url, '   '))
  assert.throws(() => names.chatGptRenameScript(url, 'a'.repeat(201)))
})

function webpage({ failPatch = false, mismatch = false, signedOut = false } = {}) {
  const calls = []
  let stored = 'before'
  return {
    calls,
    contents: { executeJavaScript: script => vm.runInNewContext(script, {
      location: { origin: 'https://chatgpt.com' }, AbortController, setTimeout, clearTimeout,
      fetch: async (endpoint, options) => {
        calls.push({ endpoint, method: options.method ?? 'GET' })
        if (endpoint === '/api/auth/session') return { ok: true, json: async () => signedOut ? {} : { accessToken: 'test-token' } }
        if (options.method === 'PATCH') {
          if (failPatch) return { ok: false, status: 403 }
          stored = JSON.parse(options.body).title
          return { ok: true }
        }
        return { ok: true, json: async () => ({ title: mismatch ? 'other' : stored }) }
      }
    }) }
  }
}

test('remote write is read back and special characters stay data', async () => {
  const page = webpage()
  const title = '新名称 " \\ ${notCode} - 标题'
  await names.renameChatGptConversation(page.contents, url, title)
  assert.deepEqual(page.calls.map(c => c.method), ['GET', 'PATCH', 'GET'])
  assert.equal(page.calls[1].endpoint, '/backend-api/conversation/conversation-123')
})

for (const scenario of ['failPatch', 'mismatch', 'signedOut']) {
  test('does not report remote success: ' + scenario, async () => {
    const page = webpage({ [scenario]: true })
    await assert.rejects(names.renameChatGptConversation(page.contents, url, '新名称'))
    if (scenario === 'signedOut') assert.equal(page.calls.length, 1)
  })
}

test('manual local name survives later messages and storage reload', () => {
  const storage = new Map()
  const window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} }
  const globals = { window, crypto: require('node:crypto').webcrypto, CustomEvent: class {} }
  const first = load('ui-v2/adapters/LocalSessionAdapter.ts', {}, globals).LocalSessionAdapter
  const record = first.create('codex', null)
  first.rename(record.id, '手动名称')
  const reopened = load('ui-v2/adapters/LocalSessionAdapter.ts', {}, globals).LocalSessionAdapter
  reopened.appendMessage(record.id, 'user', '这条消息不应覆盖名称')
  assert.equal(reopened.get(record.id).title, '手动名称')
  const before = JSON.stringify(reopened.list())
  assert.throws(() => reopened.rename(record.id, '  '))
  assert.equal(JSON.stringify(reopened.list()), before)
})

test('provider persists only after remote verification; failure preserves disk and later rename can retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-rename-'))
  const file = path.join(dir, 'entries.json')
  const Store = load('workspace-runtime/workspace-entry-store.ts').Zero3WorkspaceEntryStore
  const store = new Store(file)
  const entry = await store.createGptWeb()
  await store.updateGptWebNavigation({ id: entry.id, currentUrl: url, conversationUrl: url, pageTitle: '项目 - 原名称' })
  let page = webpage({ failPatch: true })
  const events = []
  const Provider = load('gpt-web-runtime/gpt-web-provider.ts', {
    electron: { session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) } },
    './chatgpt-project-catalog': { withChatGptContents: (_profile, _reusable, operation) => operation(page.contents) }
  }).Zero3GptWebProvider
  const provider = new Provider(store, {}, event => events.push(event))
  try {
    const before = fs.readFileSync(file, 'utf8')
    await assert.rejects(provider.rename(entry.id, '修改后'))
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.equal(events.length, 0)
    page = webpage()
    await provider.rename(entry.id, '修改后')
    assert.equal((await new Store(file).get(entry.id)).localDisplayTitle, '修改后')
    assert.equal(events[0].entryId, entry.id)
    assert.deepEqual(page.calls.map(c => c.method), ['GET', 'PATCH', 'GET'])
  } finally {
    provider.stop()
    fs.rmSync(file, { force: true })
    fs.rmdirSync(dir)
  }
})


test('context menu offers rename; dialog preserves draft on failure and blocks duplicate saves', async () => {
  const { JSDOM } = desktopRequire('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const before = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const React = desktopRequire('react')
  const { render, fireEvent, cleanup, act } = desktopRequire('@testing-library/react')
  const overrides = {
    react: React,
    'react/jsx-runtime': desktopRequire('react/jsx-runtime'),
    '@/components/ui/codicon': { Codicon: () => null },
    '@/lib/utils': { cn: (...args) => args.filter(Boolean).join(' ') }
  }
  const globals = { window: dom.window, document: dom.window.document }
  const { UnifiedSessionList } = load('ui-v2/conversations/UnifiedSessionList.tsx', overrides, globals)
  const { RenameSessionDialog } = load('ui-v2/conversations/RenameSessionDialog.tsx', overrides, globals)
  const session = { id: 'test', provider: 'gpt', source: 'web', title: '会话标题', subtitle: '', updatedAt: '', projectId: null }
  let selected = null
  try {
    const list = render(React.createElement(UnifiedSessionList, { sessions: [session], projects: [], activeId: null, activeProjectId: null, focusedProjectId: null, error: null, onSelect() {}, onSelectProjectContext() {}, onCreate() {}, onDelete() {}, onRename: value => { selected = value } }))
    fireEvent.contextMenu(list.getByRole('button', { name: /会话标题/ }), { clientX: 100, clientY: 100 })
    assert.ok(list.getByRole('menu').className.includes('bg-(--ui-bg-elevated)'))
    fireEvent.click(list.getByRole('menuitem', { name: '修改名称' }))
    assert.equal(selected.id, session.id)
    assert.equal(list.queryByRole('menu'), null)
    list.unmount()
    let rejectSave
    let calls = 0
    const dialog = render(React.createElement(RenameSessionDialog, { session, onCancel() {}, onSave: () => { calls++; return new Promise((_resolve, reject) => { rejectSave = reject }) } }))
    const input = dialog.getByRole('textbox', { name: '会话名称' })
    assert.equal(input.value, session.title)
    fireEvent.change(input, { target: { value: '   ' } })
    assert.equal(dialog.getByRole('button', { name: '保存' }).disabled, true)
    fireEvent.change(input, { target: { value: '修改后的名称' } })
    fireEvent.submit(input.closest('form'))
    fireEvent.submit(input.closest('form'))
    assert.equal(calls, 1)
    await act(async () => rejectSave(new Error('网页保存失败')))
    assert.equal(dialog.getByRole('alert').textContent, '网页保存失败')
    assert.equal(input.value, '修改后的名称')
    assert.equal(dialog.getByRole('button', { name: '保存' }).disabled, false)
  } finally {
    cleanup()
    dom.window.close()
    Object.assign(globalThis, before)
  }
})

test('all-session scope groups conversations by project and project headers collapse independently', () => {
  const { JSDOM } = desktopRequire('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const before = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const React = desktopRequire('react')
  const { render, fireEvent, cleanup } = desktopRequire('@testing-library/react')
  const overrides = {
    react: React,
    'react/jsx-runtime': desktopRequire('react/jsx-runtime'),
    '@/components/ui/codicon': { Codicon: () => null },
    '@/lib/utils': { cn: (...args) => args.filter(Boolean).join(' ') }
  }
  const globals = { window: dom.window, document: dom.window.document }
  const { UnifiedSessionList } = load('ui-v2/conversations/UnifiedSessionList.tsx', overrides, globals)
  const sessions = [
    { id: 's1', provider: 'gpt', source: 'web', title: '项目一会话', subtitle: 'one', updatedAt: '20:10', projectId: 'p1' },
    { id: 's2', provider: 'codex', source: 'local', title: '项目二会话', subtitle: 'two', updatedAt: '20:09', projectId: 'p2' },
    { id: 's3', provider: 'claude', source: 'local', title: '项目一另一个会话', subtitle: 'three', updatedAt: '20:08', projectId: 'p1' }
  ]
  const projects = [{ id: 'p1', name: '项目一' }, { id: 'p2', name: '项目二' }]
  let focusedProjectId = null
  try {
    const list = render(React.createElement(UnifiedSessionList, { sessions, projects, activeId: null, activeProjectId: null, focusedProjectId: null, error: null, onSelect() {}, onSelectProjectContext: value => { focusedProjectId = value }, onCreate() {}, onDelete() {}, onRename() {} }))
    const firstProject = list.getByRole('button', { name: /^项目一\s*2$/ })
    const secondProject = list.getByRole('button', { name: /^项目二\s*1$/ })
    assert.equal(firstProject.getAttribute('aria-expanded'), 'true')
    assert.equal(secondProject.getAttribute('aria-expanded'), 'true')
    assert.ok(list.getByRole('button', { name: /项目一会话/ }))
    assert.ok(list.getByRole('button', { name: /项目一另一个会话/ }))
    assert.ok(list.getByRole('button', { name: /项目二会话/ }))
    fireEvent.click(firstProject)
    assert.equal(focusedProjectId, 'p1')
    assert.equal(firstProject.getAttribute('aria-expanded'), 'false')
    assert.equal(list.queryByRole('button', { name: /项目一会话/ }), null)
    assert.equal(list.queryByRole('button', { name: /项目一另一个会话/ }), null)
    assert.ok(list.getByRole('button', { name: /项目二会话/ }))
  } finally {
    cleanup()
    dom.window.close()
    Object.assign(globalThis, before)
  }
})

test('native web view is fully hidden before a renderer overlay may open', async () => {
  const calls = []
  let releaseGpt
  const gptHidden = new Promise(resolve => { releaseGpt = resolve })
  const window = {
    zero3GptWeb: {
      hide: async request => {
        calls.push(['gpt', request.id])
        await gptHidden
      }
    },
    zero3GeminiWeb: {
      hide: async request => calls.push(['gemini', request.id])
    }
  }
  const { hideNativeWebSession } = load(
    'ui-v2/conversations/native-overlay-visibility.ts',
    {},
    { window }
  )

  let completed = false
  const pending = hideNativeWebSession({ id: 'gpt-1', provider: 'gpt', source: 'web' }).then(() => {
    completed = true
  })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.deepEqual(calls, [['gpt', 'gpt-1']])
  releaseGpt()
  await pending
  assert.equal(completed, true)

  await hideNativeWebSession({ id: 'gemini-1', provider: 'gemini', source: 'web' })
  await hideNativeWebSession({ id: 'local-1', provider: 'codex', source: 'local' })
  assert.deepEqual(calls, [['gpt', 'gpt-1'], ['gemini', 'gemini-1']])
})

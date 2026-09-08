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

function load(relative, overrides = {}, globals = {}) {
  const filename = path.join(root, relative)
  const source = fs.readFileSync(filename, 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
    fileName: filename
  })
  assert.equal(result.diagnostics?.length ?? 0, 0, relative)
  const exports = {}
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name]
    if (name.startsWith('../workspace/')) return load('workspace-runtime/' + name.split('/').at(-1) + '.ts', overrides, globals)
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name + '.ts')), overrides, globals)
    return require(name)
  }
  vm.runInNewContext(result.outputText, {
    exports, require: localRequire, URL, Error, console, process, setTimeout, clearTimeout, setInterval, clearInterval, ...globals
  }, { filename })
  return exports
}

test('workspace and local stores persist archive state without deleting history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-archive-'))
  const file = path.join(dir, 'entries.json')
  const Store = load('workspace-runtime/workspace-entry-store.ts').Zero3WorkspaceEntryStore
  try {
    const store = new Store(file)
    const entry = await store.createGptWeb()
    await store.setArchived({ id: entry.id, archived: true })
    const reopened = new Store(file)
    assert.equal((await reopened.get(entry.id)).archived, true)
    await reopened.setArchived({ id: entry.id, archived: false })
    assert.equal((await reopened.get(entry.id)).archived, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const storage = new Map()
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {}
  }
  const globals = { window, crypto: require('node:crypto').webcrypto, CustomEvent: class {} }
  const Local = load('ui-v2/adapters/LocalSessionAdapter.ts', {}, globals).LocalSessionAdapter
  const local = Local.create('claude', 'p1')
  Local.appendMessage(local.id, 'user', 'keep this message')
  Local.setArchived(local.id, true)
  const archived = Local.get(local.id)
  assert.equal(archived.archived, true)
  assert.equal(archived.messages[0].content, 'keep this message')
  assert.equal(Local.toWorkspaceSession(archived).archived, true)
})

test('ChatGPT archive is written and read back on the signed-in web origin', async () => {
  const names = load('gpt-web-runtime/chatgpt-conversation-name.ts')
  const url = 'https://chatgpt.com/c/archive-test-123'
  for (const archived of [true, false]) {
    const calls = []
    let stored = !archived
    const contents = {
      executeJavaScript: script => vm.runInNewContext(script, {
        location: { origin: 'https://chatgpt.com' }, AbortController, setTimeout, clearTimeout,
        fetch: async (endpoint, options) => {
          const method = options.method ?? 'GET'
          calls.push({ endpoint, method, body: options.body ?? null })
          if (endpoint === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'test-token' }) }
          if (method === 'PATCH') {
            stored = JSON.parse(options.body).is_archived
            return { ok: true }
          }
          return { ok: true, json: async () => ({ is_archived: stored }) }
        }
      })
    }
    await names.setChatGptConversationArchived(contents, url, archived)
    assert.deepEqual(calls.map(call => call.method), ['GET', 'PATCH', 'GET'])
    assert.equal(JSON.parse(calls[1].body).is_archived, archived)
  }
})

test('web adapter routes GPT archive remotely and Gemini archive to workspace metadata', async () => {
  const calls = []
  const window = {
    zero3GptWeb: { setArchived: async request => calls.push(['gpt', request]) },
    zero3GeminiWeb: {},
    zero3Workspace: { setArchived: async request => calls.push(['workspace', request]) }
  }
  const Adapter = load('ui-v2/adapters/WebWorkspaceAdapter.ts', {}, { window }).WebWorkspaceAdapter
  await Adapter.setArchived({ id: 'g1', provider: 'gpt' }, true)
  await Adapter.setArchived({ id: 'm1', provider: 'gemini' }, true)
  assert.equal(JSON.stringify(calls), JSON.stringify([['gpt', { id: 'g1', archived: true }], ['workspace', { id: 'm1', archived: true }]]))
})

test('session list hides archived sessions normally and offers archive and unarchive actions', () => {
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
  const { UnifiedSessionList } = load('ui-v2/conversations/UnifiedSessionList.tsx', overrides, { window: dom.window, document: dom.window.document })
  const sessions = [
    { id: 'live', provider: 'codex', source: 'local', title: 'Live session', subtitle: '', updatedAt: '', projectId: 'p1', archived: false },
    { id: 'old', provider: 'claude', source: 'local', title: 'Archived session', subtitle: '', updatedAt: '', projectId: 'p1', archived: true }
  ]
  const actions = []
  try {
    const view = render(React.createElement(UnifiedSessionList, {
      sessions, projects: [{ id: 'p1', name: 'P1' }], activeId: null, activeProjectId: 'p1', focusedProjectId: 'p1', error: null,
      onSelect() {}, onSelectProjectContext() {}, onCreate() {}, onDelete() {}, onRename() {},
      onArchive: (session, archived) => actions.push([session.id, archived])
    }))
    assert.ok(view.getByRole('button', { name: /Live session/ }))
    assert.equal(view.queryByRole('button', { name: /Archived session/ }), null)
    fireEvent.contextMenu(view.getByRole('button', { name: /Live session/ }), { clientX: 40, clientY: 40 })
    fireEvent.click(view.getByRole('menuitem', { name: '\u5f52\u6863\u4f1a\u8bdd' }))
    assert.deepEqual(actions, [['live', true]])
    fireEvent.click(view.getByRole('button', { name: '\u5f52\u6863' }))
    assert.ok(view.getByRole('button', { name: /Archived session/ }))
    fireEvent.contextMenu(view.getByRole('button', { name: /Archived session/ }), { clientX: 40, clientY: 40 })
    fireEvent.click(view.getByRole('menuitem', { name: '\u53d6\u6d88\u5f52\u6863' }))
    assert.deepEqual(actions, [['live', true], ['old', false]])
  } finally {
    cleanup()
    dom.window.close()
    Object.assign(globalThis, before)
  }
})

test('local provider bridge uses native archive where supported and safe metadata fallback otherwise', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/apply-session-provider-runtime.mjs'), 'utf8')
  assert.ok(source.includes("const action = archived ? 'archive' : 'unarchive'"))
  assert.ok(source.includes("archived ? 'thread/archive' : 'thread/unarchive'"))
  assert.ok(source.includes('Claude Code CLI has no supported session archive API'))
  assert.ok(source.includes('Antigravity currently has no persistent session archive API'))
})

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.resolve(root, '../..', 'upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')
const ACTIVITY_WINDOW_MS = 5 * 60 * 1_000

function load(relative, overrides = {}) {
  const filename = path.join(root, relative)
  const source = fs.readFileSync(filename, 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
    fileName: filename
  })
  assert.equal(result.diagnostics?.length ?? 0, 0, relative)
  const exports = {}
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name]
    if (name.startsWith('../workspace/')) return load('workspace-runtime/' + name.split('/').at(-1) + '.ts', overrides)
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name + '.ts')), overrides)
    return require(name)
  }
  vm.runInNewContext(result.outputText, {
    exports, require: localRequire, URL, Error, console, process,
    setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename })
  return exports
}

function createProvider() {
  const Provider = load('gpt-web-runtime/gpt-web-provider.ts', {
    electron: {
      BrowserWindow: { fromId: () => null },
      WebContentsView: class {},
      session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
      shell: {}
    },
    './chatgpt-project-catalog': { ChatGptSignedOutError: class extends Error {}, readChatGptProjectCatalog: async () => [], withChatGptContents: async () => {} },
    './chatgpt-conversation-name': { chatGptConversationId: () => null, renameChatGptConversation: async () => {} }
  }).Zero3GptWebProvider
  return new Provider({}, {}, () => {})
}

function addLive(provider, id, { lastActivatedAt, lastUsedAt }) {
  provider.live.set(id, {
    entryId: id,
    view: { webContents: { isDestroyed: () => false, close() {} } },
    parentWindowId: null,
    lastUsedAt,
    warmedAt: lastActivatedAt ?? lastUsedAt,
    lastActivatedAt,
    loadState: 'warm',
    chromeHidden: true,
    chromeCssKey: null,
    headerCssKey: null
  })
}

test('hot pool keeps ten stale sessions as a durable LRU base tier', () => {
  const provider = createProvider()
  const now = Date.now()
  try {
    for (let index = 0; index < 12; index += 1) {
      addLive(provider, `stale-${index}`, {
        lastActivatedAt: now - ACTIVITY_WINDOW_MS - 10_000,
        lastUsedAt: now - (12 - index) * 1_000
      })
    }
    provider.maintainHotPool()
    assert.equal(provider.live.size, 10)
    assert.equal(provider.live.has('stale-0'), false)
    assert.equal(provider.live.has('stale-1'), false)
    assert.equal(provider.live.has('stale-2'), true)
    assert.equal(provider.live.has('stale-11'), true)
  } finally {
    provider.stop()
  }
})

test('recent activity expands the hot pool to 30, then contracts back to ten after five minutes', () => {
  const provider = createProvider()
  const now = Date.now()
  try {
    for (let index = 0; index < 35; index += 1) {
      addLive(provider, `recent-${index}`, {
        lastActivatedAt: now,
        lastUsedAt: now + index
      })
    }
    provider.maintainHotPool()
    assert.equal(provider.live.size, 30)

    for (const live of provider.live.values()) {
      live.lastActivatedAt = now - ACTIVITY_WINDOW_MS - 10_000
      live.warmedAt = live.lastActivatedAt
    }
    provider.maintainHotPool()
    assert.equal(provider.live.size, 10)
  } finally {
    provider.stop()
  }
})

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const ts = createRequire(path.resolve(root, '../../upstream/hermes-agent/apps/desktop/package.json'))('typescript')
function load(relative, overrides = {}) {
  const filename = path.join(root, relative)
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  const exports = {}
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name]
    if (name.startsWith('../workspace/')) return load('workspace-runtime/' + name.split('/').at(-1) + '.ts', overrides)
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name + '.ts')), overrides)
    return require(name)
  }
  vm.runInNewContext(result.outputText, { exports, require: localRequire, URL, Error, console,
    process, setTimeout, clearTimeout, setInterval, clearInterval }, { filename })
  return exports
}
const projectId = 'g-p-6a81e7c8a2e88191b9062d90c7b131ce'
const target = `https://chatgpt.com/g/${projectId}/project`
const canonical = `https://chatgpt.com/g/${projectId}-example/project`
test('only project landing pages use the home bootstrap', () => {
  const { chatGptProjectId } = load('gpt-web-runtime/chatgpt-project-navigation.ts', { electron: {} })
  assert.equal(chatGptProjectId(target), projectId)
  assert.equal(chatGptProjectId(canonical), projectId)
  for (const url of ['https://chatgpt.com/', `https://chatgpt.com/g/${projectId}/c/123`, target.replace('https:', 'http:'), target.replace('chatgpt.com', 'evil.test'), target.replace('https://', 'https://user@')]) {
    assert.equal(chatGptProjectId(url), null)
  }
})
test('project recovery loads home, uses catalog canonical path, and verifies composer', async () => {
  const calls = []
  const { loadChatGptProject } = load('gpt-web-runtime/chatgpt-project-navigation.ts', {
    './chatgpt-project-catalog': { readChatGptProjectCatalog: async () => [{ id: projectId, url: canonical }] }
  })
  await loadChatGptProject({ session: {}, loadURL: async url => calls.push(url),
    executeJavaScript: async script => { calls.push(script); return true } }, target)
  assert.equal(calls[0], 'https://chatgpt.com/')
  assert.ok(calls[1].includes(new URL(canonical).pathname))
  assert.match(calls[1], /project-folder-icon/)
  assert.match(calls[2], /prompt-textarea/)
})
test('failed project readiness is surfaced, never reported as success', async () => {
  const { loadChatGptProject } = load('gpt-web-runtime/chatgpt-project-navigation.ts', {
    './chatgpt-project-catalog': { readChatGptProjectCatalog: async () => [{ id: projectId, url: canonical }] }
  })
  let count = 0
  await assert.rejects(loadChatGptProject({ session: {}, loadURL: async () => {},
    executeJavaScript: async () => ++count === 1 }, target), /项目未能显示/)
})
test('network failure remains error after did-stop-loading; a new load can become ready', () => {
  const events = []
  const Provider = load('gpt-web-runtime/gpt-web-provider.ts', { electron: {} }).Zero3GptWebProvider
  const provider = new Provider({}, {}, event => events.push(event))
  const contents = new EventEmitter()
  Object.assign(contents, { getURL: () => 'https://example.test/', isDestroyed: () => false, insertCSS: async () => 'css' })
  const live = { entryId: 'test', view: { webContents: contents }, parentWindowId: 1, loadState: 'warming', chromeHidden: false, headerCssKey: 'css' }
  provider.installViewObservers(live)
  contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', target, true)
  contents.emit('did-stop-loading')
  assert.equal(live.loadState, 'error')
  assert.equal(events.at(-1).state, 'error')
  contents.emit('did-start-loading')
  contents.emit('did-stop-loading')
  assert.equal(events.at(-1).state, 'visible')
  live.projectLoad = Promise.resolve()
  contents.emit('did-start-loading')
  contents.emit('did-stop-loading')
  assert.equal(events.at(-1).state, 'warming')
  provider.stop()
})

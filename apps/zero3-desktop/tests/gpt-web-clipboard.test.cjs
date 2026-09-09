const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.resolve(root, '../../upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')
const filename = path.join(root, 'gpt-web-runtime/gpt-web-provider.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function permissionHandlers() {
  let request, check
  const profile = {
    setPermissionRequestHandler(handler) { request = handler },
    setPermissionCheckHandler(handler) { check = handler }
  }
  const exports = {}
  vm.runInNewContext(compiled, {
    exports, URL, console, setInterval, clearInterval,
    require: name => name === 'electron'
      ? { session: { fromPartition: () => profile } }
      : {}
  }, { filename })
  const provider = new exports.Zero3GptWebProvider({}, {}, () => {})
  try {
    assert.equal(provider.getProfileSession(), profile)
    assert.equal(provider.getProfileSession(), profile)
    return { request, check }
  } finally {
    provider.stop()
  }
}

const contents = (url = 'https://chatgpt.com/c/example', destroyed = false) => ({
  getURL: () => url,
  isDestroyed: () => destroyed
})

function decisions({ permission = 'clipboard-sanitized-write', url = 'https://chatgpt.com/c/example',
  origin = new URL(url).origin, wc = contents(), isMainFrame = true } = {}) {
  const { request, check } = permissionHandlers()
  const results = [check(wc, permission, origin, { requestingUrl: url, isMainFrame })]
  request(wc, permission, allowed => results.push(allowed), { requestingUrl: url, isMainFrame })
  return results
}

test('ChatGPT response/code copy is allowed by both Electron permission handlers', () => {
  assert.deepEqual(decisions(), [true, true])
  assert.deepEqual(decisions({ url: 'https://chatgpt.com/g/project/c/conversation' }), [true, true])
})

test('clipboard reads and unrelated permissions remain denied', () => {
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'notifications', 'geolocation', 'unknown']) {
    assert.deepEqual(decisions({ permission }), [false, false], permission)
  }
})

test('login pages, foreign origins, alternate ports and insecure pages cannot copy', () => {
  for (const url of ['https://auth.openai.com/', 'https://example.com/', 'https://chatgpt.com.example.com/',
    'https://chatgpt.com:444/', 'http://chatgpt.com/']) {
    assert.deepEqual(decisions({ url }), [false, false], url)
    assert.deepEqual(decisions({ wc: contents(url) }), [false, false], `top-level ${url}`)
  }
})

test('subframes, detached contexts and destroyed pages cannot acquire clipboard permission', () => {
  assert.deepEqual(decisions({ isMainFrame: false }), [false, false])
  assert.deepEqual(decisions({ wc: null }), [false, false])
  assert.deepEqual(decisions({ wc: contents('https://chatgpt.com/', true) }), [false, false])
})

test('malformed or missing requesting origins fail closed', () => {
  const { request, check } = permissionHandlers()
  for (const url of ['', 'null', 'not a URL']) {
    assert.equal(check(contents(), 'clipboard-sanitized-write', url, { isMainFrame: true }), false)
    request(contents(), 'clipboard-sanitized-write', allowed => assert.equal(allowed, false), {
      requestingUrl: url, isMainFrame: true
    })
  }
})

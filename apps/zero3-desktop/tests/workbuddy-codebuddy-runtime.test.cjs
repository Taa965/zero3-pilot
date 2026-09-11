const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.resolve(root, '../../upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')

function evaluate(source, globals = {}) {
  const exports = {}
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  vm.runInNewContext(result.outputText, { exports, require, Error, console, setTimeout, clearTimeout, ...globals })
  return exports
}

const source = name => fs.readFileSync(path.join(root, name), 'utf8')
const overlay = source('scripts/apply-session-provider-runtime.mjs')

// The overlay is a source template, so its runtime is exercised the same way the
// provider-readiness suite exercises the status probe: lift the region out of
// the template and run it against stubbed Electron-main globals.
function slice(startMarker, endMarker) {
  const start = overlay.indexOf(startMarker)
  assert.ok(start >= 0, `missing overlay region start: ${startMarker}`)
  const end = overlay.indexOf(endMarker, start)
  assert.ok(end > start, `missing overlay region end: ${endMarker}`)
  return overlay.slice(start, end)
}

const resolutionSource = slice('const ZERO3_CODEBUDDY_ENTRY', 'async function zero3ProbeCodebuddyCli')
const resultSource = slice('function zero3CodebuddyResult', 'async function zero3RunCodebuddyTurn')
const turnSource = slice('async function zero3RunCodebuddyTurn', 'async function zero3SetSessionProviderArchived')
// Values built inside the VM keep its realm, so comparisons go through a host
// array/object rather than deepEqual against a cross-realm prototype.
const sessionRecordSource = slice('function zero3SessionRecord(', 'function zero3SessionText(')
const asHost = value => Array.from(value)

const BUNDLED = path.join('C:', 'Users', 'tester', 'AppData', 'Local', 'Programs', 'WorkBuddyAI',
  'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')

function loadResolution({ env = {}, existing = [], unresolved = true, execPath = 'C:\\Electron\\electron.exe' } = {}) {
  const seen = new Set(existing.map(value => value.toLowerCase()))
  const process = { env, platform: 'win32', execPath }
  const api = evaluate(`${resolutionSource}\nexport { zero3ResolveCodebuddyCli };`, {
    fs: {
      existsSync: candidate => seen.has(String(candidate).toLowerCase()),
      readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    },
    path,
    process,
    resolveWindowsCommand: name => (unresolved ? { command: name, args: [] } : { command: `${name}.exe`, args: [] })
  })
  return api
}

test('the bundled WorkBuddy CLI is driven through Electron as its Node interpreter', () => {
  const api = loadResolution({
    env: { LOCALAPPDATA: path.join('C:', 'Users', 'tester', 'AppData', 'Local'), PATH: '' },
    existing: [BUNDLED]
  })
  const cli = api.zero3ResolveCodebuddyCli()
  // The entry point has no .exe and no extension, so spawning it directly would
  // fail with ENOENT on Windows. Electron runs it as Node instead.
  assert.equal(cli.command, 'C:\\Electron\\electron.exe')
  assert.deepEqual(asHost(cli.args), [BUNDLED])
  assert.equal(cli.env.ELECTRON_RUN_AS_NODE, '1')
  assert.match(cli.source, /内置/)
})

test('an explicit override outranks the bundled install and a real executable needs no interpreter', () => {
  const override = path.join('D:', 'tools', 'codebuddy.exe')
  const api = loadResolution({
    env: { ZERO3_CODEBUDDY_CLI_BIN: override, LOCALAPPDATA: path.join('C:', 'Users', 'tester', 'AppData', 'Local'), PATH: '' },
    existing: [override, BUNDLED]
  })
  const cli = api.zero3ResolveCodebuddyCli()
  assert.equal(cli.command, override)
  assert.deepEqual(asHost(cli.args), [])
  assert.equal(Object.keys(cli.env).length, 0)
})

test('a codebuddy on PATH is preferred over the bundled copy, and an absent CLI fails with a fix', () => {
  const onPath = path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'npm', 'codebuddy.cmd')
  const resolved = loadResolution({
    env: { LOCALAPPDATA: path.join('C:', 'Users', 'tester', 'AppData', 'Local'), PATH: path.dirname(onPath) },
    existing: [onPath, BUNDLED]
  })
  // The npm shim is a batch file, so the CLI cannot be spawned directly either;
  // the resolver still answers with an interpreter rather than a .cmd path.
  assert.equal(resolved.zero3ResolveCodebuddyCli().command, 'C:\\Electron\\electron.exe')

  const missing = loadResolution({ env: { PATH: '' }, existing: [] })
  assert.throws(() => missing.zero3ResolveCodebuddyCli(), /ZERO3_CODEBUDDY_CLI_BIN/)
})

test('both CodeBuddy output shapes yield the assistant text, session id, and error flag', () => {
  const api = evaluate(`${sessionRecordSource}\n${resultSource}\nexport { zero3CodebuddyResult };`, {})
  const arrayShape = JSON.stringify([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 'sess-1' }
  ])
  assert.deepEqual({ ...api.zero3CodebuddyResult(arrayShape) }, { text: 'OK', sessionId: 'sess-1', isError: false })

  const jsonlShape = [
    JSON.stringify({ type: 'assistant', text: 'ignored' }),
    JSON.stringify({ type: 'result', is_error: true, result: 'rate limited', session_id: 'sess-2' })
  ].join('\n')
  assert.deepEqual({ ...api.zero3CodebuddyResult(jsonlShape) }, { text: 'rate limited', sessionId: 'sess-2', isError: true })

  // A turn whose stdout never reaches a result event must not be reported as an
  // empty answer; the caller rejects on null.
  assert.equal(api.zero3CodebuddyResult('codebuddy: command failed'), null)
})

test('the turn runner drives CodeBuddy headlessly with the classifier-backed permission mode', () => {
  // Verified against the shipped CLI: 'dontAsk' denies tool use, so the agent
  // answers that it cannot create a file instead of doing the work, and the turn
  // is wasted. 'auto' is what actually approves work inside the session.
  assert.match(turnSource, /const args = \['-p', '--output-format', 'json', '--permission-mode', 'auto'\]/)
  assert.doesNotMatch(turnSource, /--permission-mode', 'dontAsk'/)
  // Runtime selections must reach the CLI, and a resumed session must reuse the
  // id the previous turn reported.
  assert.match(turnSource, /if \(model\) args\.push\('--model', model\)/)
  assert.match(turnSource, /if \(effort\) args\.push\('--effort', effort\)/)
  assert.match(turnSource, /if \(sessionId\) args\.push\('--resume', sessionId\)/)
  // The prompt travels over stdin, never as an argument.
  assert.match(turnSource, /child\.stdin\.end\(text, 'utf8'\)/)
})

test('every session surface registers WorkBuddy so the provider is reachable end to end', () => {
  const read = relative => source(relative)
  const surfaces = {
    'ui-v2/conversations/session-types.ts': /WorkspaceProvider = [^\n]*'workbuddy'/,
    'ui-v2/conversations/provider-readiness.ts': /CLI_PROVIDERS[^\n]*'workbuddy'/,
    'ui-v2/conversations/SessionProviderPickerDialog.tsx': /id: 'workbuddy', title: 'WorkBuddy AI'/,
    'ui-v2/conversations/UnifiedSessionList.tsx': /workbuddy: \{ symbol: 'W'/,
    'ui-v2/shell/WorkspaceRouter.tsx': /\{ id: 'workbuddy', label: 'WorkBuddy' \}/,
    'ui-v2/conversations/LocalConversationSurface.tsx': /provider === 'workbuddy'\) response = await runWorkbuddyTurn/,
    'ui-v2/adapters/LocalSessionAdapter.ts': /provider !== 'workbuddy'/
  }
  for (const [file, pattern] of Object.entries(surfaces)) {
    assert.match(read(file), pattern, `${file} must register the workbuddy provider`)
  }

  // The main-process half: provider id, IPC channel, preload bridge, probe,
  // turn runner, archive branch and authorization branch.
  assert.match(overlay, /\| 'workbuddy' \| 'zero3'/)
  assert.match(overlay, /'zero3:session-providers:workbuddy-turn'/)
  assert.match(overlay, /workbuddyTurn: request => ipcRenderer\.invoke/)
  assert.match(overlay, /workbuddy: \{\n      available: workbuddyCli\.available/)
  assert.match(overlay, /async function zero3RunCodebuddyTurn/)
  assert.match(overlay, /provider === 'workbuddy'\) \{\n    \/\/ CodeBuddy Code keeps its transcript/)
  assert.match(overlay, /zero3CodebuddyInteractiveCommand/)
})

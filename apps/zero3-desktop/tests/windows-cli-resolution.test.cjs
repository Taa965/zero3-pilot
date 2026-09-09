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

// The module under test only imports node builtins, so the loader stays small.
// `process` is injected rather than inherited: the Windows branch has to be
// exercised on every platform CI runs, not only on Windows.
function load(relative, processStub, overrides = {}) {
  const filename = path.join(root, relative)
  const source = fs.readFileSync(filename, 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
    fileName: filename
  })
  assert.equal(result.diagnostics?.length ?? 0, 0, relative)
  const exports = {}
  const localRequire = name => (Object.hasOwn(overrides, name) ? overrides[name] : require(name))
  vm.runInNewContext(result.outputText, { exports, require: localRequire, process: processStub, console, Error }, { filename })
  return exports
}

// The resolver falls back to `where.exe`, which would otherwise consult this
// machine's real PATH and make every fixture-based assertion depend on what
// happens to be installed. Tests decide what Windows answers.
function whereStub(stdout = '', status = 1) {
  const calls = []
  return {
    calls,
    module: {
      spawnSync(command, args, options) {
        calls.push({ command, args, options })
        return { status, stdout }
      }
    }
  }
}

function resolverFor(pathDirs, platform = 'win32', env = {}, where = whereStub()) {
  const resolve = load('executor-runtime/external/windows-command.ts', {
    platform,
    env: { PATH: pathDirs.join(path.delimiter), ...env }
  }, { 'node:child_process': where.module }).resolveWindowsCommand
  // The module runs in its own realm, so its objects fail deepStrictEqual on
  // prototype identity alone. Rebuild the result in this realm.
  return command => {
    const resolved = resolve(command)
    return { command: resolved.command, args: [...resolved.args] }
  }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-cli-'))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function writeShim(dir, name, lines) {
  fs.writeFileSync(path.join(dir, name), lines.join('\r\n') + '\r\n')
}

function touch(...segments) {
  const file = path.join(...segments)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  return file
}

test('an exe-forwarding shim resolves to the executable it calls', () => {
  const { dir, cleanup } = fixture()
  try {
    const target = touch(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    // The shape npm writes for claude, trailing spaces and %dp0% included.
    writeShim(dir, 'claude.cmd', [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*'
    ])

    assert.deepEqual(resolverFor([dir])('claude'), { command: target, args: [] })
  } finally {
    cleanup()
  }
})

test('a node-forwarding shim resolves to an interpreter plus the script', () => {
  const { dir, cleanup } = fixture()
  try {
    const script = touch(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    const node = touch(dir, 'node.exe')
    // The shape npm writes for codex: a bundled node.exe is named on an earlier
    // line, and the real call is the line ending in %*.
    writeShim(dir, 'codex.cmd', [
      '@ECHO off',
      'SET dp0=%~dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
    ])

    assert.deepEqual(resolverFor([dir])('codex'), { command: node, args: [script] })
  } finally {
    cleanup()
  }
})

test('a path named before the call line is not mistaken for the target', () => {
  const shimDir = fixture()
  const nodeDir = fixture()
  try {
    const script = touch(shimDir.dir, 'node_modules', 'pkg', 'bin', 'tool.js')
    const node = touch(nodeDir.dir, 'node.exe')
    // No node.exe beside the shim, so the one named on the IF EXIST line does
    // not exist and the interpreter has to come off PATH instead.
    writeShim(shimDir.dir, 'tool.cmd', [
      'IF EXIST "%dp0%\\node.exe" SET "_prog=%dp0%\\node.exe"',
      '"%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\tool.js" %*'
    ])

    assert.deepEqual(resolverFor([shimDir.dir, nodeDir.dir])('tool'), { command: node, args: [script] })
  } finally {
    shimDir.cleanup()
    nodeDir.cleanup()
  }
})

test('a real .exe on PATH wins over a shim that would need reading', () => {
  const { dir, cleanup } = fixture()
  try {
    const direct = touch(dir, 'claude.exe')
    writeShim(dir, 'claude.cmd', ['"%dp0%\\elsewhere.exe" %*'])

    assert.deepEqual(resolverFor([dir])('claude'), { command: direct, args: [] })
  } finally {
    cleanup()
  }
})

test('earlier PATH entries win, and later ones still resolve', () => {
  const first = fixture()
  const second = fixture()
  try {
    const winner = touch(first.dir, 'claude.exe')
    const other = touch(second.dir, 'claude.exe')

    assert.deepEqual(resolverFor([first.dir, second.dir])('claude'), { command: winner, args: [] })
    assert.deepEqual(resolverFor([second.dir, first.dir])('claude'), { command: other, args: [] })
  } finally {
    first.cleanup()
    second.cleanup()
  }
})

test('the command is returned unchanged when nothing is resolvable', () => {
  const { dir, cleanup } = fixture()
  try {
    assert.deepEqual(resolverFor([dir])('claude'), { command: 'claude', args: [] })

    // A shim whose target does not exist must not be trusted.
    writeShim(dir, 'claude.cmd', ['"%dp0%\\missing\\claude.exe" %*'])
    assert.deepEqual(resolverFor([dir])('claude'), { command: 'claude', args: [] })

    // A node shim whose script exists but with no interpreter anywhere.
    touch(dir, 'node_modules', 'pkg', 'bin', 'tool.js')
    writeShim(dir, 'tool.cmd', ['"%_prog%" "%dp0%\\node_modules\\pkg\\bin\\tool.js" %*'])
    assert.deepEqual(resolverFor([dir])('tool'), { command: 'tool', args: [] })

    // A shim with no call line at all.
    writeShim(dir, 'claude.cmd', ['@echo off', 'echo nothing here'])
    assert.deepEqual(resolverFor([dir])('claude'), { command: 'claude', args: [] })
  } finally {
    cleanup()
  }
})

test('paths and non-Windows platforms are passed straight through', () => {
  const { dir, cleanup } = fixture()
  try {
    touch(dir, 'claude.exe')

    // An explicit path is the caller's choice; resolution must not second-guess it.
    assert.deepEqual(resolverFor([dir])('C:\\tools\\claude'), { command: 'C:\\tools\\claude', args: [] })
    assert.deepEqual(resolverFor([dir])('./claude'), { command: './claude', args: [] })

    // On POSIX, spawn resolves PATH itself and .cmd shims do not exist.
    assert.deepEqual(resolverFor([dir], 'linux')('claude'), { command: 'claude', args: [] })
  } finally {
    cleanup()
  }
})

test('CLI authorization actually opens a console the user can type into', () => {
  const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')

  // Measured from a real Electron main process, which has no console of its
  // own: spawning cmd.exe directly opened no window and the child exited at
  // once, both with `detached: true` (DETACHED_PROCESS denies it a console) and
  // without. Only `start` created one. The button reported success either way,
  // so the login it told the user to complete silently never ran.
  assert.match(runtime, /spawn\(comspec, \['\/d', '\/c', 'start', '', comspec, '\/k', command\]/)
  assert.doesNotMatch(runtime, /detached: true/)

  // The nested-quoting hazard is real but comes from hand-built command lines.
  // Each argv entry stays separate here, so Node quotes them individually.
  assert.doesNotMatch(runtime, /'start "" ' \+|`start "" \$\{/)
})

test('local Codex turns surface progress and allow long-running coding work', () => {
  const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
  const surface = fs.readFileSync(path.join(root, 'ui-v2', 'conversations', 'LocalConversationSurface.tsx'), 'utf8')
  assert.match(runtime, /const ZERO3_LOCAL_AGENT_TIMEOUT_MS = 6000 \* 60_000/)
  assert.match(runtime, /Codex CLI turn timed out after 6000 minutes/)
  assert.match(runtime, /zero3:session-providers:codex-progress/)
  assert.match(runtime, /onCodexProgress/)
  assert.match(surface, /onCodexProgress/)
  assert.match(surface, /requestId/)
  assert.match(surface, /codexProgressLog/)
  assert.match(surface, /slice\(-40\)/)
  assert.match(surface, /scrollIntoView/)
  assert.match(surface, /Codicon name=\"terminal\"/)
})

test('local Codex provider reuses the official CLI home instead of the isolated Agent Kernel home', () => {
  const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
  assert.match(runtime, /function zero3OfficialCodexCliEnv\(\)[\s\S]*delete env\.CODEX_HOME/)
  assert.ok((runtime.match(/env: zero3OfficialCodexCliEnv\(\)/g) || []).length >= 2)
  assert.match(runtime, /provider === 'codex' \? zero3OfficialCodexCliEnv\(\) : process\.env/)
})

test('an npm-installed CLI still resolves when the inherited PATH does not list it', () => {
  // Nothing guarantees the app inherits the PATH a fresh shell has. Checking
  // the installer locations directly keeps detection working when it does not.
  const { dir, cleanup } = fixture()
  try {
    const roaming = path.join(dir, 'Roaming')
    const npmDir = path.join(roaming, 'npm')
    fs.mkdirSync(npmDir, { recursive: true })
    const exe = touch(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    writeShim(npmDir, 'claude.cmd', ['@ECHO off', '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*'])

    const missingFromPath = resolverFor([path.join(dir, 'unrelated')], 'win32', { APPDATA: roaming })
    assert.deepStrictEqual(missingFromPath('claude'), { command: exe, args: [] })

    // Nothing on PATH and nothing installed still yields the original command,
    // so the caller keeps its own spawn failure instead of a fabricated path.
    const nothing = resolverFor([path.join(dir, 'unrelated')], 'win32', { APPDATA: path.join(dir, 'empty') })
    assert.deepStrictEqual(nothing('claude'), { command: 'claude', args: [] })
  } finally {
    cleanup()
  }
})

test('a winget-installed CLI resolves from the WinGet Links directory', () => {
  const { dir, cleanup } = fixture()
  try {
    const links = path.join(dir, 'Local', 'Microsoft', 'WinGet', 'Links')
    const exe = touch(links, 'agy.exe')
    const resolve = resolverFor([], 'win32', { LOCALAPPDATA: path.join(dir, 'Local') })
    assert.deepStrictEqual(resolve('agy'), { command: exe, args: [] })
  } finally {
    cleanup()
  }
})

test('a sandboxed launch is named as the cause instead of blaming the CLI', () => {
  // Inside a Codex sandbox the install directories are hidden and the network
  // is off, so every probe fails for reasons that have nothing to do with the
  // CLI. The picker has to say that, or 未安装 is unactionable.
  const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
  assert.match(runtime, /function zero3SandboxRestriction\(\): string \| null/)
  assert.match(runtime, /CODEX_PERMISSION_PROFILE/)
  assert.match(runtime, /CODEX_SANDBOX_NETWORK_DISABLED/)
  assert.match(runtime, /Start-Zero3\.cmd/)
  assert.match(runtime, /const sandbox = zero3SandboxRestriction\(\)/)
})

test('where.exe rescues a lookup that scanning PATH missed', () => {
  // Reading process.env.PATH is a reconstruction of the lookup; where.exe is
  // the lookup. When they disagree - and in the desktop app they have - the
  // one that actually launches the CLI wins.
  const { dir, cleanup } = fixture()
  try {
    const exe = touch(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    writeShim(dir, 'claude.cmd', ['@ECHO off', '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*'])

    // Nothing on the searched PATH, but Windows knows where the shim is.
    const where = whereStub(`${path.join(dir, 'claude.cmd')}\r\n`, 0)
    const resolve = resolverFor([path.join(dir, 'unrelated')], 'win32', { APPDATA: path.join(dir, 'nope') }, where)

    assert.deepStrictEqual(resolve('claude'), { command: exe, args: [] })
    // Rebuild in this realm: the args array was created inside the vm context.
    assert.deepEqual(where.calls.map(call => [call.command, [...call.args]]), [['where.exe', ['claude']]])
  } finally {
    cleanup()
  }
})

test('a where.exe hit is still verified before it is trusted', () => {
  const { dir, cleanup } = fixture()
  try {
    // Windows reports a path that no longer exists, or a shim whose target was
    // uninstalled: neither may be handed back as if it were spawnable.
    const missing = whereStub(`${path.join(dir, 'ghost.exe')}\r\n`, 0)
    assert.deepStrictEqual(resolverFor([dir], 'win32', {}, missing)('ghost'), { command: 'ghost', args: [] })

    writeShim(dir, 'broken.cmd', ['"%dp0%\\missing\\broken.exe" %*'])
    const brokenShim = whereStub(`${path.join(dir, 'broken.cmd')}\r\n`, 0)
    assert.deepStrictEqual(resolverFor([dir], 'win32', {}, brokenShim)('broken'), { command: 'broken', args: [] })
  } finally {
    cleanup()
  }
})

test('a failed where.exe lookup never breaks resolution', () => {
  const { dir, cleanup } = fixture()
  try {
    const throwing = { calls: [], module: { spawnSync() { throw new Error('where.exe is missing') } } }
    assert.deepStrictEqual(resolverFor([dir], 'win32', {}, throwing)('claude'), { command: 'claude', args: [] })
  } finally {
    cleanup()
  }
})

test('the spawn failure says whether the lookup or the launch failed', () => {
  const { dir, cleanup } = fixture()
  try {
    const describe = load('executor-runtime/external/windows-command.ts', {
      platform: 'win32',
      env: { PATH: dir }
    }, { 'node:child_process': whereStub().module }).describeResolution

    assert.match(describe('claude', { command: 'C:\\npm\\claude.exe', args: [] }), /resolved to C:\\npm\\claude\.exe/)
    assert.match(describe('claude', { command: 'claude', args: [] }), /unresolved: \d+ directories searched/)
  } finally {
    cleanup()
  }
})

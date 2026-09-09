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
function load(relative, processStub) {
  const filename = path.join(root, relative)
  const source = fs.readFileSync(filename, 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
    fileName: filename
  })
  assert.equal(result.diagnostics?.length ?? 0, 0, relative)
  const exports = {}
  vm.runInNewContext(result.outputText, { exports, require, process: processStub, console, Error }, { filename })
  return exports
}

function resolverFor(pathDirs, platform = 'win32') {
  const resolve = load('executor-runtime/external/windows-command.ts', {
    platform,
    env: { PATH: pathDirs.join(path.delimiter) }
  }).resolveWindowsCommand
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

test('CLI authorization opens one direct Windows command prompt without nested start quoting', () => {
  const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
  assert.match(runtime, /spawn\(comspec, \['\/d', '\/k', command\]/)
  assert.doesNotMatch(runtime, /start "" cmd\.exe \/k/)
})

test('local Codex turns surface progress and allow long-running coding work', () => {
  const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
  const surface = fs.readFileSync(path.join(root, 'ui-v2', 'conversations', 'LocalConversationSurface.tsx'), 'utf8')
  assert.match(runtime, /const ZERO3_LOCAL_AGENT_TIMEOUT_MS = 60 \* 60_000/)
  assert.match(runtime, /Codex CLI turn timed out after 60 minutes/)
  assert.match(runtime, /zero3:session-providers:codex-progress/)
  assert.match(runtime, /onCodexProgress/)
  assert.match(surface, /onCodexProgress/)
  assert.match(surface, /requestId/)
  assert.match(surface, /codexProgress/)
})

test('local Codex provider reuses the official CLI home instead of the isolated Agent Kernel home', () => {
  const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
  assert.match(runtime, /function zero3OfficialCodexCliEnv\(\)[\s\S]*delete env\.CODEX_HOME/)
  assert.ok((runtime.match(/env: zero3OfficialCodexCliEnv\(\)/g) || []).length >= 2)
  assert.match(runtime, /provider === 'codex' \? zero3OfficialCodexCliEnv\(\) : process\.env/)
})

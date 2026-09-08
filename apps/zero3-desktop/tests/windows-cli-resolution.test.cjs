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
  vm.runInNewContext(
    result.outputText,
    { exports, require, process: processStub, console, Error },
    { filename }
  )
  return exports
}

function resolverFor(pathDirs, platform = 'win32') {
  return load('executor-runtime/external/windows-command.ts', {
    platform,
    env: { PATH: pathDirs.join(path.delimiter) }
  }).resolveWindowsCommand
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-cli-'))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('an npm .cmd shim resolves to the executable it forwards to', () => {
  const { dir, cleanup } = fixture()
  try {
    const binDir = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const target = path.join(binDir, 'claude.exe')
    fs.writeFileSync(target, '')
    // Byte-for-byte the shape npm writes, trailing spaces and %dp0% included.
    fs.writeFileSync(
      path.join(dir, 'claude.cmd'),
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
    )

    assert.equal(resolverFor([dir])('claude'), target)
  } finally {
    cleanup()
  }
})

test('a real .exe on PATH wins over a shim that would need reading', () => {
  const { dir, cleanup } = fixture()
  try {
    const direct = path.join(dir, 'claude.exe')
    fs.writeFileSync(direct, '')
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '"%dp0%\\elsewhere.exe" %*')

    assert.equal(resolverFor([dir])('claude'), direct)
  } finally {
    cleanup()
  }
})

test('earlier PATH entries win, and later ones still resolve', () => {
  const first = fixture()
  const second = fixture()
  try {
    const winner = path.join(first.dir, 'claude.exe')
    fs.writeFileSync(winner, '')
    fs.writeFileSync(path.join(second.dir, 'claude.exe'), '')

    assert.equal(resolverFor([first.dir, second.dir])('claude'), winner)
    assert.equal(resolverFor([second.dir, first.dir])('claude'), path.join(second.dir, 'claude.exe'))
  } finally {
    first.cleanup()
    second.cleanup()
  }
})

test('the command is returned unchanged when nothing is resolvable', () => {
  const { dir, cleanup } = fixture()
  try {
    // Nothing on PATH.
    assert.equal(resolverFor([dir])('claude'), 'claude')

    // A shim whose target does not exist must not be trusted.
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '"%dp0%\\missing\\claude.exe" %*')
    assert.equal(resolverFor([dir])('claude'), 'claude')

    // A shim with no executable reference at all.
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\necho nothing here\r\n')
    assert.equal(resolverFor([dir])('claude'), 'claude')
  } finally {
    cleanup()
  }
})

test('paths and non-Windows platforms are passed straight through', () => {
  const { dir, cleanup } = fixture()
  try {
    fs.writeFileSync(path.join(dir, 'claude.exe'), '')

    // An explicit path is the caller's choice; resolution must not second-guess it.
    assert.equal(resolverFor([dir])('C:\\tools\\claude'), 'C:\\tools\\claude')
    assert.equal(resolverFor([dir])('./claude'), './claude')

    // On POSIX, spawn resolves PATH itself and .cmd shims do not exist.
    assert.equal(resolverFor([dir], 'linux')('claude'), 'claude')
  } finally {
    cleanup()
  }
})

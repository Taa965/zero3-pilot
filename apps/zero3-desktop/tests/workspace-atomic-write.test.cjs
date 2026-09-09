const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.resolve(root, '../..', 'upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')

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
  const localRequire = name => (Object.hasOwn(overrides, name) ? overrides[name] : require(name))
  vm.runInNewContext(result.outputText, {
    exports, require: localRequire, URL, Error, console, process,
    setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename })
  return exports
}

// The real helper waits up to ~1.3s across its retry ladder. Tests replace the
// filesystem module wholesale, so the delays are the only real-time cost; keep
// them by shortening nothing and instead limiting how many retries are needed.
function createFsDouble({ renameOutcomes = [], directoryEntries = [], statsByFile = {} } = {}) {
  const calls = { rename: [], writeFile: [], rm: [], mkdir: [], readdir: 0, open: [], order: [] }
  const outcomes = [...renameOutcomes]
  const fsDouble = {
    async mkdir(directory, options) { calls.mkdir.push({ directory, options }) },
    async writeFile(file, text, options) { calls.writeFile.push({ file, text, options }) },
    async open(file, flags, mode) {
      calls.open.push({ file, flags, mode })
      calls.order.push('open')
      return {
        async writeFile(text, encoding) {
          calls.writeFile.push({ file, text, options: { encoding, mode } })
          calls.order.push('write')
        },
        async sync() { calls.order.push('sync') },
        async close() { calls.order.push('close') }
      }
    },
    async rename(from, to) {
      calls.order.push('rename')
      calls.rename.push({ from, to })
      const outcome = outcomes.shift()
      if (outcome) {
        const error = new Error(`rename failed with ${outcome}`)
        error.code = outcome
        throw error
      }
    },
    async rm(file, options) { calls.rm.push({ file, options }) },
    async readdir() { calls.readdir += 1; return [...directoryEntries] },
    async stat(file) {
      const stats = statsByFile[path.basename(file)]
      if (!stats) {
        const error = new Error(`missing ${file}`)
        error.code = 'ENOENT'
        throw error
      }
      return { isFile: () => stats.isFile !== false, mtimeMs: stats.mtimeMs }
    }
  }
  return { fsDouble, calls }
}

function loadAtomicFile(options) {
  const { fsDouble, calls } = createFsDouble(options)
  const { zero3AtomicWriteFile } = load('workspace-runtime/atomic-file.ts', { 'node:fs/promises': fsDouble })
  return { zero3AtomicWriteFile, calls }
}

const target = path.join('C:', 'data', 'zero3', 'workspace-entries-v1.json')

test('retries a Windows rename that loses the race against another handle', async () => {
  const { zero3AtomicWriteFile, calls } = loadAtomicFile({ renameOutcomes: ['EPERM', 'EBUSY'] })

  await zero3AtomicWriteFile(target, 'state\n')

  assert.equal(calls.rename.length, 3)
  assert.equal(calls.writeFile.length, 1)
  assert.equal(calls.writeFile[0].text, 'state\n')
  // Every attempt must replace the same destination from the same temporary.
  assert.deepEqual(new Set(calls.rename.map(call => call.to)), new Set([target]))
  assert.equal(new Set(calls.rename.map(call => call.from)).size, 1)
  assert.ok(calls.rename[0].from.startsWith(`${target}.tmp-`))
  // A successful rename consumes the temporary, so nothing is left to remove.
  assert.equal(calls.rm.length, 0)
})

test('gives up on a persistent lock and leaves no temporary behind', async () => {
  const outcomes = Array.from({ length: 12 }, () => 'EPERM')
  const { zero3AtomicWriteFile, calls } = loadAtomicFile({ renameOutcomes: outcomes })

  await assert.rejects(zero3AtomicWriteFile(target, 'state\n'), /rename failed with EPERM/)

  assert.equal(calls.rename.length, 8)
  assert.equal(calls.rm.length, 1)
  assert.equal(calls.rm[0].file, calls.rename[0].from)
  assert.equal(calls.rm[0].options.force, true)
})

test('does not retry a failure that is not lock contention', async () => {
  const { zero3AtomicWriteFile, calls } = loadAtomicFile({ renameOutcomes: ['ENOSPC'] })

  await assert.rejects(zero3AtomicWriteFile(target, 'state\n'), /rename failed with ENOSPC/)

  assert.equal(calls.rename.length, 1)
  assert.equal(calls.rm.length, 1)
})

test('sweeps temporaries leaked by an earlier crashed write exactly once', async () => {
  const stale = 'workspace-entries-v1.json.tmp-35824-c2ccbd9d'
  const fresh = 'workspace-entries-v1.json.tmp-41372-8a1f0b22'
  const unrelated = 'projects.json.tmp-35824-11112222'
  const now = Date.now()
  const { zero3AtomicWriteFile, calls } = loadAtomicFile({
    directoryEntries: [stale, fresh, unrelated, 'workspace-entries-v1.json'],
    statsByFile: {
      [stale]: { mtimeMs: now - 2 * 60 * 60 * 1_000 },
      [fresh]: { mtimeMs: now },
      [unrelated]: { mtimeMs: now - 2 * 60 * 60 * 1_000 }
    }
  })

  await zero3AtomicWriteFile(target, 'first\n')
  await zero3AtomicWriteFile(target, 'second\n')

  assert.equal(calls.readdir, 1)
  assert.deepEqual(calls.rm.map(call => path.basename(call.file)), [stale])
})

test('flushes the content to disk before the rename makes it visible', async () => {
  const { zero3AtomicWriteFile, calls } = loadAtomicFile()

  await zero3AtomicWriteFile(target, 'durable\n')

  // An atomic rename only promises the name flips at once; without the flush
  // the bytes behind it can still be lost to a power cut, which is the exact
  // case the crash-recovery stores sharing this helper are written for.
  assert.deepEqual(calls.order, ['open', 'write', 'sync', 'close', 'rename'])
  // Exclusive create: two writers must never land in one temporary sibling.
  assert.equal(calls.open[0].flags, 'wx')
  assert.equal(calls.open[0].mode, 0o600)
})

test('a failed write closes its handle and leaves no temporary behind', async () => {
  const { zero3AtomicWriteFile, calls } = loadAtomicFile({ renameOutcomes: ['ENOSPC'] })

  await assert.rejects(zero3AtomicWriteFile(target, 'doomed\n'), /ENOSPC/)

  assert.ok(calls.order.includes('close'), 'the handle must be closed even when the rename fails')
  assert.deepEqual(calls.rm.map(call => path.basename(call.file)), calls.open.map(call => path.basename(call.file)))
})

test('no TypeScript runtime rebuilds write-then-rename by hand', () => {
  // Every store that persists state now shares the helper above, so the Windows
  // rename retry and the flush apply everywhere instead of at whichever call
  // site happened to remember them. A new store that hand-rolls the pattern
  // silently opts out of both, which is what this guard is for.
  const skipped = new Set(['node_modules', 'tests', 'ui-v2', 'assets'])
  const offenders = []
  let scanned = 0

  const walk = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name)
      if (item.isDirectory()) {
        if (!skipped.has(item.name)) walk(full)
        continue
      }
      if (!item.name.endsWith('.ts') || item.name === 'atomic-file.ts') continue
      scanned += 1
      if (/\.tmp-\$\{process\.pid\}/u.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full))
    }
  }
  walk(root)

  // A guard that silently scans nothing passes forever; hold it to the order of
  // magnitude the runtimes are actually at.
  assert.ok(scanned > 50, `expected to scan the runtime sources, saw ${scanned} files`)
  assert.deepEqual(offenders, [], `use zero3AtomicWriteFile instead of a hand-rolled temporary rename:\n${offenders.join('\n')}`)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createZero3CapabilityRuntime } from './index.ts'
import { EnvironmentZero3CapabilityPolicy } from './policy-port.ts'
import { MAX_READ_BYTES, MAX_WRITE_BYTES } from './filesystem-capabilities.ts'
import type { Zero3OperationRecord, Zero3OperationRuntime } from './index.ts'

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'BLOCKED'])
let sequence = 0

function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-fs-')))
}

function runtimeFor(root: string): Zero3OperationRuntime {
  return createZero3CapabilityRuntime({
    // The operation store lives outside the sandbox root so it never shows up in
    // the listings the tests assert on.
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-ops-')),
    nodeId: 'node-test',
    cwd: root,
    policy: new EnvironmentZero3CapabilityPolicy({
      ZERO3_CAPABILITY_ALLOWED_ROOTS: root,
      ZERO3_CAPABILITY_POLICY_MODE: 'full_control',
      ZERO3_CODEX_CWD: root
    })
  })
}

async function invoke(runtime: Zero3OperationRuntime, capability: string, input: Record<string, unknown>): Promise<Zero3OperationRecord> {
  sequence += 1
  const started = await runtime.invokeCapability({ capability, input, idempotencyKey: `test-${sequence}` })
  const deadline = Date.now() + 5000
  let current = started
  while (!TERMINAL.has(current.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
    current = runtime.getOperation({ operationId: started.operationId })
  }
  return current
}

async function ok(runtime: Zero3OperationRuntime, capability: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const operation = await invoke(runtime, capability, input)
  assert.equal(operation.status, 'COMPLETED', `${capability} failed: ${operation.error?.message ?? ''}`)
  return operation.result as Record<string, unknown>
}

async function fails(runtime: Zero3OperationRuntime, capability: string, input: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const operation = await invoke(runtime, capability, input)
  assert.equal(operation.status, 'FAILED', `${capability} unexpectedly succeeded: ${JSON.stringify(operation.result)}`)
  assert.match(operation.error?.message ?? '', pattern)
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

test('filesystem.list returns sorted entries, honours recursive, depth and entry limits', async () => {
  const root = tempRoot()
  const runtime = runtimeFor(root)
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'a')
  fs.writeFileSync(path.join(root, 'src', 'b.txt'), 'b')
  fs.writeFileSync(path.join(root, 'src', 'deep', 'c.txt'), 'c')

  const flat = await ok(runtime, 'filesystem.list', { path: root })
  assert.deepEqual(flat.entries.map(entry => (entry as { name: string }).name), ['a.txt', 'src'])
  assert.equal(flat.truncated, false)

  const oneLevel = await ok(runtime, 'filesystem.list', { path: root, recursive: true, depth: 1 })
  assert.deepEqual(oneLevel.entries.map(entry => (entry as { name: string }).name), ['a.txt', 'src'])

  const deep = await ok(runtime, 'filesystem.list', { path: root, recursive: true, depth: 3 })
  assert.ok(deep.entries.some(entry => (entry as { name: string }).name === 'c.txt'))

  const limited = await ok(runtime, 'filesystem.list', { path: root, recursive: true, depth: 3, limit: 2 })
  assert.equal((limited.entries as unknown[]).length, 2)
  assert.equal(limited.truncated, true)

  await fails(runtime, 'filesystem.list', { path: path.join(root, 'a.txt') }, /NOT_A_DIRECTORY/)
  await fails(runtime, 'filesystem.list', { path: path.join(root, 'missing') }, /PATH_NOT_FOUND/)
  await fails(runtime, 'filesystem.list', { path: root, limit: 5000 }, /limit must be an integer between/)
})

test('filesystem.stat reports file, directory and missing without leaking ENOENT', async () => {
  const root = tempRoot()
  const runtime = runtimeFor(root)
  fs.writeFileSync(path.join(root, 'file.txt'), 'hello')
  fs.mkdirSync(path.join(root, 'dir'))

  const file = await ok(runtime, 'filesystem.stat', { path: path.join(root, 'file.txt') })
  assert.equal(file.exists, true)
  assert.equal(file.kind, 'file')
  assert.equal(file.sizeBytes, 5)

  const directory = await ok(runtime, 'filesystem.stat', { path: path.join(root, 'dir') })
  assert.equal(directory.kind, 'directory')

  const missing = await ok(runtime, 'filesystem.stat', { path: path.join(root, 'nope.txt') })
  assert.equal(missing.exists, false)
  assert.equal(missing.kind, 'missing')
  assert.equal(missing.sizeBytes, null)
})

test('filesystem.read returns utf8 content with sha256 and refuses oversized or binary files', async () => {
  const root = tempRoot()
  const runtime = runtimeFor(root)
  fs.writeFileSync(path.join(root, 'text.txt'), 'hello world')
  fs.writeFileSync(path.join(root, 'empty.txt'), '')
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(MAX_READ_BYTES + 1))
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))

  const text = await ok(runtime, 'filesystem.read', { path: path.join(root, 'text.txt') })
  assert.equal(text.content, 'hello world')
  assert.equal(text.encoding, 'utf8')
  assert.equal(text.sha256, sha256('hello world'))

  const empty = await ok(runtime, 'filesystem.read', { path: path.join(root, 'empty.txt') })
  assert.equal(empty.content, '')
  assert.equal(empty.sizeBytes, 0)

  // Oversized and binary must fail closed rather than silently truncating or
  // handing the model replacement characters.
  await fails(runtime, 'filesystem.read', { path: path.join(root, 'big.txt') }, /FILE_TOO_LARGE/)
  await fails(runtime, 'filesystem.read', { path: path.join(root, 'binary.bin') }, /UNSUPPORTED_BINARY/)
  await fails(runtime, 'filesystem.read', { path: path.join(root, 'dir-does-not-exist') }, /PATH_NOT_FOUND/)
})

test('filesystem.write creates, overwrites, honours createParents and expectedSha256', async () => {
  const root = tempRoot()
  const runtime = runtimeFor(root)
  const target = path.join(root, 'nested', 'deep', 'file.txt')

  const created = await ok(runtime, 'filesystem.write', { path: target, content: 'first' })
  assert.equal(created.created, true)
  assert.equal(created.sha256, sha256('first'))
  assert.equal(fs.readFileSync(target, 'utf8'), 'first')

  const overwritten = await ok(runtime, 'filesystem.write', { path: target, content: 'second' })
  assert.equal(overwritten.overwritten, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'second')

  // Atomic: the temporary sibling must never survive the write.
  assert.deepEqual(fs.readdirSync(path.dirname(target)).filter(name => name.includes('.tmp-')), [])

  const guarded = await ok(runtime, 'filesystem.write', {
    path: target, content: 'third', expectedSha256: sha256('second')
  })
  assert.equal(guarded.sha256, sha256('third'))

  // Optimistic concurrency: a stale digest must not clobber the newer content.
  await fails(runtime, 'filesystem.write', {
    path: target, content: 'stale', expectedSha256: sha256('second')
  }, /FILE_CHANGED/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'third')

  await fails(runtime, 'filesystem.write', {
    path: path.join(root, 'absent.txt'), content: 'x', expectedSha256: sha256('anything')
  }, /FILE_CHANGED/)

  await fails(runtime, 'filesystem.write', { path: target, content: 'x', overwrite: false }, /FILE_EXISTS/)
  await fails(runtime, 'filesystem.write', {
    path: path.join(root, 'no-parent', 'child.txt'), content: 'x', createParents: false
  }, /PARENT_MISSING/)
  await fails(runtime, 'filesystem.write', { path: target, content: 'x'.repeat(MAX_WRITE_BYTES + 1) }, /FILE_TOO_LARGE/)
  await fails(runtime, 'filesystem.write', { path: target, content: 'x', encoding: 'base64' }, /UNSUPPORTED_ENCODING/)
})

test('filesystem.mkdir, copy, move and delete behave and respect policy boundaries', async () => {
  const root = tempRoot()
  const runtime = runtimeFor(root)

  const made = await ok(runtime, 'filesystem.mkdir', { path: path.join(root, 'a', 'b') })
  assert.equal(made.created, true)
  const again = await ok(runtime, 'filesystem.mkdir', { path: path.join(root, 'a', 'b') })
  assert.equal(again.created, false)

  fs.writeFileSync(path.join(root, 'source.txt'), 'payload')
  const copied = await ok(runtime, 'filesystem.copy', { from: path.join(root, 'source.txt'), to: path.join(root, 'copy.txt') })
  assert.equal(copied.entriesCopied, 1)
  assert.equal(fs.readFileSync(path.join(root, 'copy.txt'), 'utf8'), 'payload')
  await fails(runtime, 'filesystem.copy', { from: path.join(root, 'source.txt'), to: path.join(root, 'copy.txt') }, /FILE_EXISTS/)

  const tree = await ok(runtime, 'filesystem.copy', {
    from: path.join(root, 'a'), to: path.join(root, 'a-copy'), recursive: true
  })
  assert.equal(tree.kind, 'directory')
  await fails(runtime, 'filesystem.copy', { from: path.join(root, 'a'), to: path.join(root, 'a-copy-2') }, /DIRECTORY_COPY_REQUIRES_RECURSIVE/)
  await fails(runtime, 'filesystem.copy', { from: path.join(root, 'a'), to: path.join(root, 'a', 'inner'), recursive: true }, /INVALID_DESTINATION/)

  const moved = await ok(runtime, 'filesystem.move', { from: path.join(root, 'copy.txt'), to: path.join(root, 'moved.txt') })
  assert.equal(moved.kind, 'file')
  assert.equal(fs.existsSync(path.join(root, 'copy.txt')), false)
  assert.equal(fs.existsSync(path.join(root, 'moved.txt')), true)

  await fails(runtime, 'filesystem.delete', { path: path.join(root, 'a') }, /DIRECTORY_NOT_EMPTY/)
  const deleted = await ok(runtime, 'filesystem.delete', { path: path.join(root, 'a'), recursive: true })
  assert.equal(deleted.deleted, true)
  assert.equal(fs.existsSync(path.join(root, 'a')), false)

  // The allow-listed root itself, and a volume root, can never be removed.
  await fails(runtime, 'filesystem.delete', { path: root, recursive: true }, /CANNOT_DELETE_ALLOWED_ROOT/)
  await fails(runtime, 'filesystem.delete', { path: path.parse(root).root, recursive: true }, /PATH_OUTSIDE_ALLOWED_ROOTS|CANNOT_DELETE_VOLUME_ROOT/)
})

test('filesystem capabilities fail closed outside the allowed roots, on traversal and on symlink escape', async () => {
  const root = tempRoot()
  const outside = tempRoot()
  const runtime = runtimeFor(root)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')

  await fails(runtime, 'filesystem.read', { path: path.join(outside, 'secret.txt') }, /PATH_OUTSIDE_ALLOWED_ROOTS/)
  await fails(runtime, 'filesystem.stat', { path: path.join(root, '..', path.basename(outside)) }, /PATH_OUTSIDE_ALLOWED_ROOTS/)
  await fails(runtime, 'filesystem.write', { path: path.join(root, '..', 'escape.txt'), content: 'x' }, /PATH_OUTSIDE_ALLOWED_ROOTS/)
  await fails(runtime, 'filesystem.read', { path: '' }, /PATH_REQUIRED/)
  await fails(runtime, 'filesystem.read', { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }, /PATH_OUTSIDE_ALLOWED_ROOTS|PATH_NOT_FOUND/)

  // A prefix test would accept `root-evil` for the root `root`; path.relative does not.
  const sibling = `${root}-evil`
  fs.mkdirSync(sibling, { recursive: true })
  await fails(runtime, 'filesystem.list', { path: sibling }, /PATH_OUTSIDE_ALLOWED_ROOTS/)

  // Symlink/junction escape: the lexical path is inside the root, the real path is not.
  const link = path.join(root, 'escape-link')
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    return // Creating links needs privileges (or Developer Mode) on Windows.
  }
  await fails(runtime, 'filesystem.read', { path: path.join(link, 'secret.txt') }, /SYMLINK_ESCAPE/)
  const listing = await ok(runtime, 'filesystem.list', { path: root, recursive: true, depth: 3 })
  assert.equal(
    listing.entries.some(entry => (entry as { name: string }).name === 'secret.txt'),
    false,
    'recursive listing must not follow a link out of the root'
  )
})

test('filesystem paths are case-insensitive on Windows', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only behaviour')
    return
  }
  const root = tempRoot()
  const runtime = runtimeFor(root)
  fs.writeFileSync(path.join(root, 'Case.txt'), 'value')
  const read = await ok(runtime, 'filesystem.read', { path: path.join(root.toUpperCase(), 'case.TXT') })
  assert.equal(read.content, 'value')
})

test('policy classifies read, project-write and confirmation capabilities per mode', async () => {
  const root = tempRoot()
  const inside = { path: path.join(root, 'a.txt') }
  const outside = { path: path.join(root, '..', 'elsewhere.txt') }
  const definition = (id: string) => ({
    protocol: 'zero3.remote-capability.v1' as const, id, version: '1.0', name: id, description: id, category: 'filesystem',
    status: 'available' as const, executionMode: 'local' as const, supportsStreaming: false, supportsCancellation: false,
    requiresApproval: 'policy' as const, provider: 'zero3-local' as const, nodeId: 'node-test',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }
  })

  const readOnly = new EnvironmentZero3CapabilityPolicy({ ZERO3_CAPABILITY_ALLOWED_ROOTS: root, ZERO3_CAPABILITY_POLICY_MODE: 'read_only' })
  assert.equal((await readOnly.authorize({ definition: definition('filesystem.read'), input: inside })).decision, 'allow')
  assert.equal((await readOnly.authorize({ definition: definition('git.status'), input: inside })).decision, 'allow')
  assert.equal((await readOnly.authorize({ definition: definition('filesystem.write'), input: inside })).decision, 'deny')
  assert.equal((await readOnly.authorize({ definition: definition('git.push'), input: inside })).decision, 'deny')
  // fetch writes refs, so read_only must not treat it as a read.
  assert.equal((await readOnly.authorize({ definition: definition('git.fetch'), input: inside })).decision, 'deny')

  const project = new EnvironmentZero3CapabilityPolicy({ ZERO3_CAPABILITY_ALLOWED_ROOTS: root, ZERO3_CAPABILITY_POLICY_MODE: 'project_scope' })
  assert.equal((await project.authorize({ definition: definition('filesystem.read'), input: inside })).decision, 'allow')
  assert.equal((await project.authorize({ definition: definition('filesystem.write'), input: inside })).decision, 'allow')
  assert.equal((await project.authorize({ definition: definition('filesystem.mkdir'), input: inside })).decision, 'allow')
  assert.equal((await project.authorize({ definition: definition('filesystem.copy'), input: inside })).decision, 'allow')
  assert.equal((await project.authorize({ definition: definition('filesystem.delete'), input: inside })).decision, 'require_confirmation')
  assert.equal((await project.authorize({ definition: definition('filesystem.move'), input: inside })).decision, 'require_confirmation')
  assert.equal((await project.authorize({ definition: definition('git.commit'), input: inside })).decision, 'require_confirmation')
  assert.equal((await project.authorize({ definition: definition('git.push'), input: inside })).decision, 'require_confirmation')
  assert.equal((await project.authorize({ definition: definition('git.branch'), input: { ...inside, action: 'list' } })).decision, 'allow')
  assert.equal((await project.authorize({ definition: definition('git.branch'), input: { ...inside, action: 'create' } })).decision, 'require_confirmation')
  // Policy is a second containment gate, independent of the handler resolver.
  assert.equal((await project.authorize({ definition: definition('filesystem.read'), input: outside })).decision, 'deny')
  assert.equal((await project.authorize({ definition: definition('filesystem.delete'), input: outside })).decision, 'deny')
  assert.equal((await project.authorize({ definition: definition('git.status'), input: { workspace: root } })).decision, 'allow')

  const full = new EnvironmentZero3CapabilityPolicy({ ZERO3_CAPABILITY_POLICY_MODE: 'full_control' })
  assert.equal((await full.authorize({ definition: definition('filesystem.delete'), input: outside })).decision, 'allow')
})

test('confirmation-gated capabilities stop at WAITING_APPROVAL under project_scope', async () => {
  const root = tempRoot()
  const runtime = createZero3CapabilityRuntime({
    root: path.join(root, '.zero3-runtime'),
    nodeId: 'node-test',
    cwd: root,
    policy: new EnvironmentZero3CapabilityPolicy({
      ZERO3_CAPABILITY_ALLOWED_ROOTS: root,
      ZERO3_CAPABILITY_POLICY_MODE: 'project_scope',
      ZERO3_CODEX_CWD: root
    })
  })
  fs.writeFileSync(path.join(root, 'victim.txt'), 'keep me')
  const operation = await invoke(runtime, 'filesystem.delete', { path: path.join(root, 'victim.txt') })
  assert.equal(operation.status, 'WAITING_APPROVAL')
  assert.equal(fs.existsSync(path.join(root, 'victim.txt')), true, 'a pending approval must not execute the handler')
})

test('filesystem mutations replay on the same idempotency key and conflict on a different one', async () => {
  const root = tempRoot()
  const runtime = runtimeFor(root)
  const request = { capability: 'filesystem.write', input: { path: path.join(root, 'once.txt'), content: 'once' }, idempotencyKey: 'idem-fs-1' }
  const first = await runtime.invokeCapability(request)
  const replay = await runtime.invokeCapability(request)
  assert.equal(replay.operationId, first.operationId)
  await assert.rejects(
    runtime.invokeCapability({ ...request, input: { path: path.join(root, 'other.txt'), content: 'once' } }),
    /different capability input/
  )
})

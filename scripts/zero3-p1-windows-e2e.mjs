import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createZero3CapabilityRuntime } from '../apps/zero3-desktop/capability-runtime/index.ts'
import { EnvironmentZero3CapabilityPolicy } from '../apps/zero3-desktop/capability-runtime/policy-port.ts'

// Windows real-machine acceptance for ZRCP P1.
//
// The unit tests already cover the handlers against temporary directories. This
// harness is the "run it on the actual Windows host, through the real
// Capability Runtime, then clean up" pass: it uses one throwaway sandbox root,
// drives every P1 capability end to end, and never touches the Zero3 Pilot
// repository or its Git state.
//
// Run with: node --experimental-transform-types scripts/zero3-p1-windows-e2e.mjs

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'BLOCKED'])
const EXPECTED_PARENT = path.join(os.homedir(), 'Documents', 'ChatGPT')
const requestedRoot = process.env.ZERO3_P1_E2E_ROOT

// Prefer the operator-visible scratch directory the Windows acceptance pass
// documents, but never fail the whole run because a CI container cannot write
// there: fall back to the platform temporary directory.
function pickSandboxParent() {
  const candidates = [requestedRoot ? path.resolve(requestedRoot) : null, EXPECTED_PARENT, os.tmpdir()].filter(Boolean)
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true })
      fs.accessSync(candidate, fs.constants.W_OK)
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('no writable sandbox parent directory is available for the P1 E2E run')
}

const sandboxParent = pickSandboxParent()
const runRoot = fs.mkdtempSync(path.join(sandboxParent, '.zero3-p1-e2e-'))
const workspace = path.join(runRoot, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

let sequence = 0
const results = []

function record(label, detail) {
  results.push({ label, detail })
  console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`)
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    ...options
  }).trim()
}

function runtimeFor(mode, allowedRoots = [runRoot]) {
  return createZero3CapabilityRuntime({
    root: path.join(runRoot, `operations-${mode}-${results.length}`),
    nodeId: 'zero3-p1-e2e',
    cwd: workspace,
    policy: new EnvironmentZero3CapabilityPolicy({
      ZERO3_CAPABILITY_ALLOWED_ROOTS: allowedRoots.join(';'),
      ZERO3_CAPABILITY_POLICY_MODE: mode,
      ZERO3_CODEX_CWD: workspace
    })
  })
}

async function invoke(runtime, capability, input) {
  sequence += 1
  const started = await runtime.invokeCapability({
    capability,
    input,
    idempotencyKey: `p1-e2e-${sequence}`
  })
  const deadline = Date.now() + 60_000
  let current = started
  while (!TERMINAL.has(current.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
    current = runtime.getOperation({ operationId: started.operationId })
  }
  return current
}

async function ok(runtime, capability, input) {
  const operation = await invoke(runtime, capability, input)
  assert.equal(
    operation.status,
    'COMPLETED',
    `${capability} did not complete: ${operation.status} ${operation.error?.code ?? ''} ${operation.error?.message ?? ''}`
  )
  return operation.result
}

async function fails(runtime, capability, input, pattern) {
  const operation = await invoke(runtime, capability, input)
  assert.equal(operation.status, 'FAILED', `${capability} unexpectedly completed: ${JSON.stringify(operation.result)}`)
  assert.match(operation.error?.message ?? '', pattern, `${capability} failed with the wrong reason`)
  return operation
}

async function filesystemPhase() {
  const runtime = runtimeFor('full_control')
  const directory = path.join(workspace, 'notes')

  const made = await ok(runtime, 'filesystem.mkdir', { path: directory })
  assert.equal(made.created, true)
  record('filesystem.mkdir', directory)

  const written = await ok(runtime, 'filesystem.write', {
    path: path.join(directory, 'draft.txt'),
    content: 'hello zero3\n'
  })
  assert.equal(written.created, true)
  record('filesystem.write', `sha256=${String(written.sha256).slice(0, 12)}…`)

  const stat = await ok(runtime, 'filesystem.stat', { path: path.join(directory, 'draft.txt') })
  assert.equal(stat.exists, true)
  assert.equal(stat.kind, 'file')
  record('filesystem.stat', 'kind=file')

  const read = await ok(runtime, 'filesystem.read', { path: path.join(directory, 'draft.txt') })
  assert.equal(read.content, 'hello zero3\n')
  assert.equal(read.sha256, written.sha256)
  record('filesystem.read', 'utf8 + sha256 round-trip')

  // Optimistic concurrency: the digest from the read has to be accepted, and a
  // stale digest has to fail closed instead of clobbering the file.
  const guarded = await ok(runtime, 'filesystem.write', {
    path: path.join(directory, 'draft.txt'),
    content: 'hello zero3 v2\n',
    expectedSha256: read.sha256
  })
  assert.equal(guarded.overwritten, true)
  const stale = await fails(
    runtime,
    'filesystem.write',
    { path: path.join(directory, 'draft.txt'), content: 'stale\n', expectedSha256: read.sha256 },
    /FILE_CHANGED/
  )
  // Handler refusals keep their named code in the message; the operation-level
  // code stays the generic EXECUTION_FAILED.
  assert.match(String(stale.error?.message), /^FILE_CHANGED:/u)
  assert.equal(fs.readFileSync(path.join(directory, 'draft.txt'), 'utf8'), 'hello zero3 v2\n')
  record('filesystem.write expectedSha256', 'stale write refused with FILE_CHANGED')

  const copied = await ok(runtime, 'filesystem.copy', {
    from: path.join(directory, 'draft.txt'),
    to: path.join(workspace, 'copy.txt')
  })
  assert.equal(copied.kind, 'file')
  record('filesystem.copy', 'file')

  const moved = await ok(runtime, 'filesystem.move', {
    from: path.join(workspace, 'copy.txt'),
    to: path.join(workspace, 'moved.txt')
  })
  assert.equal(moved.kind, 'file')
  assert.equal(fs.existsSync(path.join(workspace, 'copy.txt')), false)
  record('filesystem.move', 'file')

  const listed = await ok(runtime, 'filesystem.list', { path: runRoot, recursive: true, depth: 4 })
  const names = new Set(listed.entries.map(entry => entry.name))
  assert.equal(names.has('moved.txt'), true)
  assert.equal(names.has('draft.txt'), true)
  assert.equal(listed.truncated, false)
  record('filesystem.list', `${listed.count} entries, recursive depth 4`)

  // Containment and symlink escapes must fail closed on the real host.
  await fails(runtime, 'filesystem.read', { path: path.join(runRoot, '..', 'zero3-escape.txt') }, /PATH_OUTSIDE_ALLOWED_ROOTS/)
  record('filesystem path containment', '.. traversal refused')

  const link = path.join(workspace, 'outside-link')
  try {
    fs.symlinkSync(os.tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir')
    await fails(runtime, 'filesystem.stat', { path: path.join(link, 'anything.txt') }, /SYMLINK_ESCAPE/)
    record('filesystem symlink escape', 'junction out of the root refused')
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error
    console.log(`SKIP  filesystem symlink escape (${error.message})`)
  }

  // project_scope keeps destructive work behind local approval rather than
  // letting a remote caller delete anything unattended.
  const scoped = runtimeFor('project_scope')
  const pending = await invoke(scoped, 'filesystem.delete', { path: path.join(directory, 'draft.txt') })
  assert.equal(pending.status, 'WAITING_APPROVAL')
  assert.equal(fs.existsSync(path.join(directory, 'draft.txt')), true)
  record('filesystem.delete policy', 'project_scope stops at WAITING_APPROVAL and deletes nothing')

  const deleted = await ok(runtime, 'filesystem.delete', { path: directory, recursive: true })
  assert.equal(deleted.deleted, true)
  assert.equal(fs.existsSync(directory), false)
  record('filesystem.delete', 'recursive directory')

  await fails(runtime, 'filesystem.delete', { path: runRoot, recursive: true }, /CANNOT_DELETE_ALLOWED_ROOT/)
  record('filesystem.delete root guard', 'allow-listed root refused')
}

async function gitPhase() {
  const runtime = runtimeFor('full_control')
  const repo = path.join(runRoot, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Zero3 P1 E2E'])
  git(repo, ['config', 'user.email', 'p1-e2e@example.test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'core.autocrlf', 'false'])

  await ok(runtime, 'filesystem.write', { path: path.join(repo, 'README.md'), content: '# p1 e2e\n' })
  const status0 = await ok(runtime, 'git.status', { workspace: repo })
  assert.equal(status0.branch, 'main')
  assert.deepEqual(status0.untracked, ['README.md'])
  record('git.status', 'untracked README.md on main')

  const added = await ok(runtime, 'git.add', { workspace: repo, paths: ['README.md'] })
  assert.deepEqual(added.staged, ['README.md'])
  const diff = await ok(runtime, 'git.diff', { workspace: repo, scope: 'staged' })
  assert.match(String(diff.content), /README\.md/u)
  record('git.add + git.diff', 'staged diff is bounded and structured')

  const committed = await ok(runtime, 'git.commit', {
    workspace: repo,
    message: 'feat: initial p1 e2e commit',
    paths: ['README.md']
  })
  assert.match(String(committed.sha), /^[0-9a-f]{40}$/u)
  record('git.commit', String(committed.sha).slice(0, 12))

  const log = await ok(runtime, 'git.log', { workspace: repo, limit: 5 })
  assert.equal(log.commits[0]?.subject, 'feat: initial p1 e2e commit')
  const show = await ok(runtime, 'git.show', { workspace: repo, ref: 'HEAD' })
  assert.match(String(show.content), /initial p1 e2e commit/u)
  record('git.log + git.show', 'bounded history and object view')

  const created = await ok(runtime, 'git.branch', { workspace: repo, action: 'create', name: 'feature/e2e' })
  assert.equal(created.created, true)
  const branches = await ok(runtime, 'git.branch', { workspace: repo, action: 'list' })
  assert.deepEqual(branches.branches.map(branch => branch.name).sort(), ['feature/e2e', 'main'])
  record('git.branch', 'create + list without switching the worktree')

  const bare = path.join(runRoot, 'remote.git')
  git(runRoot, ['init', '--bare', '-b', 'main', bare])
  git(repo, ['remote', 'add', 'origin', bare])
  git(repo, ['config', 'branch.main.remote', 'origin'])
  git(repo, ['config', 'branch.main.merge', 'refs/heads/main'])

  const pushed = await ok(runtime, 'git.push', { workspace: repo, branch: 'main' })
  assert.equal(pushed.force, false)
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), git(repo, ['rev-parse', 'HEAD']))
  record('git.push', 'non-forced push to a local bare remote')

  // A second clone moves the remote forward: the original must then fail closed
  // instead of force-pushing over the other session's work.
  const other = path.join(runRoot, 'other')
  git(runRoot, ['clone', '-b', 'main', bare, other])
  git(other, ['config', 'user.name', 'Other Session'])
  git(other, ['config', 'user.email', 'other@example.test'])
  fs.writeFileSync(path.join(other, 'other.txt'), 'other\n')
  git(other, ['add', '--', 'other.txt'])
  git(other, ['commit', '-m', 'feat: other session'])
  git(other, ['push', 'origin', 'refs/heads/main:refs/heads/main'])

  const fetched = await ok(runtime, 'git.fetch', { workspace: repo })
  assert.equal(fetched.changed, true)
  record('git.fetch', 'new remote commit observed without touching the worktree')

  await ok(runtime, 'filesystem.write', { path: path.join(repo, 'mine.txt'), content: 'mine\n' })
  await ok(runtime, 'git.add', { workspace: repo, paths: ['mine.txt'] })
  await ok(runtime, 'git.commit', { workspace: repo, message: 'feat: mine', paths: ['mine.txt'] })
  const rejected = await fails(runtime, 'git.push', { workspace: repo, branch: 'main' }, /PUSH_REJECTED/)
  assert.match(String(rejected.error?.message), /diverged/u)
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), git(other, ['rev-parse', 'HEAD']))
  record('git.push divergence', 'rejected instead of forced; remote untouched')

  await fails(runtime, 'git.show', { workspace: repo, ref: '--upload-pack=calc' }, /not a safe Git ref/u)
  await fails(runtime, 'git.add', { workspace: repo, paths: ['.'] }, /unsafe path/u)
  record('git argument safety', 'ref injection and repository-wide staging refused')
}

let failure = null
try {
  console.log(`Zero3 P1 Windows E2E sandbox: ${runRoot}`)
  console.log(`Host: ${process.platform} ${os.release()} | Node ${process.version}`)
  await filesystemPhase()
  await gitPhase()
} catch (error) {
  failure = error
} finally {
  // Only ever remove the throwaway directory this harness created itself.
  const resolved = path.resolve(runRoot)
  const insideExpected = resolved.startsWith(`${path.resolve(sandboxParent)}${path.sep}`) && path.basename(resolved).startsWith('.zero3-p1-e2e-')
  if (insideExpected) fs.rmSync(resolved, { recursive: true, force: true })
  else console.log(`WARN  refusing to clean up an unexpected sandbox path: ${resolved}`)
  console.log(`Cleanup: sandbox removed (${insideExpected ? 'yes' : 'no'})`)
}

if (failure) {
  console.error(`\nFAIL  ${failure instanceof Error ? failure.message : String(failure)}`)
  if (failure instanceof Error && failure.stack) console.error(failure.stack)
  process.exit(1)
}

console.log(`\nZero3 P1 Windows E2E passed: ${results.length} checks across filesystem and Git capabilities.`)

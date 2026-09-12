import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createZero3CapabilityRuntime } from './index.ts'
import { EnvironmentZero3CapabilityPolicy } from './policy-port.ts'
import { assertGitPathspecs, assertGitRef, Zero3GitRuntime } from './git-runtime.ts'
import type { Zero3OperationRecord, Zero3OperationRuntime } from './index.ts'

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'BLOCKED'])
let sequence = 0

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
  }).trim()
}

type Fixture = { root: string; repo: string; runtime: Zero3OperationRuntime }

function setup(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-git-')))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Zero3 Test'])
  git(repo, ['config', 'user.email', 'zero3@example.test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n')
  git(repo, ['add', '--', 'README.md'])
  git(repo, ['commit', '-m', 'chore: initial commit'])

  const runtime = createZero3CapabilityRuntime({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-ops-')),
    nodeId: 'node-test',
    cwd: root,
    policy: new EnvironmentZero3CapabilityPolicy({
      ZERO3_CAPABILITY_ALLOWED_ROOTS: root,
      ZERO3_CAPABILITY_POLICY_MODE: 'full_control',
      ZERO3_CODEX_CWD: root
    })
  })
  return { root, repo, runtime }
}

async function invoke(runtime: Zero3OperationRuntime, capability: string, input: Record<string, unknown>): Promise<Zero3OperationRecord> {
  sequence += 1
  const started = await runtime.invokeCapability({ capability, input, idempotencyKey: `git-test-${sequence}` })
  const deadline = Date.now() + 20000
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

test('git.status reports clean, modified, staged and untracked state structurally', async () => {
  const { repo, runtime } = setup()

  const clean = await ok(runtime, 'git.status', { workspace: repo })
  assert.equal(clean.branch, 'main')
  assert.equal(clean.clean, true)
  assert.match(String(clean.head), /^[0-9a-f]{40}$/u)
  assert.deepEqual(clean.staged, [])
  assert.deepEqual(clean.untracked, [])

  fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n')
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n')
  const dirty = await ok(runtime, 'git.status', { workspace: repo })
  assert.equal(dirty.clean, false)
  assert.deepEqual((dirty.unstaged as Array<{ path: string }>).map(item => item.path), ['README.md'])
  assert.deepEqual(dirty.untracked, ['new.txt'])

  git(repo, ['add', '--', 'README.md'])
  const staged = await ok(runtime, 'git.status', { workspace: repo })
  assert.deepEqual((staged.staged as Array<{ path: string }>).map(item => item.path), ['README.md'])
  assert.deepEqual(staged.unstaged, [])

  await fails(runtime, 'git.status', { workspace: path.join(repo, 'nope') }, /PATH_NOT_FOUND/)
})

test('git.diff covers working, staged, path-filtered and commit scope, and truncates instead of flooding', async () => {
  const { repo, runtime } = setup()
  fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n')
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n')
  // other.txt has to be tracked before it can appear in a diff: `git diff`
  // reports tracked content only, which is asserted explicitly below.
  git(repo, ['add', '--', 'other.txt'])
  git(repo, ['commit', '-m', 'chore: track other'])
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other changed\n')

  const working = await ok(runtime, 'git.diff', { workspace: repo, scope: 'working' })
  assert.match(String(working.content), /-# repo/u)
  assert.match(String(working.content), /\+\S*# changed/u)

  const filtered = await ok(runtime, 'git.diff', { workspace: repo, scope: 'working', pathspec: ['other.txt'] })
  assert.match(String(filtered.content), /other\.txt/u)
  assert.doesNotMatch(String(filtered.content), /README\.md/u)

  // An untracked file is git.status material, never diff content.
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n')
  const withUntracked = await ok(runtime, 'git.diff', { workspace: repo, scope: 'working' })
  assert.doesNotMatch(String(withUntracked.content), /untracked\.txt/u)

  git(repo, ['add', '--', 'README.md'])
  const staged = await ok(runtime, 'git.diff', { workspace: repo, scope: 'staged' })
  assert.match(String(staged.content), /README\.md/u)
  assert.doesNotMatch(String(staged.content), /other\.txt/u)

  git(repo, ['commit', '-m', 'docs: change readme'])
  const range = await ok(runtime, 'git.diff', { workspace: repo, scope: 'commit', base: 'HEAD~1' })
  assert.match(String(range.content), /docs: change readme|# changed/u)

  await fails(runtime, 'git.diff', { workspace: repo, scope: 'nonsense' }, /INVALID_INPUT/)
  await fails(runtime, 'git.diff', { workspace: repo, scope: 'commit' }, /INVALID_INPUT/)

  // A diff larger than maxBytes must come back as a bounded stat summary.
  fs.writeFileSync(path.join(repo, 'huge.txt'), 'line\n'.repeat(4000))
  git(repo, ['add', '--', 'huge.txt'])
  const truncated = await ok(runtime, 'git.diff', { workspace: repo, scope: 'staged', maxBytes: 1024 })
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.content, null)
  assert.match(String(truncated.summary), /huge\.txt/u)
})

test('git.log and git.show return bounded structured history', async () => {
  const { repo, runtime } = setup()
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, ['add', '--', 'a.txt'])
  git(repo, ['commit', '-m', 'feat: add a'])

  const log = await ok(runtime, 'git.log', { workspace: repo, limit: 1 })
  const commits = log.commits as Array<Record<string, string>>
  assert.equal(commits.length, 1)
  assert.equal(commits[0]?.subject, 'feat: add a')
  assert.match(commits[0]?.sha ?? '', /^[0-9a-f]{40}$/u)
  assert.match(commits[0]?.shortSha ?? '', /^[0-9a-f]{7,}$/u)
  assert.equal(commits[0]?.author, 'Zero3 Test')

  const all = await ok(runtime, 'git.log', { workspace: repo })
  assert.equal((all.commits as unknown[]).length, 2)

  await fails(runtime, 'git.log', { workspace: repo, limit: 500 }, /limit must be an integer between/)

  const shown = await ok(runtime, 'git.show', { workspace: repo, ref: 'HEAD' })
  assert.match(String(shown.content), /feat: add a/u)

  const scoped = await ok(runtime, 'git.show', { workspace: repo, ref: 'HEAD', path: 'a.txt' })
  assert.match(String(scoped.content), /a\.txt/u)
})

test('git.add stages only the explicitly named paths', async () => {
  const { repo, runtime } = setup()
  fs.writeFileSync(path.join(repo, 'one.txt'), '1\n')
  fs.writeFileSync(path.join(repo, 'two.txt'), '2\n')

  const added = await ok(runtime, 'git.add', { workspace: repo, paths: ['one.txt'] })
  assert.deepEqual(added.requested, ['one.txt'])
  assert.deepEqual(added.staged, ['one.txt'])
  const status = await ok(runtime, 'git.status', { workspace: repo })
  assert.deepEqual(status.untracked, ['two.txt'])

  // Repository-wide staging is not expressible through this capability.
  await fails(runtime, 'git.add', { workspace: repo, paths: ['.'] }, /unsafe path/u)
  await fails(runtime, 'git.add', { workspace: repo, paths: ['-A'] }, /unsafe path/u)
  await fails(runtime, 'git.add', { workspace: repo, paths: ['../outside.txt'] }, /unsafe path/u)
  await fails(runtime, 'git.add', { workspace: repo, paths: [] }, /non-empty array/u)
})

test('git.commit refuses to sweep up staged work it was not told about', async () => {
  const { repo, runtime } = setup()
  fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n')
  fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n')
  git(repo, ['add', '--', 'mine.txt', 'theirs.txt'])

  await fails(runtime, 'git.commit', { workspace: repo, message: 'feat: mine', paths: ['mine.txt'] }, /UNRELATED_STAGED_CHANGES/)

  const committed = await ok(runtime, 'git.commit', { workspace: repo, message: 'feat: mine and theirs', paths: ['mine.txt', 'theirs.txt'] })
  assert.deepEqual(committed.committed, ['mine.txt', 'theirs.txt'])
  assert.equal(committed.branch, 'main')
  assert.match(String(committed.sha), /^[0-9a-f]{40}$/u)

  await fails(runtime, 'git.commit', { workspace: repo, message: 'feat: nothing', paths: ['mine.txt'] }, /NOTHING_STAGED/)
})

test('git.branch lists, reports the current branch and creates a branch', async () => {
  const { repo, runtime } = setup()

  const current = await ok(runtime, 'git.branch', { workspace: repo, action: 'current' })
  assert.equal(current.current, 'main')

  const listed = await ok(runtime, 'git.branch', { workspace: repo, action: 'list' })
  const branches = listed.branches as Array<Record<string, unknown>>
  assert.deepEqual(branches.map(branch => branch.name), ['main'])
  assert.equal(branches[0]?.current, true)

  const created = await ok(runtime, 'git.branch', { workspace: repo, action: 'create', name: 'feature/p1' })
  assert.equal(created.created, true)
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'create must not switch the working tree')

  const relisted = await ok(runtime, 'git.branch', { workspace: repo, action: 'list' })
  assert.deepEqual((relisted.branches as Array<{ name: string }>).map(branch => branch.name).sort(), ['feature/p1', 'main'])

  await fails(runtime, 'git.branch', { workspace: repo, action: 'create', name: '-D main' }, /not a valid Git branch name/u)
  await fails(runtime, 'git.branch', { workspace: repo, action: 'switch', name: 'main' }, /action must be one of/u)
})

test('git.fetch and git.push work against a local bare remote and never force', async () => {
  const { root, repo, runtime } = setup()
  const bare = path.join(root, 'remote.git')
  // `-b main` keeps the fixture independent of the host's init.defaultBranch;
  // without it a Git defaulting to master clones a branch that does not exist
  // and the fixture, not the capability, is what fails.
  git(root, ['init', '--bare', '-b', 'main', bare])
  git(repo, ['remote', 'add', 'origin', bare])
  git(repo, ['config', 'branch.main.remote', 'origin'])
  git(repo, ['config', 'branch.main.merge', 'refs/heads/main'])

  const pushed = await ok(runtime, 'git.push', { workspace: repo, branch: 'main' })
  assert.equal(pushed.pushed, true)
  assert.equal(pushed.force, false, 'the capability must never report a forced push')
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), git(repo, ['rev-parse', 'HEAD']))

  // A second clone advances the remote; the original must then fail closed
  // rather than rewriting history.
  const other = path.join(root, 'other')
  git(root, ['clone', '-b', 'main', bare, other])
  git(other, ['config', 'user.name', 'Other Session'])
  git(other, ['config', 'user.email', 'other@example.test'])
  fs.writeFileSync(path.join(other, 'other.txt'), 'other\n')
  git(other, ['add', '--', 'other.txt'])
  git(other, ['commit', '-m', 'feat: other session'])
  git(other, ['push', 'origin', 'refs/heads/main:refs/heads/main'])

  const fetched = await ok(runtime, 'git.fetch', { workspace: repo })
  assert.equal(fetched.changed, true)
  assert.notEqual(fetched.before, fetched.after)

  fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n')
  git(repo, ['add', '--', 'mine.txt'])
  git(repo, ['commit', '-m', 'feat: mine'])
  await fails(runtime, 'git.push', { workspace: repo, branch: 'main' }, /PUSH_REJECTED/)
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), git(other, ['rev-parse', 'HEAD']), 'the remote must be untouched after a rejected push')
})

test('git capabilities reject argument injection and never build a shell string', async () => {
  const { repo, runtime } = setup()

  await fails(runtime, 'git.show', { workspace: repo, ref: '--upload-pack=touch /tmp/pwned' }, /not a safe Git ref/u)
  await fails(runtime, 'git.show', { workspace: repo, ref: 'HEAD; rm -rf /' }, /not a safe Git ref/u)
  await fails(runtime, 'git.log', { workspace: repo, ref: '$(whoami)' }, /not a safe Git ref/u)
  await fails(runtime, 'git.diff', { workspace: repo, scope: 'commit', base: 'HEAD && calc' }, /not a safe Git ref/u)

  // A file whose name contains shell metacharacters is handled literally.
  const weird = 'weird;name & $HOME.txt'
  fs.writeFileSync(path.join(repo, weird), 'safe\n')
  await ok(runtime, 'git.add', { workspace: repo, paths: [weird] })
  const status = await ok(runtime, 'git.status', { workspace: repo })
  assert.deepEqual((status.staged as Array<{ path: string }>).map(item => item.path), [weird])

  assert.throws(() => assertGitRef('-D', 'ref'), /not a safe Git ref/u)
  assert.throws(() => assertGitPathspecs(['--all'], 'paths'), /unsafe path/u)
})

test('git handles paths with spaces and nested directories', async () => {
  const { repo, runtime } = setup()
  const nested = path.join(repo, 'dir with space')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'file name.txt'), 'spaced\n')

  await ok(runtime, 'git.add', { workspace: repo, paths: ['dir with space/file name.txt'] })
  const status = await ok(runtime, 'git.status', { workspace: repo })
  assert.deepEqual((status.staged as Array<{ path: string }>).map(item => item.path), ['dir with space/file name.txt'])

  const committed = await ok(runtime, 'git.commit', {
    workspace: repo,
    message: 'feat: spaced path',
    paths: ['dir with space']
  })
  assert.deepEqual(committed.committed, ['dir with space/file name.txt'])

  const log = await ok(runtime, 'git.log', { workspace: repo, limit: 1 })
  assert.equal((log.commits as Array<{ subject: string }>)[0]?.subject, 'feat: spaced path')
})

test('git mutation capabilities are idempotent per key and abort with the operation signal', async () => {
  const { repo, runtime } = setup()
  fs.writeFileSync(path.join(repo, 'once.txt'), 'once\n')
  git(repo, ['add', '--', 'once.txt'])

  const request = { capability: 'git.commit', input: { workspace: repo, message: 'feat: once', paths: ['once.txt'] }, idempotencyKey: 'idem-git-1' }
  const first = await runtime.invokeCapability(request)
  const replay = await runtime.invokeCapability(request)
  assert.equal(replay.operationId, first.operationId)
  await assert.rejects(
    runtime.invokeCapability({ ...request, input: { workspace: repo, message: 'feat: other', paths: ['once.txt'] } }),
    /different capability input/u
  )

  // Cancellation is wired straight into the child process: an already-aborted
  // signal must surface as AbortError so the Operation Runtime records CANCELLED.
  const gitRuntime = new Zero3GitRuntime([repo], repo)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(gitRuntime.run(repo, ['status'], { signal: controller.signal }), (error: Error) => error.name === 'AbortError')
})

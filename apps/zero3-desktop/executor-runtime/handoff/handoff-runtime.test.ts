import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildHandoffCheckpoint, captureWorkspaceState } from './handoff-builder.ts'
import { HandoffStore } from './handoff-store.ts'
import { verifyHandoff, HANDOFF_VERIFY_INSTRUCTION } from './handoff-verifier.ts'
import { WorkspaceWriterGate } from './workspace-lease.ts'

type Fixture = { root: string; repo: string; store: HandoffStore }

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zero3-handoff-'))
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Zero3 Test'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'zero3@example.invalid'], { cwd: repo })
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repo })
  return { root, repo, store: new HandoffStore(path.join(root, 'checkpoints')) }
}

async function checkpoint(repo: string) {
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  return buildHandoffCheckpoint({
    taskId: 'task-1', executionId: 'execution-1', workspace: repo, repoId: 'Taa965/fixture', baseSha,
    objective: 'finish feature', constraints: ['no bypass'], acceptanceCriteria: ['tests pass'],
    completed: ['baseline'], inProgress: ['implementation'], remaining: ['acceptance'], testsRun: ['unit'],
    testResults: [{ name: 'unit', status: 'passed' }],
    pendingApprovals: [{ request_id: 'approval-1', description: 'write file', allow_session_approval: false }],
    lastExecutor: 'native-codex', lastSessionId: 'session-1', stopReason: 'quota_exhausted', nextAction: 'continue tests',
    previousGeneration: 1, createdAt: '2026-08-30T00:00:00.000Z'
  })
}

test('clean checkpoint persists, reloads and verifies after restart', async () => {
  const f = await fixture()
  try {
    const cp = await checkpoint(f.repo)
    await f.store.save(cp)
    const restarted = new HandoffStore(path.join(f.root, 'checkpoints'))
    const loaded = await restarted.load('task-1', 'execution-1', 2)
    const state = await captureWorkspaceState(f.repo)
    assert.equal(verifyHandoff(loaded, { workspace: state.workspace, branch: state.branch, headSha: state.headSha, dirtyWorktreeFingerprint: state.dirtyWorktreeFingerprint }).decision, 'HANDOFF_ACCEPT')
    assert.match(HANDOFF_VERIFY_INSTRUCTION, /Do not modify code yet/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('dirty tracked diff and untracked files are captured and hash-bound', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.repo, 'tracked.txt'), 'changed\n')
    await writeFile(path.join(f.repo, 'new.txt'), 'untracked evidence\n')
    const cp = await checkpoint(f.repo)
    assert.match(cp.working_diff, /changed/)
    assert.equal(cp.changed_files.some(file => file.path === 'tracked.txt'), true)
    assert.deepEqual(cp.untracked_files.map(file => file.path), ['new.txt'])
    assert.equal(cp.untracked_files[0].sha256.length, 64)
    await f.store.save(cp)
    assert.equal((await f.store.load('task-1', 'execution-1', 2)).dirty_worktree_fingerprint, cp.dirty_worktree_fingerprint)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('checkpoint hash tampering fails closed on load and verify', async () => {
  const f = await fixture()
  try {
    const cp = await checkpoint(f.repo)
    await f.store.save(cp)
    const target = f.store.checkpointPath('task-1', 'execution-1', 2)
    const parsed = JSON.parse(await readFile(target, 'utf8'))
    parsed.next_action = 'tampered'
    await writeFile(target, JSON.stringify(parsed))
    await assert.rejects(f.store.load('task-1', 'execution-1', 2), /hash mismatch/)
    assert.equal(verifyHandoff(parsed, { workspace: f.repo, branch: 'main', headSha: cp.head_sha, dirtyWorktreeFingerprint: cp.dirty_worktree_fingerprint }).decision, 'HANDOFF_REJECT')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('wrong workspace, branch, HEAD or dirty fingerprint rejects before write', async () => {
  const f = await fixture()
  try {
    const cp = await checkpoint(f.repo)
    for (const observed of [
      { workspace: `${f.repo}-other`, branch: cp.branch, headSha: cp.head_sha, dirtyWorktreeFingerprint: cp.dirty_worktree_fingerprint },
      { workspace: f.repo, branch: 'other', headSha: cp.head_sha, dirtyWorktreeFingerprint: cp.dirty_worktree_fingerprint },
      { workspace: f.repo, branch: cp.branch, headSha: 'deadbeef', dirtyWorktreeFingerprint: cp.dirty_worktree_fingerprint },
      { workspace: f.repo, branch: cp.branch, headSha: cp.head_sha, dirtyWorktreeFingerprint: 'bad' }
    ]) assert.equal(verifyHandoff(cp, observed).decision, 'HANDOFF_REJECT')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('orphaned temporary checkpoint from interrupted persistence does not corrupt durable checkpoint', async () => {
  const f = await fixture()
  try {
    const cp = await checkpoint(f.repo)
    const target = await f.store.save(cp)
    await writeFile(`${target}.tmp-crash`, '{partial')
    const restarted = new HandoffStore(path.join(f.root, 'checkpoints'))
    assert.equal((await restarted.load('task-1', 'execution-1', 2)).checkpoint_hash, cp.checkpoint_hash)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('writer gate prevents duplicate writer and blocks writes while handoff is pending', async () => {
  const f = await fixture()
  try {
    const gate = new WorkspaceWriterGate(f.repo)
    const first = await gate.acquire('task-1', 'execution-1', f.repo, 'native', 1)
    await assert.rejects(gate.acquire('task-1', 'execution-1', f.repo, 'claude', 1), /already has/)
    await gate.assertCanWrite('native', 1)
    const pending = await gate.beginHandoff(first)
    await assert.rejects(gate.assertCanWrite('native', 1), /does not hold/)
    const cp = await checkpoint(f.repo)
    const state = await captureWorkspaceState(f.repo)
    const verification = verifyHandoff(cp, { workspace: state.workspace, branch: state.branch, headSha: state.headSha, dirtyWorktreeFingerprint: state.dirtyWorktreeFingerprint })
    const next = await gate.acceptHandoff(pending, 'claude', verification)
    await gate.assertCanWrite('claude', 2)
    await assert.rejects(gate.assertCanWrite('native', 1), /does not hold/)
    await gate.release(next)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('writer lease survives process restart and identity cannot be stolen', async () => {
  const f = await fixture()
  try {
    const gate = new WorkspaceWriterGate(f.repo)
    const first = await gate.acquire('task-1', 'execution-1', f.repo, 'native', 1)
    const restarted = new WorkspaceWriterGate(f.repo)
    assert.equal((await restarted.current())?.lease_nonce, first.lease_nonce)
    await assert.rejects(restarted.acceptHandoff(first, 'claude', { decision: 'HANDOFF_ACCEPT', reasons: [], task_id: 'task-1', execution_id: 'execution-1', checkpoint_hash: 'a'.repeat(64), generation: 2 }), /pending/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('unverified or rejected handoff cannot obtain write authority', async () => {
  const f = await fixture()
  try {
    const gate = new WorkspaceWriterGate(f.repo)
    const first = await gate.acquire('task-1', 'execution-1', f.repo, 'native', 1)
    const pending = await gate.beginHandoff(first)
    await assert.rejects(gate.acceptHandoff(pending, 'claude', {
      decision: 'HANDOFF_REJECT', reasons: ['HEAD mismatch'], task_id: 'task-1', execution_id: 'execution-1', checkpoint_hash: 'a'.repeat(64), generation: 2
    }), /must accept/)
    await assert.rejects(gate.assertCanWrite('claude', 2), /does not hold/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('handoff generation increments exactly once from previous generation', async () => {
  const f = await fixture()
  try { assert.equal((await checkpoint(f.repo)).handoff_generation, 2) }
  finally { await rm(f.root, { recursive: true, force: true }) }
})

test('changing untracked content after capture invalidates workspace verification', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.repo, 'new.txt'), 'before\n')
    const cp = await checkpoint(f.repo)
    await writeFile(path.join(f.repo, 'new.txt'), 'after\n')
    const state = await captureWorkspaceState(f.repo)
    assert.notEqual(state.dirtyWorktreeFingerprint, cp.dirty_worktree_fingerprint)
    assert.equal(verifyHandoff(cp, { workspace: state.workspace, branch: state.branch, headSha: state.headSha, dirtyWorktreeFingerprint: state.dirtyWorktreeFingerprint }).decision, 'HANDOFF_REJECT')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

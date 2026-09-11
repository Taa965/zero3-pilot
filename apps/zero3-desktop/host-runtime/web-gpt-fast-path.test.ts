import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { dispatchZero3CodexTask, verifyZero3Commit } from './web-gpt-fast-path.ts'
import type { Zero3RemoteHostConfig } from './remote-types.ts'

function config(workspace: string): Zero3RemoteHostConfig {
  return {
    enabled: true,
    workerTunnelEnabled: true,
    skillTunnelEnabled: false,
    baseUrl: 'https://control.invalid',
    tokenFile: path.join(workspace, '.token'),
    nodeId: 'node-1',
    allowedWorkspaces: [workspace],
    developmentAllowHttp: false,
    mappingStateFile: path.join(workspace, '.mapping.json'),
    outboxDir: path.join(workspace, '.outbox')
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('dispatch_codex_task builds deterministic typed tasks and enforces the workspace and permission boundary', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-fast-dispatch-'))
  const calls: any[] = []
  try {
    const control = { async dispatchCodex(value: unknown) { calls.push(value); return { state: 'queued' } } }
    const input = {
      sessionId: 'session-1', workspace, objective: 'Implement approved scoped change', permissionProfile: 'standard',
      maxTurns: 2, timeoutSeconds: 1200, constraints: ['Do not touch unrelated files'],
      acceptanceCriteria: ['Static checks pass'], idempotencyKey: 'dispatch-1'
    }
    const first = await dispatchZero3CodexTask(control, input, { config: config(workspace), projectContext: { project_id: 'zero3-pilot', context_version: 7 } })
    const second = await dispatchZero3CodexTask(control, input, { config: config(workspace), projectContext: { project_id: 'zero3-pilot', context_version: 7 } })
    assert.equal(first.taskId, second.taskId)
    assert.equal(first.executionId, second.executionId)
    assert.equal(calls[0].task.target.workspace, workspace)
    assert.equal(calls[0].task.protocol, 'zero3.pilot.remote-task.v1')
    assert.deepEqual(calls[0].extension.project_context, { project_id: 'zero3-pilot', context_version: 7 })
    await assert.rejects(() => dispatchZero3CodexTask(control, { ...input, permissionProfile: 'full_control' }, { config: config(workspace) }), /not allowed/)
    await assert.rejects(() => dispatchZero3CodexTask(control, { ...input, workspace: path.dirname(workspace) }, { config: config(workspace) }), /not in ZERO3_REMOTE_HOST_WORKSPACES/)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('verify_commit runs fixed checks, commits only task-owned paths, pushes, and replays idempotently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-fast-commit-'))
  const remote = path.join(root, 'remote.git')
  const repo = path.join(root, 'repo')
  try {
    execFileSync('git', ['init', '--bare', remote])
    execFileSync('git', ['init', '-b', 'main', repo])
    git(repo, 'config', 'user.name', 'Zero3 Test')
    git(repo, 'config', 'user.email', 'zero3@example.invalid')
    fs.writeFileSync(path.join(repo, 'owned.txt'), 'base\n')
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'base\n')
    git(repo, 'add', 'owned.txt', 'unrelated.txt')
    git(repo, 'commit', '-m', 'baseline')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')

    fs.writeFileSync(path.join(repo, 'owned.txt'), 'task change\n')
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'parallel change\n')
    const input = {
      sessionId: 'session-1', workspace: repo, paths: ['owned.txt'], checks: ['git_diff_check'],
      commitMessage: 'feat: scoped fast path change', idempotencyKey: 'verify-1'
    }
    const first: any = await verifyZero3Commit(input, { config: config(repo) })
    assert.equal(first.resumed, false)
    assert.deepEqual(first.paths, ['owned.txt'])
    assert.match(git(repo, 'status', '--porcelain'), /unrelated\.txt/)
    assert.doesNotMatch(git(repo, 'status', '--porcelain'), /owned\.txt/)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'refs/heads/main'))

    const replay: any = await verifyZero3Commit(input, { config: config(repo) })
    assert.equal(replay.resumed, true)
    assert.equal(replay.commit, first.commit)

    fs.writeFileSync(path.join(repo, 'owned.txt'), 'new task change\n')
    git(repo, 'add', 'unrelated.txt')
    await assert.rejects(
      () => verifyZero3Commit({ ...input, idempotencyKey: 'verify-2', commitMessage: 'feat: second change' }, { config: config(repo) }),
      /pre-staged changes outside task-owned paths/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

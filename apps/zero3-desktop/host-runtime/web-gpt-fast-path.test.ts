import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { dispatchZero3CodexTask, resolveZero3AgentWorkspace, summarizeZero3AgentFastPathTelemetry, verifyZero3Commit } from './web-gpt-fast-path.ts'
import type { Zero3RemoteHostConfig } from './remote-types.ts'

function config(workspace: string | string[]): Zero3RemoteHostConfig {
  const allowedWorkspaces = Array.isArray(workspace) ? workspace : [workspace]
  return {
    enabled: true,
    workerTunnelEnabled: true,
    skillTunnelEnabled: false,
    baseUrl: 'https://control.invalid',
    tokenFile: path.join(allowedWorkspaces[0], '.token'),
    nodeId: 'node-1',
    allowedWorkspaces,
    developmentAllowHttp: false,
    mappingStateFile: path.join(allowedWorkspaces[0], '.mapping.json'),
    outboxDir: path.join(allowedWorkspaces[0], '.outbox')
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

test('workspace inference uses the unique authoritative project binding and still enforces the allow-list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-fast-workspace-'))
  const one = path.join(root, 'one')
  const two = path.join(root, 'two')
  fs.mkdirSync(one)
  fs.mkdirSync(two)
  try {
    const projects = [
      { id: 'project-one', name: 'zero3-pilot', rootPath: one },
      { id: 'project-two', name: 'other', rootPath: two }
    ]
    const lifecycleContext = { task: { definition: { task: { projectId: 'zero3-pilot' } }, runtime: { sessionBindings: [] } } }
    assert.deepEqual(resolveZero3AgentWorkspace(undefined, {
      config: config([one, two]), sessionId: 'session-1', lifecycleContext, projects, workspaceEntries: []
    }), { workspace: one, source: 'project_binding' })
    assert.throws(() => resolveZero3AgentWorkspace(undefined, {
      config: config(two), sessionId: 'session-1', lifecycleContext, projects, workspaceEntries: []
    }), /not in ZERO3_REMOTE_HOST_WORKSPACES/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('workspace inference supports session binding, explicit override, and fails closed on missing or ambiguous bindings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-fast-binding-'))
  const one = path.join(root, 'one')
  const two = path.join(root, 'two')
  fs.mkdirSync(one)
  fs.mkdirSync(two)
  try {
    const projects = [
      { id: 'project-one', name: 'duplicate', rootPath: one },
      { id: 'project-two', name: 'duplicate', rootPath: two }
    ]
    const conversationUrl = 'https://chatgpt.com/c/session-bound'
    const sessionContext = { task: { definition: { task: { projectId: 'missing' } }, runtime: {
      sessionBindings: [{ logicalSessionId: 'session-1', conversationUrl }]
    } } }
    const workspaceEntries = [{ kind: 'gpt_web', projectId: 'project-two', conversationUrl, currentUrl: conversationUrl }]
    assert.deepEqual(resolveZero3AgentWorkspace(undefined, {
      config: config([one, two]), sessionId: 'session-1', lifecycleContext: sessionContext, projects, workspaceEntries
    }), { workspace: two, source: 'session_binding' })
    const ambiguousContext = { task: { definition: { task: { projectId: 'duplicate' } }, runtime: { sessionBindings: [] } } }
    assert.throws(() => resolveZero3AgentWorkspace(undefined, {
      config: config([one, two]), sessionId: 'session-1', lifecycleContext: ambiguousContext, projects, workspaceEntries: []
    }), /ambiguous/)
    assert.deepEqual(resolveZero3AgentWorkspace(one, {
      config: config([one, two]), sessionId: 'session-1', lifecycleContext: ambiguousContext, projects, workspaceEntries: []
    }), { workspace: one, source: 'explicit' })
    assert.throws(() => resolveZero3AgentWorkspace(undefined, {
      config: config([one, two]), sessionId: 'session-1', lifecycleContext: {}, projects, workspaceEntries: []
    }), /could not be inferred/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('timing telemetry is derived from authoritative ledger fields and keeps unknown values null', () => {
  const record = {
    attempts: [
      { startedAt: new Date(1_200).toISOString(), finishedAt: new Date(1_500).toISOString(), failoverReason: 'retry elsewhere' },
      { startedAt: new Date(1_700).toISOString(), finishedAt: new Date(2_100).toISOString(), failoverReason: null }
    ],
    result: { timing: { queueLatencyMs: 30, executionLatencyMs: 400, verificationLatencyMs: null, totalLatencyMs: 430 } }
  }
  assert.deepEqual(summarizeZero3AgentFastPathTelemetry(record, {
    startedAtMs: 1_000, dispatchStartedAtMs: 1_150, completedAtMs: 2_200
  }), {
    timingMs: { bootstrap: 150, routing: 250, queue: 30, executor: 400, verification: null, total: 1_200 },
    counts: { toolCalls: null, failovers: 1 }
  })
  const unknown = summarizeZero3AgentFastPathTelemetry({ attempts: [], result: {} }, {
    startedAtMs: 10, dispatchStartedAtMs: 20, completedAtMs: 30
  })
  assert.equal(unknown.timingMs.routing, null)
  assert.equal(unknown.timingMs.queue, null)
  assert.equal(unknown.timingMs.executor, null)
  assert.equal(unknown.timingMs.verification, null)
  assert.equal(unknown.counts.toolCalls, null)
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

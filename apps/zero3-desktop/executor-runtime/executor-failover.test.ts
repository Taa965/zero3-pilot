import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { Zero3ExecutorManager } from './executor-manager.ts'
import { Zero3ExecutorRegistry } from './executor-registry.ts'
import { createExecutorFailure } from './failure-normalizer.ts'
import { HandoffStore } from './handoff/handoff-store.ts'
import type {
  ExecutorHandoffCheckpointRef,
  ExecutorInput,
  ExecutorPermissionResponse,
  ExecutorProbe,
  ExecutorSession,
  ExecutorSessionRef,
  ExecutorStartContext,
  Zero3Executor
} from './executor-types.ts'

const run = promisify(execFile)

class FakeExecutor implements Zero3Executor {
  readonly descriptor
  readonly starts: ExecutorStartContext[] = []
  readonly closes: ExecutorSession[] = []

  constructor(
    readonly id: string,
    private readonly probeStatus: ExecutorProbe['status'] = 'ready',
    private readonly closeError?: Error
  ) {
    this.descriptor = { id, kind: 'external-agent' as const, label: id }
  }

  async probe(): Promise<ExecutorProbe> {
    return { executorId: this.id, status: this.probeStatus }
  }

  async start(context: ExecutorStartContext): Promise<ExecutorSession> {
    this.starts.push(context)
    return {
      executorId: this.id,
      sessionId: `${this.id}-session-${context.generation}`,
      generation: context.generation,
      startedAt: '2026-09-08T00:00:00.000Z'
    }
  }

  async resume(_ref: ExecutorSessionRef, _checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession> {
    throw new Error('resume is not used by this test')
  }

  async *prompt(_session: ExecutorSession, _input: ExecutorInput) {}
  async respondPermission(_session: ExecutorSession, _response: ExecutorPermissionResponse): Promise<void> {}
  async cancel(_session: ExecutorSession): Promise<void> {}

  async close(session: ExecutorSession): Promise<void> {
    this.closes.push(session)
    if (this.closeError) throw this.closeError
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd, encoding: 'utf8' })).stdout.trim()
}

async function workspaceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'zero3-failover-'))
  const workspace = path.join(root, 'repo')
  await run('git', ['init', workspace])
  await git(workspace, ['config', 'user.email', 'zero3@example.invalid'])
  await git(workspace, ['config', 'user.name', 'Zero3 Test'])
  await writeFile(path.join(workspace, 'README.md'), 'baseline\n')
  await git(workspace, ['add', 'README.md'])
  await git(workspace, ['commit', '-m', 'baseline'])
  const baseSha = await git(workspace, ['rev-parse', 'HEAD'])
  return { root, workspace, baseSha }
}

function identity(workspace: string, baseSha: string) {
  return {
    taskId: 'task-failover',
    executionId: 'execution-failover',
    workspace,
    repoIdentity: 'repo-failover',
    branch: 'main',
    baseSha,
    objective: 'finish the task',
    constraints: [`baseline=${baseSha}`],
    acceptanceCriteria: ['tests pass']
  }
}

const policy = { permissionProfile: 'standard' as const, approvalRequired: false }

test('quota_exhausted closes the old writer, persists a handoff and starts Claude at generation + 1', async () => {
  const fixture = await workspaceFixture()
  try {
    const native = new FakeExecutor('native-codex')
    const claude = new FakeExecutor('claude')
    const registry = new Zero3ExecutorRegistry()
    registry.register(native)
    registry.register(claude)
    const handoffs = new HandoffStore(path.join(fixture.root, 'handoffs'))
    const manager = new Zero3ExecutorManager(registry, {
      routePlan: { primary: 'native-codex', fallbacks: ['claude'] },
      handoffStore: handoffs
    })
    await manager.start('native-codex', identity(fixture.workspace, fixture.baseSha), policy)

    const result = await manager.failoverAfterFailure(
      'task-failover',
      'execution-failover',
      createExecutorFailure('quota_exhausted', 'quota reached', 'native-codex')
    )

    assert.ok(result)
    assert.equal(result.fromExecutorId, 'native-codex')
    assert.equal(result.toExecutorId, 'claude')
    assert.equal(result.session.generation, 2)
    assert.equal(native.closes.length, 1)
    assert.equal(claude.starts.length, 1)
    assert.equal(claude.starts[0]?.handoff?.generation, 1)
    assert.equal(manager.active('task-failover', 'execution-failover')?.executorId, 'claude')

    const checkpoint = await handoffs.load('task-failover', 'execution-failover', 1)
    assert.equal(checkpoint.last_executor, 'native-codex')
    assert.equal(checkpoint.stop_reason, 'executor_failure:quota_exhausted')
    assert.equal(checkpoint.next_action, 'continue_with:claude')
    assert.equal(checkpoint.checkpoint_hash, result.checkpoint.checkpointHash)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('forbidden failures never switch executors', async () => {
  const fixture = await workspaceFixture()
  try {
    const native = new FakeExecutor('native-codex')
    const claude = new FakeExecutor('claude')
    const registry = new Zero3ExecutorRegistry()
    registry.register(native)
    registry.register(claude)
    const manager = new Zero3ExecutorManager(registry, {
      routePlan: { primary: 'native-codex', fallbacks: ['claude'] },
      handoffStore: new HandoffStore(path.join(fixture.root, 'handoffs'))
    })
    await manager.start('native-codex', identity(fixture.workspace, fixture.baseSha), policy)
    const result = await manager.failoverAfterFailure(
      'task-failover',
      'execution-failover',
      createExecutorFailure('permission_denied', 'denied', 'native-codex')
    )
    assert.equal(result, null)
    assert.equal(native.closes.length, 0)
    assert.equal(claude.starts.length, 0)
    assert.equal(manager.active('task-failover', 'execution-failover')?.executorId, 'native-codex')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('unavailable fallback leaves the current binding intact', async () => {
  const fixture = await workspaceFixture()
  try {
    const native = new FakeExecutor('native-codex')
    const claude = new FakeExecutor('claude', 'auth_required')
    const registry = new Zero3ExecutorRegistry()
    registry.register(native)
    registry.register(claude)
    const manager = new Zero3ExecutorManager(registry, {
      routePlan: { primary: 'native-codex', fallbacks: ['claude'] },
      handoffStore: new HandoffStore(path.join(fixture.root, 'handoffs'))
    })
    await manager.start('native-codex', identity(fixture.workspace, fixture.baseSha), policy)
    const result = await manager.failoverAfterFailure(
      'task-failover',
      'execution-failover',
      createExecutorFailure('quota_exhausted', 'quota reached', 'native-codex')
    )
    assert.equal(result, null)
    assert.equal(native.closes.length, 0)
    assert.equal(claude.starts.length, 0)
    assert.equal(manager.active('task-failover', 'execution-failover')?.executorId, 'native-codex')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('old-writer close failure aborts failover before Claude starts', async () => {
  const fixture = await workspaceFixture()
  try {
    const native = new FakeExecutor('native-codex', 'ready', new Error('cannot prove old writer closed'))
    const claude = new FakeExecutor('claude')
    const registry = new Zero3ExecutorRegistry()
    registry.register(native)
    registry.register(claude)
    const manager = new Zero3ExecutorManager(registry, {
      routePlan: { primary: 'native-codex', fallbacks: ['claude'] },
      handoffStore: new HandoffStore(path.join(fixture.root, 'handoffs'))
    })
    await manager.start('native-codex', identity(fixture.workspace, fixture.baseSha), policy)
    await assert.rejects(
      manager.failoverAfterFailure(
        'task-failover',
        'execution-failover',
        createExecutorFailure('quota_exhausted', 'quota reached', 'native-codex')
      ),
      /cannot prove old writer closed/
    )
    assert.equal(claude.starts.length, 0)
    assert.equal(manager.active('task-failover', 'execution-failover')?.executorId, 'native-codex')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

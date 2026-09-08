import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Zero3ExecutorManager } from '../executor-manager.ts'
import { Zero3ExecutorRegistry } from '../executor-registry.ts'
import { createExecutorFailure } from '../failure-normalizer.ts'
import type {
  ExecutorEvent,
  ExecutorHandoffCheckpointRef,
  ExecutorInput,
  ExecutorPermissionResponse,
  ExecutorProbe,
  ExecutorSession,
  ExecutorSessionRef,
  ExecutorStartContext,
  Zero3Executor
} from '../executor-types.ts'
import { HandoffStore } from '../handoff/handoff-store.ts'
import { WorkspaceWriterGate } from '../handoff/workspace-lease.ts'
import { Zero3FailoverExecutorManager } from './failover-runtime.ts'

type Script = (session: ExecutorSession, input: ExecutorInput) => readonly ExecutorEvent[]
class ScriptedExecutor implements Zero3Executor {
  readonly descriptor
  readonly starts: ExecutorStartContext[] = []
  readonly inputs: ExecutorInput[] = []
  closeCount = 0

  constructor(id: string, kind: 'native-codex' | 'external-agent', private readonly script: Script) {
    this.descriptor = { id, kind, label: id }
  }

  async probe(): Promise<ExecutorProbe> {
    return { executorId: this.descriptor.id, status: 'ready' }
  }

  async start(context: ExecutorStartContext): Promise<ExecutorSession> {
    this.starts.push(context)
    return {
      executorId: this.descriptor.id,
      sessionId: `${this.descriptor.id}-${context.generation}`,
      generation: context.generation,
      startedAt: '2026-09-08T00:00:00.000Z'
    }
  }

  async resume(ref: ExecutorSessionRef, _checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession> {
    return { ...ref, startedAt: '2026-09-08T00:00:00.000Z' }
  }

  async *prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    this.inputs.push(input)
    for (const event of this.script(session, input)) yield event
  }

  async respondPermission(_session: ExecutorSession, _response: ExecutorPermissionResponse): Promise<void> {}
  async cancel(_session: ExecutorSession): Promise<void> {}
  async close(_session: ExecutorSession): Promise<void> { this.closeCount += 1 }
}

async function repoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zero3-failover-runtime-'))
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Zero3 Test'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'zero3@example.invalid'], { cwd: repo })
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repo })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  return { root, repo, sha }
}
function createRuntime(root: string, native: ScriptedExecutor, claude: ScriptedExecutor) {
  const registry = new Zero3ExecutorRegistry()
  registry.register(native)
  registry.register(claude)
  const manager = new Zero3ExecutorManager(registry)
  const handoffRoot = path.join(root, 'handoffs')
  const runtime = new Zero3FailoverExecutorManager(manager, {
    handoffRoot,
    config: {
      candidates: ['native-codex', 'claude'],
      automaticFailover: true,
      maxRetries: 1,
      providerCooldownMs: 30_000,
      circuitFailureThreshold: 2,
      circuitOpenMs: 120_000,
      switchOnAuthRequired: false,
      returnToPrimaryAfterStage: false,
      maxProcessedEvents: 128
    },
    nowMs: () => 1_000,
    nowIso: () => '2026-09-08T00:00:00.000Z'
  })
  return { runtime, manager, handoffRoot }
}

function identity(repo: string, sha: string) {
  return {
    taskId: 'G1:S01',
    executionId: 'E01',
    workspace: repo,
    repoIdentity: 'Taa965/fixture',
    branch: 'main',
    objective: 'finish feature',
    constraints: [`baseline=${sha}`, 'no bypass'],
    acceptanceCriteria: ['tests pass']
  }
}

const policy = { permissionProfile: 'standard' as const, approvalRequired: false }

test('quota exhaustion performs verified native-codex to claude handoff before generation advances', async () => {
  const fixture = await repoFixture()
  try {
    const native = new ScriptedExecutor('native-codex', 'native-codex', () => [
      { type: 'failure', sequence: 1, at: '2026-09-08T00:00:00.000Z', failure: createExecutorFailure('quota_exhausted', 'quota', 'native-codex') },
      { type: 'completed', sequence: 2, at: '2026-09-08T00:00:00.000Z', outcome: 'failed' }
    ])
    const claude = new ScriptedExecutor('claude', 'external-agent', () => [
      { type: 'message', sequence: 1, at: '2026-09-08T00:00:00.000Z', text: 'continued' },
      { type: 'completed', sequence: 2, at: '2026-09-08T00:00:00.000Z', outcome: 'succeeded' }
    ])
    const { runtime, handoffRoot } = createRuntime(fixture.root, native, claude)
    const task = identity(fixture.repo, fixture.sha)
    await runtime.start('native-codex', task, policy)
    const events: ExecutorEvent[] = []
    for await (const event of runtime.prompt(task, { kind: 'prompt', clientRequestId: 'R1', text: 'continue work' })) {
      events.push(event)
    }

    assert.ok(events.some(event => event.type === 'message' && /native-codex → claude/.test(event.text)))
    assert.equal(events.at(-1)?.type, 'completed')
    assert.deepEqual(runtime.active(task.taskId, task.executionId)?.session, {
      executorId: 'claude', sessionId: 'claude-2', generation: 2
    })
    assert.equal(claude.starts[0]?.handoff?.generation, 1)
    assert.match(claude.inputs[0]?.text ?? '', /checkpoint below has already passed Zero3 local hash\/workspace verification/)

    const lease = await new WorkspaceWriterGate(fixture.repo).current()
    assert.equal(lease?.executor_id, 'claude')
    assert.equal(lease?.generation, 2)
    assert.equal(lease?.state, 'active')
    const checkpoint = await new HandoffStore(handoffRoot).load(task.taskId, task.executionId, 2)
    assert.equal(checkpoint.last_executor, 'native-codex')
    assert.equal(checkpoint.handoff_generation, 2)

    await runtime.close(task.taskId, task.executionId)
    assert.equal(await new WorkspaceWriterGate(fixture.repo).current(), undefined)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

class StartFailingExecutor extends ScriptedExecutor {
  override async start(context: ExecutorStartContext): Promise<ExecutorSession> {
    if (context.generation === 2) throw new Error('replacement start failed')
    return super.start(context)
  }
}

test('failed replacement leaves handoff pending until explicit wrapper close releases it', async () => {
  const fixture = await repoFixture()
  try {
    const native = new ScriptedExecutor('native-codex', 'native-codex', () => [
      { type: 'failure', sequence: 1, at: '2026-09-08T00:00:00.000Z', failure: createExecutorFailure('quota_exhausted', 'quota', 'native-codex') }
    ])
    const claude = new StartFailingExecutor('claude', 'external-agent', () => [])
    const { runtime } = createRuntime(fixture.root, native, claude)
    const task = identity(fixture.repo, fixture.sha)
    await runtime.start('native-codex', task, policy)
    await assert.rejects(async () => {
      for await (const _event of runtime.prompt(task, { kind: 'prompt', clientRequestId: 'R1', text: 'continue work' })) {}
    }, /replacement start failed/)

    assert.equal(runtime.active(task.taskId, task.executionId), undefined)
    assert.equal((await new WorkspaceWriterGate(fixture.repo).current())?.state, 'handoff_pending')
    await assert.rejects(runtime.close(task.taskId, task.executionId))
    assert.equal(await new WorkspaceWriterGate(fixture.repo).current(), undefined)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('writer lease collision closes the just-started executor and leaves the existing lease untouched', async () => {
  const fixture = await repoFixture()
  try {
    const native = new ScriptedExecutor('native-codex', 'native-codex', () => [])
    const claude = new ScriptedExecutor('claude', 'external-agent', () => [])
    const { runtime, manager } = createRuntime(fixture.root, native, claude)
    const gate = new WorkspaceWriterGate(fixture.repo)
    const existing = await gate.acquire('other-task', 'other-execution', fixture.repo, 'other-executor', 1)
    const task = identity(fixture.repo, fixture.sha)

    await assert.rejects(
      runtime.start('native-codex', task, policy),
      /existing workspace writer lease does not match resumed failover authority/
    )
    assert.equal(manager.active(task.taskId, task.executionId), undefined)
    assert.equal(native.closeCount, 1)
    assert.equal((await gate.current())?.lease_nonce, existing.lease_nonce)
    await gate.release(existing)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

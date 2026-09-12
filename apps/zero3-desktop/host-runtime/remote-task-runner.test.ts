import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  Zero3RemoteTaskBlockedError,
  Zero3RemoteTaskRunner,
  isThreadMaterializationFailure,
  type Zero3CodexRuntime
} from './remote-task-runner.ts'
import type { Zero3RemoteHostConfig, Zero3RemoteLease } from './remote-types.ts'
import { ZERO3_REMOTE_TASK_PROTOCOL } from './remote-types.ts'

const HEAD_SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-remote-runner-'))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const config: Zero3RemoteHostConfig = {
    enabled: true,
    workerTunnelEnabled: false,
    skillTunnelEnabled: false,
    baseUrl: 'https://control.invalid',
    tokenFile: path.join(root, 'token'),
    nodeId: 'test-node',
    allowedWorkspaces: [workspace],
    developmentAllowHttp: false,
    mappingStateFile: path.join(root, 'state', 'task-mappings.json'),
    outboxDir: path.join(root, 'outbox')
  }
  return { root, workspace, config }
}

function lease(workspace: string, overrides: Partial<Zero3RemoteLease['task']> = {}): Zero3RemoteLease {
  return {
    lease_id: 'lease-1',
    fencing_token: 1,
    task: {
      protocol: ZERO3_REMOTE_TASK_PROTOCOL,
      task_id: 'task-1',
      execution_id: 'execution-1',
      objective: 'Inspect the project and report success.',
      target: { workspace },
      permission_profile: 'standard',
      execution: { max_turns: 1, timeout_seconds: 30, require_clean_worktree: false },
      ...overrides
    }
  }
}

class FakeCodex implements Zero3CodexRuntime {
  startThreadCalls = 0
  startTurnCalls = 0
  readThreadCalls = 0
  execCommandCalls = 0
  /** Leading `thread/read` calls that fail the way an unmaterialized rollout does. */
  materializationFailures = 0
  /** A non-transient store error, used to prove it is never retried. */
  readThreadError: Error | null = null
  baseRefSha: string | null = null
  upstreamSha: string | null = null
  statusOutput = ''

  async startThread() {
    this.startThreadCalls += 1
    return { thread: { id: 'thread-1' } }
  }

  async startTurn() {
    this.startTurnCalls += 1
    return { turn: { id: 'turn-1' } }
  }

  async readThread() {
    this.readThreadCalls += 1
    if (this.readThreadError) throw this.readThreadError
    if (this.materializationFailures > 0) {
      this.materializationFailures -= 1
      throw new Error(
        '[-32603] failed to read thread: thread-store internal error: failed to read session metadata ' +
          'C:\\Zero3 Pilot\\codex\\sessions\\2026\\09\\12\\rollout-2026-09-12T11-20-21-01a093a1-5c85-7981-86df-a37416691096.jsonl: ' +
          'rollout at C:\\Zero3 Pilot\\codex\\sessions\\2026\\09\\12\\rollout-2026-09-12T11-20-21-01a093a1-5c85-7981-86df-a37416691096.jsonl is empty'
      )
    }
    return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] } }
  }

  // The runner proves every Git precondition through Codex command/exec rather
  // than through a local shell, so the fake has to answer the same bounded argv
  // shapes the production adapter sends.
  async execCommand(params: unknown) {
    this.execCommandCalls += 1
    const record = (params ?? {}) as { command?: unknown; cwd?: unknown }
    const command = Array.isArray(record.command) ? record.command.filter(entry => typeof entry === 'string') : []
    const args = command.slice(1)
    const cwd = typeof record.cwd === 'string' ? record.cwd : process.cwd()
    const stdout = (value: string) => ({ exitCode: 0, stdout: value, stderr: '' })

    if (args[0] === '--show-toplevel' || args[1] === '--show-toplevel') return stdout(`${cwd}\n`)
    if (args[0] === 'branch') return stdout('main\n')
    if (args[0] === 'status') return stdout(this.statusOutput)
    if (args[0] === 'rev-parse' && args.some(arg => arg === '@{upstream}')) {
      return stdout(`${this.upstreamSha ?? HEAD_SHA}\n`)
    }
    if (args[0] === 'rev-parse' && args.includes('--end-of-options')) return stdout(`${this.baseRefSha ?? HEAD_SHA}\n`)
    return stdout(`${HEAD_SHA}\n`)
  }
}

test('duplicate task_id reuses the persisted Codex Thread and Turn', async () => {
  const { root, workspace, config } = await fixture()
  try {
    const codex = new FakeCodex()
    const firstRunner = new Zero3RemoteTaskRunner(config, codex)
    const first = await firstRunner.run(lease(workspace))
    assert.equal(first.state, 'succeeded')
    assert.equal(first.mapping.threadId, 'thread-1')
    assert.deepEqual(first.mapping.turnIds, ['turn-1'])
    assert.equal(codex.startThreadCalls, 1)
    assert.equal(codex.startTurnCalls, 1)

    const restartedRunner = new Zero3RemoteTaskRunner(config, codex)
    const second = await restartedRunner.run(lease(workspace))
    assert.equal(second.state, 'succeeded')
    assert.equal(second.mapping.threadId, 'thread-1')
    assert.deepEqual(second.mapping.turnIds, ['turn-1'])
    assert.equal(codex.startThreadCalls, 1)
    assert.equal(codex.startTurnCalls, 1)
    assert.ok(codex.readThreadCalls >= 2)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('unverifiable Git preconditions fail closed before Codex execution', async () => {
  const { root, workspace, config } = await fixture()
  try {
    const codex = new FakeCodex()
    // A base ref that resolves to a commit other than HEAD, and a dirty worktree,
    // are the two preconditions the runner must refuse to hand to Codex.
    codex.baseRefSha = OTHER_SHA
    codex.statusOutput = ' M dirty.txt\n'
    const runner = new Zero3RemoteTaskRunner(config, codex)

    await assert.rejects(
      runner.run(lease(workspace, { target: { workspace, base_ref: 'main' } })),
      Zero3RemoteTaskBlockedError
    )
    await assert.rejects(
      runner.run(
        lease(workspace, {
          execution: { max_turns: 1, timeout_seconds: 30, require_clean_worktree: true }
        })
      ),
      Zero3RemoteTaskBlockedError
    )
    assert.equal(codex.startThreadCalls, 0)
    assert.equal(codex.startTurnCalls, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a rollout that is not materialized yet is waited for instead of failing the Codex attempt', async () => {
  const { root, workspace, config } = await fixture()
  try {
    const codex = new FakeCodex()
    codex.materializationFailures = 3
    const runner = new Zero3RemoteTaskRunner(config, codex, undefined, {
      threadMaterializationTimeoutMs: 2_000
    })

    const evidenceMethods: string[] = []
    const result = await runner.run(lease(workspace), async (_sequence, method) => {
      evidenceMethods.push(method)
    })

    assert.equal(result.state, 'succeeded')
    assert.ok(codex.readThreadCalls >= 4, `expected the read to be retried (saw ${codex.readThreadCalls})`)
    assert.equal(result.mapping.turnIds.length, 1, 'the retry must not start a second Turn')
    assert.ok(
      evidenceMethods.includes('remote.thread.materializing'),
      'the wait must be recorded as evidence instead of being hidden'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a rollout that never materializes still fails the attempt and never loops forever', async () => {
  const { root, workspace, config } = await fixture()
  try {
    const codex = new FakeCodex()
    codex.materializationFailures = Number.POSITIVE_INFINITY
    const runner = new Zero3RemoteTaskRunner(config, codex, undefined, {
      threadMaterializationTimeoutMs: 150
    })

    await assert.rejects(runner.run(lease(workspace)), /rollout at .* is empty/u)
    assert.ok(codex.readThreadCalls <= 10, `expected a bounded wait (saw ${codex.readThreadCalls} reads)`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a non-materialization thread-store error is surfaced without retrying', async () => {
  const { root, workspace, config } = await fixture()
  try {
    const codex = new FakeCodex()
    codex.readThreadError = new Error('[-32602] failed to read thread: no rollout found for thread id 01a093a1')
    const runner = new Zero3RemoteTaskRunner(config, codex, undefined, {
      threadMaterializationTimeoutMs: 2_000
    })

    await assert.rejects(runner.run(lease(workspace)), /no rollout found for thread id/u)
    assert.equal(codex.readThreadCalls, 1, 'only the documented not-materialized state may be retried')
    // The classifier itself is asserted directly so a message-format change cannot
    // silently turn every Codex failure into a retry loop.
    assert.equal(isThreadMaterializationFailure(new Error('rollout at C:\\x is empty')), true)
    assert.equal(
      isThreadMaterializationFailure(new Error('thread-store internal error: no rollout found for thread id x')),
      false
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

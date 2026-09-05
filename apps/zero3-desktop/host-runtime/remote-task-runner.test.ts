import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Zero3RemoteTaskBlockedError, Zero3RemoteTaskRunner, type Zero3CodexRuntime } from './remote-task-runner'
import type { Zero3RemoteHostConfig, Zero3RemoteLease } from './remote-types'
import { ZERO3_REMOTE_TASK_PROTOCOL } from './remote-types'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-remote-runner-'))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const config: Zero3RemoteHostConfig = {
    enabled: true,
    baseUrl: 'https://control.invalid',
    tokenFile: path.join(root, 'token'),
    nodeId: 'test-node',
    allowedWorkspaces: [workspace],
    developmentAllowHttp: false,
    mappingStateFile: path.join(root, 'state', 'task-mappings.json')
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
    return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] } }
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

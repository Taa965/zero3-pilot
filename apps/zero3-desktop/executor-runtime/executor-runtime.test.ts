import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3ExecutorManager, ExecutorManagerError } from './executor-manager.ts'
import { Zero3ExecutorRegistry, ExecutorRegistryError } from './executor-registry.ts'
import { Zero3ExecutorRouter, ExecutorRoutingError } from './executor-router.ts'
import { createExecutorFailure, failurePolicyFor, isExecutorFailure } from './failure-normalizer.ts'
import {
  ZERO3_EXECUTOR_CONTRACT,
  ZERO3_HANDOFF_PROTOCOL,
  type ExecutorEvent,
  type ExecutorHandoffCheckpointRef,
  type ExecutorInput,
  type ExecutorPermissionResponse,
  type ExecutorSession,
  type ExecutorSessionRef,
  type ExecutorStartContext,
  type Zero3Executor
} from './executor-types.ts'

class FakeExecutor implements Zero3Executor {
  readonly descriptor
  starts: ExecutorStartContext[] = []
  prompts: Array<{ session: ExecutorSession; input: ExecutorInput }> = []
  permissionResponses: Array<{ session: ExecutorSession; response: ExecutorPermissionResponse }> = []

  constructor(id: string) {
    this.descriptor = { id, kind: 'external-agent' as const, label: id }
  }

  async probe() {
    return { executorId: this.descriptor.id, status: 'ready' as const }
  }

  async start(context: ExecutorStartContext): Promise<ExecutorSession> {
    this.starts.push(context)
    return {
      executorId: this.descriptor.id,
      sessionId: `${this.descriptor.id}-session`,
      generation: context.generation,
      startedAt: '2026-08-30T00:00:00.000Z'
    }
  }

  async resume(ref: ExecutorSessionRef, _checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession> {
    return { ...ref, startedAt: '2026-08-30T00:00:00.000Z' }
  }

  async *prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    this.prompts.push({ session, input })
    yield { type: 'message', sequence: 1, at: '2026-08-30T00:00:00.000Z', text: 'ok' }
    yield { type: 'completed', sequence: 2, at: '2026-08-30T00:00:00.000Z', outcome: 'succeeded' }
  }

  async respondPermission(session: ExecutorSession, response: ExecutorPermissionResponse) {
    this.permissionResponses.push({ session, response })
  }

  async cancel() {}
  async close() {}
}

class PermissionExecutor extends FakeExecutor {
  async *prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    this.prompts.push({ session, input })
    yield {
      type: 'permission.requested',
      sequence: 1,
      at: '2026-08-30T00:00:00.000Z',
      requestId: 'permission-1',
      description: 'write file',
      allowSessionApproval: true
    }
    yield { type: 'completed', sequence: 2, at: '2026-08-30T00:00:00.000Z', outcome: 'succeeded' }
  }
}

class RestrictedPermissionExecutor extends FakeExecutor {
  async *prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    this.prompts.push({ session, input })
    yield {
      type: 'permission.requested',
      sequence: 1,
      at: '2026-08-30T00:00:00.000Z',
      requestId: 'permission-restricted',
      description: 'write one file',
      allowSessionApproval: false
    }
    yield { type: 'completed', sequence: 2, at: '2026-08-30T00:00:00.000Z', outcome: 'succeeded' }
  }
}

class InvalidFailureExecutor extends FakeExecutor {
  async *prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    this.prompts.push({ session, input })
    yield {
      type: 'failure',
      sequence: 1,
      at: '2026-08-30T00:00:00.000Z',
      failure: { code: 'provider_says_failover', message: 'switch me', source: 'external' }
    } as unknown as ExecutorEvent
  }
}

const identity = {
  taskId: 'task-1',
  executionId: 'execution-1',
  workspace: 'C:\\repo',
  objective: 'complete the requested change',
  constraints: ['preserve approval'],
  acceptanceCriteria: ['tests pass'],
  control: { leaseId: 'lease-1', fencingToken: 7 }
}
const policy = { permissionProfile: 'standard' as const, approvalRequired: true }

test('registry rejects duplicate executor authority', () => {
  const registry = new Zero3ExecutorRegistry()
  registry.register(new FakeExecutor('native'))
  assert.throws(() => registry.register(new FakeExecutor('native')), ExecutorRegistryError)
})

test('manager preserves task/execution/control identity and contract when starting an executor', async () => {
  const registry = new Zero3ExecutorRegistry()
  const executor = new FakeExecutor('native')
  registry.register(executor)
  const manager = new Zero3ExecutorManager(registry)

  const session = await manager.start('native', identity, policy)
  assert.equal(session.executorId, 'native')
  assert.equal(session.generation, 1)
  assert.equal(executor.starts.length, 1)
  assert.equal(executor.starts[0].contract, ZERO3_EXECUTOR_CONTRACT)
  assert.equal(executor.starts[0].identity.taskId, identity.taskId)
  assert.equal(executor.starts[0].identity.executionId, identity.executionId)
  assert.deepEqual(executor.starts[0].identity.control, identity.control)
  assert.deepEqual(executor.starts[0].policy, policy)
  assert.equal(executor.starts[0].handoff, undefined)
  await assert.rejects(manager.start('native', identity, policy), ExecutorManagerError)
})

test('fresh cross-provider handoff increments generation and carries the checkpoint', async () => {
  const registry = new Zero3ExecutorRegistry()
  const executor = new FakeExecutor('claude')
  registry.register(executor)
  const manager = new Zero3ExecutorManager(registry)
  const checkpoint = {
    protocol: ZERO3_HANDOFF_PROTOCOL,
    checkpointHash: 'checkpoint-1',
    generation: 1,
    workspaceFingerprint: 'workspace-1'
  }

  const session = await manager.startFromHandoff('claude', identity, policy, checkpoint)
  assert.equal(session.generation, 2)
  assert.deepEqual(executor.starts[0].handoff, checkpoint)
  assert.equal(executor.starts[0].generation, 2)
})

test('same-provider resume requires generation and executor identity to match the handoff checkpoint', async () => {
  const registry = new Zero3ExecutorRegistry()
  registry.register(new FakeExecutor('external-2'))
  const manager = new Zero3ExecutorManager(registry)
  const ref = { executorId: 'external-2', sessionId: 'session-2', generation: 2 }
  const checkpoint = {
    protocol: ZERO3_HANDOFF_PROTOCOL,
    checkpointHash: 'abc',
    generation: 1,
    workspaceFingerprint: 'workspace-1'
  }

  await assert.rejects(manager.resume('external-2', identity, policy, ref, checkpoint), ExecutorManagerError)
})

test('permission decisions return only through the bound executor session', async () => {
  const registry = new Zero3ExecutorRegistry()
  const executor = new PermissionExecutor('external')
  registry.register(executor)
  const manager = new Zero3ExecutorManager(registry)
  await manager.start('external', identity, policy)

  const iterator = manager.prompt(identity, { kind: 'prompt', clientRequestId: 'request-1', text: 'continue' })[Symbol.asyncIterator]()
  const permission = await iterator.next()
  assert.equal(permission.value?.type, 'permission.requested')

  await manager.respondPermission(identity.taskId, identity.executionId, {
    requestId: 'permission-1',
    decision: 'approve_once'
  })
  assert.equal(executor.permissionResponses.length, 1)
  assert.equal(executor.permissionResponses[0].session.executorId, 'external')
  await assert.rejects(
    manager.respondPermission(identity.taskId, identity.executionId, {
      requestId: 'permission-1',
      decision: 'approve_once'
    }),
    ExecutorManagerError
  )

  await iterator.next()
})

test('session-wide approval is rejected unless the exact pending request allows it', async () => {
  const registry = new Zero3ExecutorRegistry()
  const executor = new RestrictedPermissionExecutor('restricted')
  registry.register(executor)
  const manager = new Zero3ExecutorManager(registry)
  await manager.start('restricted', identity, policy)

  const iterator = manager.prompt(identity, { kind: 'prompt', clientRequestId: 'request-2', text: 'continue' })[Symbol.asyncIterator]()
  const permission = await iterator.next()
  assert.equal(permission.value?.type, 'permission.requested')

  await assert.rejects(
    manager.respondPermission(identity.taskId, identity.executionId, {
      requestId: 'permission-restricted',
      decision: 'approve_session'
    }),
    ExecutorManagerError
  )
  await manager.respondPermission(identity.taskId, identity.executionId, {
    requestId: 'permission-restricted',
    decision: 'approve_once'
  })
  assert.equal(executor.permissionResponses.length, 1)
  await iterator.next()
})

test('permission, policy, task budget and bad-request failures are never automatic failover candidates', () => {
  for (const code of ['permission_denied', 'policy_denied', 'budget_exhausted', 'bad_request'] as const) {
    assert.equal(failurePolicyFor(code).failover, 'forbidden')
  }
  assert.equal(failurePolicyFor('quota_exhausted').failover, 'eligible')
  assert.equal(failurePolicyFor('unsupported').failover, 'eligible')
  assert.equal(failurePolicyFor('unsupported').retryable, false)
  assert.equal(failurePolicyFor('rate_limited').failover, 'conditional')
})

test('runtime failure validation rejects provider-defined unknown codes', () => {
  assert.equal(
    isExecutorFailure({ code: 'provider_says_failover', message: 'switch me', source: 'external' }),
    false
  )
  assert.equal(isExecutorFailure(createExecutorFailure('quota_exhausted', 'quota', 'native')), true)
})

test('manager rejects provider failure events outside the frozen taxonomy', async () => {
  const registry = new Zero3ExecutorRegistry()
  registry.register(new InvalidFailureExecutor('invalid-failure'))
  const manager = new Zero3ExecutorManager(registry)
  await manager.start('invalid-failure', identity, policy)

  await assert.rejects(async () => {
    for await (const _event of manager.prompt(identity, {
      kind: 'prompt',
      clientRequestId: 'request-3',
      text: 'continue'
    })) {
      // Drain the stream; the manager must reject before exposing the invalid event.
    }
  }, ExecutorManagerError)
})

test('router derives failover safety from the failure code rather than provider metadata', () => {
  const registry = new Zero3ExecutorRegistry()
  registry.register(new FakeExecutor('native'))
  registry.register(new FakeExecutor('external-2'))
  registry.register(new FakeExecutor('api'))
  const router = new Zero3ExecutorRouter(registry, { primary: 'native', fallbacks: ['external-2', 'api'] })

  assert.deepEqual(
    router.fallbackCandidatesAfter('native', createExecutorFailure('quota_exhausted', 'quota', 'native')),
    ['external-2', 'api']
  )
  assert.deepEqual(
    router.fallbackCandidatesAfter('native', createExecutorFailure('permission_denied', 'denied', 'native')),
    []
  )
  assert.throws(
    () =>
      router.fallbackCandidatesAfter(
        'native',
        { code: 'provider_says_failover', message: 'switch me', source: 'external' } as never
      ),
    ExecutorRoutingError
  )
})

test('prompt delegates to exactly the bound executor session', async () => {
  const registry = new Zero3ExecutorRegistry()
  const executor = new FakeExecutor('native')
  registry.register(executor)
  const manager = new Zero3ExecutorManager(registry)
  await manager.start('native', identity, policy)

  const events: ExecutorEvent[] = []
  for await (const event of manager.prompt(identity, { kind: 'prompt', clientRequestId: 'request-1', text: 'continue' })) {
    events.push(event)
  }
  assert.deepEqual(events.map(event => event.type), ['message', 'completed'])
  assert.equal(executor.prompts.length, 1)
})

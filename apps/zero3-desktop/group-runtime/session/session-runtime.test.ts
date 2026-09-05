import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ExecutorEvent,
  ExecutorHandoffCheckpointRef,
  ExecutorInput,
  ExecutorPermissionResponse,
  ExecutorPolicyContext,
  ExecutorSession,
  ExecutorSessionRef,
  ExecutorTaskIdentity
} from '../../executor-runtime/executor-types.ts'
import {
  ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  type DevelopmentGroupDefinition,
  type DevelopmentRequirement,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionRuntime
} from '../contracts/index.ts'
import {
  DevelopmentSessionRunner,
  initialSessionRuntime,
  type ExecutorManagerPort,
  type SessionRuntimeStorePort
} from './index.ts'

const group: DevelopmentGroupDefinition = {
  contract: ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  groupId: 'G1',
  repository: 'owner/repo',
  masterGoal: 'Ship the feature',
  masterPrompt: 'Implement it',
  developmentPlan: 'One feature',
  planHash: 'hash',
  baselineSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  integrationRef: 'integration/development-group-v1',
  requirementIds: ['REQ-001'], waveIds: ['W01'], sessionIds: ['S01'],
  policy: {
    maxParallelSessions: 4, maxSessionAttempts: 3, maxRepairSessions: 3, maxRepairWaves: 3,
    maxSameFailureAttempts: 2, maxSessionSubagents: 4, permissionProfile: 'standard',
    completionMode: 'strict', verificationPolicyRevision: 'v1', targetBranch: 'integration/development-group-v1',
    protectedPaths: ['package-lock.json'], mandatoryTests: ['typecheck']
  },
  createdAt: '2026-09-03T00:00:00.000Z'
}
const requirement: DevelopmentRequirement = {
  groupId: 'G1', requirementId: 'REQ-001', title: 'Feature', description: 'Implement feature', mandatory: true,
  acceptanceCriteria: ['feature verified'], sourceAnchor: 'plan#feature', dependencies: []
}
const session: DevelopmentSessionDefinition = {
  contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  groupId: 'G1', sessionId: 'S01', executionId: 'E01', waveId: 'W01', objective: 'Implement feature',
  baselineSha: group.baselineSha, integrationRef: group.integrationRef, branch: 'parallel/s01', worktree: 'C:/repo/s01',
  ownedPaths: ['src/feature/**'], readOnlyPaths: ['src/core/**'], forbiddenPaths: ['package-lock.json'], dependencies: [],
  requirements: ['REQ-001'], inputs: [], acceptanceCriteria: ['feature verified'],
  executorPolicy: { executorId: 'native-codex', permissionProfile: 'standard', approvalRequired: true },
  subagentPolicy: { allowed: true, maxConcurrency: 4, recursiveGroupCreation: false },
  deliveryPolicy: { requireCleanHead: true, requireOwnershipValidation: true, requireHandoff: true, requireDeliveryHash: true }
}

class MemoryStore implements SessionRuntimeStorePort {
  snapshots: DevelopmentSessionRuntime[] = []
  async save(runtime: DevelopmentSessionRuntime) { this.snapshots.push({ ...runtime }) }
}

class FakeManager implements ExecutorManagerPort {
  queues: Array<readonly ExecutorEvent[] | Error> = []
  responses: ExecutorPermissionResponse[] = []
  starts: ExecutorTaskIdentity[] = []
  async start(_executorId: string, identity: ExecutorTaskIdentity, _policy: ExecutorPolicyContext): Promise<ExecutorSession> {
    this.starts.push(identity)
    return { executorId: 'native-codex', sessionId: 'thread-1', generation: 1, startedAt: '2026-09-03T00:00:00.000Z' }
  }
  async startFromHandoff(_executorId: string, _identity: ExecutorTaskIdentity, _policy: ExecutorPolicyContext, checkpoint: ExecutorHandoffCheckpointRef) {
    return { executorId: 'native-codex', sessionId: 'thread-2', generation: checkpoint.generation + 1, startedAt: '2026-09-03T00:00:00.000Z' }
  }
  async resume(_executorId: string, _identity: ExecutorTaskIdentity, _policy: ExecutorPolicyContext, ref: ExecutorSessionRef, _checkpoint: ExecutorHandoffCheckpointRef) {
    return { ...ref, startedAt: '2026-09-03T00:00:00.000Z' }
  }
  async *prompt(_identity: Pick<ExecutorTaskIdentity, 'taskId' | 'executionId'>, _input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    const queue = this.queues.shift() ?? []
    if (queue instanceof Error) throw queue
    for (const event of queue) yield event
  }
  async respondPermission(_taskId: string, _executionId: string, response: ExecutorPermissionResponse) { this.responses.push(response) }
  async cancel() {}
  async close() {}
}

async function runningRunner(manager = new FakeManager()) {
  const store = new MemoryStore()
  const runner = new DevelopmentSessionRunner(group, session, [requirement], manager, store, undefined, initialSessionRuntime(session, '2026-09-03T00:00:00.000Z'))
  await runner.start()
  return { runner, manager, store }
}

test('session prompt preserves authority boundaries and delivery contract', () => {
  const manager = new FakeManager()
  const runner = new DevelopmentSessionRunner(group, session, [requirement], manager, new MemoryStore())
  const prompt = runner.promptText()
  assert.match(prompt, /zero3\.pilot\.development-delivery\.v1/)
  assert.match(prompt, /max concurrency 4/)
  assert.match(prompt, /Do not create another Development Group/)
  assert.match(prompt, /Forbidden paths:\n- package-lock\.json/)
})

test('runner binds exact Session identity to native executor and persists runtime', async () => {
  const { runner, manager, store } = await runningRunner()
  assert.equal(runner.snapshot().status, 'running')
  assert.equal(runner.snapshot().attempt, 1)
  assert.equal(manager.starts[0].executionId, 'E01')
  assert.equal(manager.starts[0].workspace, session.worktree)
  assert.ok(store.snapshots.length >= 2)
})

test('executor sequence may restart at one on a later prompt while Session durable sequence continues', async () => {
  const { runner, manager } = await runningRunner()
  manager.queues.push([{ type: 'message', sequence: 1, at: '2026-09-03T00:00:01.000Z', text: 'first' }])
  manager.queues.push([{ type: 'message', sequence: 1, at: '2026-09-03T00:00:02.000Z', text: 'second' }])
  await runner.sendInstruction('R1', 'first')
  await runner.sendInstruction('R2', 'second')
  assert.equal(runner.snapshot().lastEventSequence, 2)
  assert.equal(runner.snapshot().status, 'running')
})

test('permission request remains a proxy wait and is never auto-approved', async () => {
  const { runner, manager } = await runningRunner()
  manager.queues.push([{ type: 'permission.requested', sequence: 1, at: '2026-09-03T00:00:01.000Z', requestId: 'P1', description: 'write', allowSessionApproval: false }])
  await runner.sendInstruction('R1', 'change file')
  assert.equal(runner.snapshot().status, 'waiting_input')
  assert.equal(manager.responses.length, 0)
  await runner.respondPermission({ requestId: 'P1', decision: 'deny' })
  assert.equal(manager.responses.length, 1)
  assert.equal(runner.snapshot().status, 'running')
})

test('context loss blocks for handoff while transport ambiguity becomes OutcomeUnknown', async () => {
  const context = await runningRunner()
  context.manager.queues.push([{ type: 'failure', sequence: 1, at: '2026-09-03T00:00:01.000Z', failure: { code: 'context_lost', message: 'lost', source: 'native-codex' } }])
  await context.runner.sendInstruction('R1', 'continue')
  assert.equal(context.runner.snapshot().status, 'blocked')
  assert.equal(context.runner.snapshot().blocker, 'context_lost')

  const transport = await runningRunner()
  transport.manager.queues.push([{ type: 'failure', sequence: 1, at: '2026-09-03T00:00:01.000Z', failure: { code: 'transport_lost', message: 'unknown', source: 'native-codex' } }])
  await transport.runner.sendInstruction('R1', 'continue')
  assert.equal(transport.runner.snapshot().status, 'outcome_unknown')
})

test('thrown active-prompt error fails closed to OutcomeUnknown rather than retrying', async () => {
  const { runner, manager } = await runningRunner()
  manager.queues.push(new Error('socket disappeared'))
  await assert.rejects(runner.sendInstruction('R1', 'side effecting work'))
  assert.equal(runner.snapshot().status, 'outcome_unknown')
})

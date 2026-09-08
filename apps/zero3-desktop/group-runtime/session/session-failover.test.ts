import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ExecutorEvent,
  ExecutorFailure,
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
  type ExecutorManagerFailoverResult,
  type ExecutorManagerPort,
  type SessionRuntimeStorePort
} from './session-runtime.ts'

const group: DevelopmentGroupDefinition = {
  contract: ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  groupId: 'G-FAILOVER',
  repository: 'owner/repo',
  masterGoal: 'Ship the feature',
  masterPrompt: 'Implement it',
  developmentPlan: 'One session',
  planHash: 'hash',
  baselineSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  integrationRef: 'integration/development-group-v1',
  requirementIds: ['REQ-1'],
  waveIds: ['W01'],
  sessionIds: ['S01'],
  policy: {
    maxParallelSessions: 1,
    maxSessionAttempts: 3,
    maxRepairSessions: 1,
    maxRepairWaves: 1,
    maxSameFailureAttempts: 2,
    maxSessionSubagents: 1,
    permissionProfile: 'standard',
    completionMode: 'strict',
    verificationPolicyRevision: 'v1',
    targetBranch: 'integration/development-group-v1',
    protectedPaths: [],
    mandatoryTests: []
  },
  createdAt: '2026-09-08T00:00:00.000Z'
}

const requirement: DevelopmentRequirement = {
  groupId: group.groupId,
  requirementId: 'REQ-1',
  title: 'Feature',
  description: 'Implement feature',
  mandatory: true,
  acceptanceCriteria: ['feature verified'],
  sourceAnchor: 'plan#feature',
  dependencies: []
}

const session: DevelopmentSessionDefinition = {
  contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  groupId: group.groupId,
  sessionId: 'S01',
  executionId: 'E01',
  waveId: 'W01',
  objective: 'Implement feature',
  baselineSha: group.baselineSha,
  integrationRef: group.integrationRef,
  branch: 'parallel/s01',
  worktree: 'C:/repo/s01',
  ownedPaths: ['src/**'],
  readOnlyPaths: [],
  forbiddenPaths: [],
  dependencies: [],
  requirements: ['REQ-1'],
  inputs: [],
  acceptanceCriteria: ['feature verified'],
  executorPolicy: { executorId: 'native-codex', permissionProfile: 'standard', approvalRequired: false },
  subagentPolicy: { allowed: false, maxConcurrency: 1, recursiveGroupCreation: false },
  deliveryPolicy: { requireCleanHead: true, requireOwnershipValidation: true, requireHandoff: true, requireDeliveryHash: true }
}

class MemoryStore implements SessionRuntimeStorePort {
  snapshots: DevelopmentSessionRuntime[] = []
  async save(runtime: DevelopmentSessionRuntime) { this.snapshots.push({ ...runtime }) }
}

class FailoverManager implements ExecutorManagerPort {
  promptInputs: ExecutorInput[] = []
  failoverCalls: ExecutorFailure[] = []
  promptCount = 0

  async start(_executorId: string, _identity: ExecutorTaskIdentity, _policy: ExecutorPolicyContext): Promise<ExecutorSession> {
    return { executorId: 'native-codex', sessionId: 'codex-1', generation: 1, startedAt: '2026-09-08T00:00:00.000Z' }
  }
  async startFromHandoff(_executorId: string, _identity: ExecutorTaskIdentity, _policy: ExecutorPolicyContext, checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession> {
    return { executorId: 'claude', sessionId: 'claude-2', generation: checkpoint.generation + 1, startedAt: '2026-09-08T00:00:01.000Z' }
  }
  async resume(_executorId: string, _identity: ExecutorTaskIdentity, _policy: ExecutorPolicyContext, ref: ExecutorSessionRef, _checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession> {
    return { ...ref, startedAt: '2026-09-08T00:00:00.000Z' }
  }
  async *prompt(_identity: Pick<ExecutorTaskIdentity, 'taskId' | 'executionId'>, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    this.promptInputs.push(input)
    this.promptCount += 1
    if (this.promptCount === 1) {
      yield {
        type: 'failure',
        sequence: 1,
        at: '2026-09-08T00:00:01.000Z',
        failure: { code: 'quota_exhausted', message: 'quota reached', source: 'native-codex' }
      }
      return
    }
    yield { type: 'message', sequence: 1, at: '2026-09-08T00:00:02.000Z', text: 'continued safely' }
    yield { type: 'completed', sequence: 2, at: '2026-09-08T00:00:03.000Z', outcome: 'succeeded' }
  }
  async failoverAfterFailure(_taskId: string, _executionId: string, failure: ExecutorFailure): Promise<ExecutorManagerFailoverResult | null> {
    this.failoverCalls.push(failure)
    return {
      fromExecutorId: 'native-codex',
      toExecutorId: 'claude',
      session: { executorId: 'claude', sessionId: 'claude-2', generation: 2, startedAt: '2026-09-08T00:00:01.000Z' },
      checkpoint: {
        protocol: 'zero3.pilot.handoff.v1',
        checkpointHash: 'checkpoint-hash',
        generation: 1,
        workspaceFingerprint: 'workspace-fingerprint'
      }
    }
  }
  async respondPermission(_taskId: string, _executionId: string, _response: ExecutorPermissionResponse) {}
  async cancel() {}
  async close() {}
}

test('quota exhaustion continues the same Development Session on Claude generation + 1', async () => {
  const manager = new FailoverManager()
  const store = new MemoryStore()
  const runner = new DevelopmentSessionRunner(
    group,
    session,
    [requirement],
    manager,
    store,
    undefined,
    initialSessionRuntime(session, '2026-09-08T00:00:00.000Z')
  )

  await runner.start()
  await runner.sendInstruction('REQ-1', 'Implement the feature without repeating completed side effects.')

  const runtime = runner.snapshot()
  assert.equal(manager.failoverCalls.length, 1)
  assert.equal(manager.promptInputs.length, 2)
  assert.equal(runtime.status, 'delivering')
  assert.equal(runtime.executorId, 'claude')
  assert.equal(runtime.executorSessionId, 'claude-2')
  assert.equal(runtime.executorGeneration, 2)
  assert.equal(runtime.writerGeneration, 2)
  assert.equal(runtime.blocker, undefined)
  assert.equal(runtime.lastEventSequence, 3)
  assert.match(manager.promptInputs[1]?.clientRequestId ?? '', /:failover:2$/)
  assert.match(manager.promptInputs[1]?.text ?? '', /durable handoff checkpoint checkpoint-hash/)
  assert.match(manager.promptInputs[1]?.text ?? '', /current workspace and Git state as authoritative/i)
  assert.match(manager.promptInputs[1]?.text ?? '', /do not blindly repeat side effects/i)
})

test('quota failure remains failed when no fallback can be activated', async () => {
  const manager = new FailoverManager()
  manager.failoverAfterFailure = async (_taskId, _executionId, failure) => {
    manager.failoverCalls.push(failure)
    return null
  }
  const runner = new DevelopmentSessionRunner(
    group,
    session,
    [requirement],
    manager,
    new MemoryStore(),
    undefined,
    initialSessionRuntime(session, '2026-09-08T00:00:00.000Z')
  )
  await runner.start()
  await runner.sendInstruction('REQ-1', 'Implement feature')
  assert.equal(runner.snapshot().status, 'failed')
  assert.equal(runner.snapshot().blocker, 'quota_exhausted')
  assert.equal(manager.promptInputs.length, 1)
})

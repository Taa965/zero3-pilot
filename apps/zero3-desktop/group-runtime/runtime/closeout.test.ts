import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  type DevelopmentGroupDefinition,
  type DevelopmentRequirement,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionRuntime
} from '../contracts/index.ts'
import { buildDevelopmentSessionPrompt, type DevelopmentSessionRunner } from '../session/index.ts'
import type { DevelopmentGroupStore } from '../store/index.ts'
import { resolveSessionWorktree } from '../workspace/index.ts'
import { resolveSessionOutcomeUnknown } from './session-lifecycle.ts'
import { DevelopmentGroupWorkerSupervisor } from './worker-supervisor.ts'

const group: DevelopmentGroupDefinition = {
  contract: ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  groupId: 'G-CLOSEOUT',
  repository: resolve('fixture-repo'),
  masterGoal: 'Ship safely',
  masterPrompt: 'Implement the change',
  developmentPlan: 'One bounded Session',
  planHash: 'closeout-hash',
  baselineSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  integrationRef: 'integration/development-group-v1',
  requirementIds: ['REQ-1'],
  waveIds: ['W01'],
  sessionIds: ['S01'],
  policy: {
    maxParallelSessions: 6,
    maxSessionAttempts: 3,
    maxRepairSessions: 3,
    maxRepairWaves: 3,
    maxSameFailureAttempts: 2,
    maxSessionSubagents: 4,
    permissionProfile: 'standard',
    completionMode: 'strict',
    verificationPolicyRevision: 'v1',
    targetBranch: 'integration/development-group-v1',
    protectedPaths: [],
    mandatoryTests: ['typecheck']
  },
  createdAt: '2026-09-04T00:00:00.000Z'
}

const session: DevelopmentSessionDefinition = {
  contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  groupId: group.groupId,
  sessionId: 'S01',
  executionId: 'E01',
  waveId: 'W01',
  objective: 'Implement the bounded change',
  baselineSha: group.baselineSha,
  integrationRef: group.integrationRef,
  branch: 'dg/g-closeout/s01',
  worktree: '.zero3/worktrees/G-CLOSEOUT/S01',
  ownedPaths: ['src/**'],
  readOnlyPaths: [],
  forbiddenPaths: [],
  dependencies: [],
  requirements: ['REQ-1'],
  inputs: [],
  acceptanceCriteria: ['change is committed'],
  executorPolicy: { executorId: 'native-codex', permissionProfile: 'standard', approvalRequired: true },
  subagentPolicy: { allowed: true, maxConcurrency: 4, recursiveGroupCreation: false },
  deliveryPolicy: { requireCleanHead: true, requireOwnershipValidation: true, requireHandoff: true, requireDeliveryHash: true }
}

const requirement: DevelopmentRequirement = {
  groupId: group.groupId,
  requirementId: 'REQ-1',
  title: 'Bounded change',
  description: 'Implement only the owned change',
  mandatory: true,
  acceptanceCriteria: ['change is committed'],
  sourceAnchor: 'plan#bounded-change',
  dependencies: []
}

class OutcomeStore {
  runtime: DevelopmentSessionRuntime = {
    groupId: group.groupId,
    sessionId: session.sessionId,
    executionId: session.executionId,
    status: 'outcome_unknown',
    attempt: 1,
    writerGeneration: 1,
    lastEventSequence: 1,
    blocker: 'runtime_restart_without_authoritative_executor_outcome',
    updatedAt: '2026-09-04T00:00:00.000Z'
  }

  async loadSession(): Promise<DevelopmentSessionRuntime> {
    return { ...this.runtime }
  }

  async writeSession(runtime: DevelopmentSessionRuntime): Promise<void> {
    this.runtime = { ...runtime }
  }
}

function runtime(status: DevelopmentSessionRuntime['status']): DevelopmentSessionRuntime {
  return {
    groupId: group.groupId,
    sessionId: session.sessionId,
    executionId: session.executionId,
    status,
    attempt: 1,
    writerGeneration: 1,
    lastEventSequence: 1,
    updatedAt: '2026-09-04T00:00:00.000Z'
  }
}

class SupervisorRunnerDouble {
  readonly session = session
  closeCalls = 0
  current = runtime('running')

  constructor(private readonly settledStatus: DevelopmentSessionRuntime['status']) {}

  snapshot(): DevelopmentSessionRuntime {
    return { ...this.current }
  }

  async sendInitialInstruction(): Promise<DevelopmentSessionRuntime> {
    this.current = runtime(this.settledStatus)
    return this.snapshot()
  }

  async markOutcomeUnknown(reason: string): Promise<void> {
    this.current = { ...runtime('outcome_unknown'), blocker: reason }
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

test('relative Session worktree is anchored to the Development Group repository', () => {
  const resolved = resolveSessionWorktree(group, session)
  assert.equal(resolved.worktree, resolve(group.repository, session.worktree))
  assert.equal(resolved.branch, session.branch)
})

test('Session prompt requires a committed clean branch and forbids integration mutation', () => {
  const prompt = buildDevelopmentSessionPrompt({ group, session, requirements: [requirement] })
  assert.match(prompt, /commit every intended Session change/)
  assert.match(prompt, /leave the Session worktree clean/)
  assert.match(prompt, /Do not merge, rebase, checkout, reset/)
})

test('OutcomeUnknown requires explicit evidence and resolves only through a terminal human classification', async () => {
  const store = new OutcomeStore()
  await assert.rejects(
    resolveSessionOutcomeUnknown(store as unknown as DevelopmentGroupStore, group.groupId, session.sessionId, 'failed', '   '),
    /explicit evidence\/reason/
  )
  const result = await resolveSessionOutcomeUnknown(
    store as unknown as DevelopmentGroupStore,
    group.groupId,
    session.sessionId,
    'failed',
    'human confirmed remote turn did not complete'
  )
  assert.equal(result.status, 'failed')
  assert.match(result.blocker ?? '', /outcome_unknown_resolved:failed:human confirmed/)
})

test('Supervisor releases a settled authoritative Executor binding', async () => {
  const runner = new SupervisorRunnerDouble('delivering')
  const supervisor = new DevelopmentGroupWorkerSupervisor()
  supervisor.launch({ runner: runner as unknown as DevelopmentSessionRunner, clientRequestId: 'R1' })
  await supervisor.drain(session.sessionId)
  assert.equal(runner.closeCalls, 1)
  assert.equal(supervisor.isActive(session.sessionId), false)
})

test('Supervisor quarantines OutcomeUnknown binding until explicit recovery', async () => {
  const runner = new SupervisorRunnerDouble('outcome_unknown')
  const supervisor = new DevelopmentGroupWorkerSupervisor()
  supervisor.launch({ runner: runner as unknown as DevelopmentSessionRunner, clientRequestId: 'R2' })
  await supervisor.drain(session.sessionId)
  assert.equal(runner.closeCalls, 0)
  assert.equal(supervisor.isActive(session.sessionId), false)
})

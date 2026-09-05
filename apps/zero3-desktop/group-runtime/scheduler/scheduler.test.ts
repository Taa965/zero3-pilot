import assert from 'node:assert/strict'
import test from 'node:test'

import { ZERO3_DEVELOPMENT_SESSION_CONTRACT, type DevelopmentGroupPolicy, type DevelopmentSessionDefinition, type DevelopmentSessionRuntime, type DevelopmentWave } from '../contracts/index.ts'
import { DevelopmentSessionScheduler, DevelopmentSchedulerError, type WaveGateEvidence } from './index.ts'

const policy: DevelopmentGroupPolicy = {
  maxParallelSessions: 2, maxSessionAttempts: 3, maxRepairSessions: 3, maxRepairWaves: 2,
  maxSameFailureAttempts: 2, maxSessionSubagents: 4, permissionProfile: 'standard', completionMode: 'strict',
  verificationPolicyRevision: 'v1', targetBranch: 'integration/development-group-v1', protectedPaths: [], mandatoryTests: []
}
function session(id: string, waveId: string, dependencies: readonly string[] = []): DevelopmentSessionDefinition {
  return {
    contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT, groupId: 'G1', sessionId: id, executionId: `E-${id}`, waveId, objective: id,
    baselineSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', integrationRef: policy.targetBranch, branch: `parallel/${id}`, worktree: `C:/repo/${id}`,
    ownedPaths: [`src/${id}/**`], readOnlyPaths: [], forbiddenPaths: [], dependencies, requirements: [`REQ-${id}`], inputs: [], acceptanceCriteria: ['done'],
    executorPolicy: { executorId: 'native-codex', permissionProfile: 'standard', approvalRequired: true },
    subagentPolicy: { allowed: true, maxConcurrency: 2, recursiveGroupCreation: false },
    deliveryPolicy: { requireCleanHead: true, requireOwnershipValidation: true, requireHandoff: true, requireDeliveryHash: true }
  }
}
const sessions = [session('S01', 'W01'), session('S02', 'W01'), session('S03', 'W02', ['S01'])]
const waves: DevelopmentWave[] = [
  { groupId: 'G1', waveId: 'W01', ordinal: 1, sessionIds: ['S01', 'S02'], requiredSessionIds: ['S01', 'S02'], dependsOnWaveIds: [] },
  { groupId: 'G1', waveId: 'W02', ordinal: 2, sessionIds: ['S03'], requiredSessionIds: ['S03'], dependsOnWaveIds: ['W01'] }
]
function runtime(id: string, status: DevelopmentSessionRuntime['status'], attempt = 0): DevelopmentSessionRuntime {
  return { groupId: 'G1', sessionId: id, executionId: `E-${id}`, status, attempt, writerGeneration: 1, lastEventSequence: 0, updatedAt: '2026-09-03T00:00:00.000Z' }
}
const openWave1 = new Map<string, WaveGateEvidence>()
const openWave2 = new Map<string, WaveGateEvidence>([['W01', { waveId: 'W01', integrationValid: true, requiredDeliveriesValid: true, ownershipValid: true }]])

test('scheduler fills bounded concurrency slots in deterministic order', () => {
  const scheduler = new DevelopmentSessionScheduler(policy, sessions, waves)
  const result = scheduler.snapshot({ runtimes: [runtime('S01', 'ready'), runtime('S02', 'ready'), runtime('S03', 'waiting_dependencies')], waveEvidence: openWave1, runningSessionCount: 0 })
  assert.deepEqual(result.readySessionIds, ['S01', 'S02'])
  assert.equal(result.availableSlots, 2)
})

test('next wave stays closed until dependency delivery and integration evidence are valid', () => {
  const scheduler = new DevelopmentSessionScheduler(policy, sessions, waves)
  const closed = scheduler.snapshot({ runtimes: [runtime('S01', 'delivered'), runtime('S02', 'delivered'), runtime('S03', 'waiting_dependencies')], waveEvidence: openWave1, runningSessionCount: 0 })
  assert.deepEqual(closed.readySessionIds, [])
  const opened = scheduler.snapshot({ runtimes: [runtime('S01', 'delivered'), runtime('S02', 'delivered'), runtime('S03', 'waiting_dependencies')], waveEvidence: openWave2, runningSessionCount: 0 })
  assert.deepEqual(opened.readySessionIds, ['S03'])
})

test('pause/cancel and explicit session pause prevent scheduling', () => {
  const scheduler = new DevelopmentSessionScheduler(policy, sessions, waves)
  scheduler.pauseSession('S01')
  assert.deepEqual(scheduler.snapshot({ runtimes: [runtime('S01', 'ready'), runtime('S02', 'ready')], waveEvidence: openWave1, runningSessionCount: 0 }).readySessionIds, ['S02'])
  scheduler.pauseGroup()
  assert.deepEqual(scheduler.snapshot({ runtimes: [runtime('S02', 'ready')], waveEvidence: openWave1, runningSessionCount: 0 }).readySessionIds, [])
  scheduler.resumeGroup()
  scheduler.cancelGroup()
  assert.throws(() => scheduler.resumeGroup(), DevelopmentSchedulerError)
})

test('OutcomeUnknown never enters retry and attempts/repair waves are bounded', () => {
  const scheduler = new DevelopmentSessionScheduler(policy, sessions, waves)
  assert.throws(() => scheduler.requestRetry(runtime('S01', 'outcome_unknown', 1)), /OutcomeUnknown/)
  assert.throws(() => scheduler.requestRetry(runtime('S01', 'failed', 3)), /attempt budget/)
  scheduler.requestRetry(runtime('S01', 'failed', 1))
  assert.deepEqual(scheduler.snapshot({ runtimes: [runtime('S01', 'failed', 1)], waveEvidence: openWave1, runningSessionCount: 0 }).readySessionIds, ['S01'])
  assert.equal(scheduler.registerRepairWave(), 1)
  assert.equal(scheduler.registerRepairWave(), 2)
  assert.throws(() => scheduler.registerRepairWave(), /repair wave budget/)
})

test('same-wave implementation dependency is rejected at scheduler construction', () => {
  assert.throws(() => new DevelopmentSessionScheduler(policy, [session('S01', 'W01'), session('S02', 'W01', ['S01'])], waves.slice(0, 1)), DevelopmentSchedulerError)
})

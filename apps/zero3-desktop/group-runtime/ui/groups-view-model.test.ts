import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  DevelopmentDelivery,
  DevelopmentGroupDefinition,
  DevelopmentGroupRuntimeState,
  DevelopmentRequirement,
  DevelopmentSessionDefinition,
  DevelopmentSessionRuntime,
  IntegrationMilestone,
  VerificationRun
} from '../contracts/index.ts'
import { buildDevelopmentGroupViewModel } from './groups-view-model.ts'

const baseSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const midSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const finalSha = 'cccccccccccccccccccccccccccccccccccccccc'
const definition = {
  groupId: 'G1', masterGoal: 'finish', repository: 'owner/repo',
  policy: { verificationPolicyRevision: 'v1', mandatoryTests: ['unit'] }
} as DevelopmentGroupDefinition
const state = { groupId: 'G1', status: 'verifying', lastEventSequence: 0, unresolvedBlockers: [], outcomeUnknownCount: 0, repairWaveCount: 0, updatedAt: '2026-09-03T00:00:00.000Z' } as DevelopmentGroupRuntimeState
const requirements = [
  { groupId: 'G1', requirementId: 'R1', title: 'one', mandatory: true },
  { groupId: 'G1', requirementId: 'R2', title: 'two', mandatory: true }
] as DevelopmentRequirement[]
const sessions = [
  { groupId: 'G1', sessionId: 'S1', objective: 'one', waveId: 'W1', branch: 'parallel/s1', worktree: 'w1', requirements: ['R1'], dependencies: [] },
  { groupId: 'G1', sessionId: 'S2', objective: 'two', waveId: 'W1', branch: 'parallel/s2', worktree: 'w2', requirements: ['R2'], dependencies: ['S1'] }
] as DevelopmentSessionDefinition[]
const runtimes = sessions.map((session, index) => ({ groupId: 'G1', sessionId: session.sessionId, executionId: `E${index + 1}`, status: 'integrated', attempt: 1, writerGeneration: 1, lastEventSequence: 0, updatedAt: state.updatedAt })) as DevelopmentSessionRuntime[]
const deliveries = sessions.map((session, index) => ({ sessionId: session.sessionId, status: 'completed', testsExecuted: ['unit'] })) as DevelopmentDelivery[]
const integrations: IntegrationMilestone[] = [
  { integrationRunId: 'I1', groupId: 'G1', baseSha, headSha: midSha, deliveryHashes: ['D1'], mergedSessionIds: ['S1'], status: 'merged', conflicts: [], createdAt: state.updatedAt },
  { integrationRunId: 'I2', groupId: 'G1', baseSha: midSha, headSha: finalSha, deliveryHashes: ['D2'], mergedSessionIds: ['S2'], status: 'merged', conflicts: [], createdAt: state.updatedAt }
]
const verification: VerificationRun = {
  verificationRunId: 'V1', groupId: 'G1', integrationSha: finalSha, policyRevision: 'v1',
  commands: [{ id: 'unit', command: 'unit-tests', platform: 'any', required: true }],
  results: [{ commandId: 'unit', status: 'passed', exitCode: 0, evidence: ['ok'] }], environment: {}, startedAt: state.updatedAt, status: 'passed'
}

test('final verification projects all sessions in the cumulative integration ancestry as verified', () => {
  const view = buildDevelopmentGroupViewModel({ definition, state, requirements, sessions, runtimes, deliveries, waves: [], integrations, verifications: [verification], failures: [], repairs: [] })
  assert.equal(view.summary.progress.verifiedSessions, 2)
  assert.equal(view.summary.progress.verifiedRequirements, 2)
  assert.deepEqual(view.requirements.map(row => row.verified), [true, true])
})

test('stale policy verification is not projected as verified', () => {
  const stale = { ...verification, policyRevision: 'old' }
  const view = buildDevelopmentGroupViewModel({ definition, state, requirements, sessions, runtimes, deliveries, waves: [], integrations, verifications: [stale], failures: [], repairs: [] })
  assert.equal(view.summary.progress.verifiedSessions, 0)
})

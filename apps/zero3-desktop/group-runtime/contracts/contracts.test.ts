import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
  ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  ZERO3_GROUP_COMPLETION_PROOF,
  validateDevelopmentGroupDefinition,
  validateGroupCompletionProof,
  validateGroupStateTransition,
  validateSessionStateTransition,
  type DevelopmentDelivery,
  type DevelopmentGroupDefinition,
  type DevelopmentRequirement,
  type DevelopmentSessionDefinition,
  type DevelopmentWave,
  type GroupCompletionProof,
  type VerificationRun
} from './index.ts'

const sha = '1111111111111111111111111111111111111111'
const head = '2222222222222222222222222222222222222222'

function fixture() {
  const requirements: DevelopmentRequirement[] = [
    {
      groupId: 'G1',
      requirementId: 'REQ-001',
      title: 'First feature',
      description: 'Implement the first feature',
      mandatory: true,
      acceptanceCriteria: ['feature is present'],
      sourceAnchor: 'plan#feature-1',
      dependencies: []
    },
    {
      groupId: 'G1',
      requirementId: 'REQ-002',
      title: 'Second feature',
      description: 'Implement the dependent feature',
      mandatory: true,
      acceptanceCriteria: ['dependency is respected'],
      sourceAnchor: 'plan#feature-2',
      dependencies: ['REQ-001']
    }
  ]
  const sessions: DevelopmentSessionDefinition[] = [
    {
      contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT,
      groupId: 'G1',
      sessionId: 'S01',
      executionId: 'E01',
      waveId: 'W1',
      objective: 'Implement first feature',
      baselineSha: sha,
      integrationRef: 'integration/development-group-v1',
      branch: 'parallel/s01',
      worktree: 'C:/repo/.worktrees/s01',
      ownedPaths: ['src/first/**'],
      readOnlyPaths: ['src/core/**'],
      forbiddenPaths: ['src/payment/**'],
      dependencies: [],
      requirements: ['REQ-001'],
      inputs: [],
      acceptanceCriteria: ['REQ-001 passes'],
      executorPolicy: { executorId: 'native-codex', permissionProfile: 'standard', approvalRequired: true },
      subagentPolicy: { allowed: true, maxConcurrency: 2, recursiveGroupCreation: false },
      deliveryPolicy: { requireCleanHead: true, requireOwnershipValidation: true, requireHandoff: true, requireDeliveryHash: true }
    },
    {
      contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT,
      groupId: 'G1',
      sessionId: 'S02',
      executionId: 'E02',
      waveId: 'W2',
      objective: 'Implement second feature',
      baselineSha: sha,
      integrationRef: 'integration/development-group-v1',
      branch: 'parallel/s02',
      worktree: 'C:/repo/.worktrees/s02',
      ownedPaths: ['src/second/**'],
      readOnlyPaths: ['src/core/**'],
      forbiddenPaths: ['src/payment/**'],
      dependencies: ['S01'],
      requirements: ['REQ-002'],
      inputs: [],
      acceptanceCriteria: ['REQ-002 passes'],
      executorPolicy: { executorId: 'native-codex', permissionProfile: 'standard', approvalRequired: true },
      subagentPolicy: { allowed: true, maxConcurrency: 2, recursiveGroupCreation: false },
      deliveryPolicy: { requireCleanHead: true, requireOwnershipValidation: true, requireHandoff: true, requireDeliveryHash: true }
    }
  ]
  const waves: DevelopmentWave[] = [
    { groupId: 'G1', waveId: 'W1', ordinal: 1, sessionIds: ['S01'], requiredSessionIds: ['S01'], dependsOnWaveIds: [] },
    { groupId: 'G1', waveId: 'W2', ordinal: 2, sessionIds: ['S02'], requiredSessionIds: ['S02'], dependsOnWaveIds: ['W1'] }
  ]
  const definition: DevelopmentGroupDefinition = {
    contract: ZERO3_DEVELOPMENT_GROUP_CONTRACT,
    groupId: 'G1',
    repository: 'owner/repo',
    masterGoal: 'Ship two features',
    masterPrompt: 'Build the project',
    developmentPlan: 'Feature 1 then feature 2',
    planHash: 'plan-hash',
    baselineSha: sha,
    integrationRef: 'integration/development-group-v1',
    requirementIds: requirements.map(item => item.requirementId),
    waveIds: waves.map(item => item.waveId),
    sessionIds: sessions.map(item => item.sessionId),
    policy: {
      maxParallelSessions: 4,
      maxSessionAttempts: 3,
      maxRepairSessions: 3,
      maxRepairWaves: 3,
      maxSameFailureAttempts: 2,
      maxSessionSubagents: 4,
      permissionProfile: 'standard',
      completionMode: 'strict',
      verificationPolicyRevision: 'v1',
      targetBranch: 'integration/development-group-v1',
      protectedPaths: ['package-lock.json'],
      mandatoryTests: ['typecheck']
    },
    createdAt: '2026-09-03T00:00:00.000Z'
  }
  return { definition, requirements, sessions, waves }
}

test('valid contract fixture has no validation issues', () => {
  const { definition, requirements, sessions, waves } = fixture()
  assert.deepEqual(validateDevelopmentGroupDefinition(definition, requirements, sessions, waves), [])
})

test('contract rejects duplicate ids, missing mandatory assignment and unsafe unbounded budgets', () => {
  const { definition, requirements, sessions, waves } = fixture()
  definition.requirementIds = ['REQ-001', 'REQ-001']
  definition.policy.maxParallelSessions = Number.POSITIVE_INFINITY
  sessions[1].requirements = []
  const codes = validateDevelopmentGroupDefinition(definition, requirements, sessions, waves).map(item => item.code)
  assert.ok(codes.includes('duplicate_requirement'))
  assert.ok(codes.includes('invalid_budget'))
  assert.ok(codes.includes('mandatory_assignment'))
})

test('contract rejects session DAG cycles and ownership collisions', () => {
  const { definition, requirements, sessions, waves } = fixture()
  sessions[0].dependencies = ['S02']
  sessions[1].ownedPaths = ['src/first/**']
  const codes = validateDevelopmentGroupDefinition(definition, requirements, sessions, waves).map(item => item.code)
  assert.ok(codes.includes('session_cycle'))
  assert.ok(codes.includes('ownership_collision'))
})

test('contract rejects unknown dependencies and invalid session baselines', () => {
  const { definition, requirements, sessions, waves } = fixture()
  sessions[0].dependencies = ['missing-session']
  sessions[0].baselineSha = head
  const codes = validateDevelopmentGroupDefinition(definition, requirements, sessions, waves).map(item => item.code)
  assert.ok(codes.includes('unknown_dependency'))
  assert.ok(codes.includes('invalid_baseline'))
})

test('state machines reject invalid shortcuts and OutcomeUnknown blind resume', () => {
  assert.equal(validateGroupStateTransition('draft', 'completed').length, 1)
  assert.equal(validateGroupStateTransition('outcome_unknown', 'running').length, 1)
  assert.equal(validateGroupStateTransition('outcome_unknown', 'waiting_human').length, 0)
  assert.equal(validateSessionStateTransition('planned', 'verified').length, 1)
  assert.equal(validateSessionStateTransition('outcome_unknown', 'running').length, 1)
})

test('completion proof is fail-closed for unverified mandatory requirements and OutcomeUnknown', () => {
  const { requirements, sessions } = fixture()
  const delivery: DevelopmentDelivery = {
    contract: ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
    groupId: 'G1',
    sessionId: sessions[0].sessionId,
    executionId: sessions[0].executionId,
    status: 'completed',
    baseSha: sha,
    headSha: head,
    changedPaths: ['src/first/index.ts'],
    requirements: ['REQ-001'],
    testsAdded: ['first.test.ts'],
    testsExecuted: ['node --test'],
    artifacts: [],
    knownIssues: [],
    downstreamNotes: [],
    handoffCheckpoint: 'checkpoint',
    deliveryHash: 'delivery-1',
    createdAt: '2026-09-03T00:00:00.000Z'
  }
  const verification: VerificationRun = {
    verificationRunId: 'V1',
    groupId: 'G1',
    integrationSha: head,
    policyRevision: 'v1',
    commands: [],
    results: [],
    environment: {},
    startedAt: '2026-09-03T00:00:00.000Z',
    finishedAt: '2026-09-03T00:01:00.000Z',
    status: 'passed'
  }
  const proof: GroupCompletionProof = {
    contract: ZERO3_GROUP_COMPLETION_PROOF,
    groupId: 'G1',
    requirementCoverage: [
      { requirementId: 'REQ-001', state: 'verified', sessionId: 'S01', deliveryHash: 'delivery-1', commitSha: head, testEvidenceIds: ['T1'], integrationRunId: 'I1', verificationRunId: 'V1' },
      { requirementId: 'REQ-002', state: 'tested', sessionId: 'S02', testEvidenceIds: ['T2'] }
    ],
    sessionDeliveryCoverage: [{ sessionId: 'S01', deliveryHash: 'delivery-1', valid: true }],
    integrationStatus: 'clean',
    verificationStatus: 'passed',
    unresolvedBlockers: [],
    outcomeUnknownCount: 1,
    finalIntegrationSha: head,
    verificationEvidence: ['V1'],
    completionPolicyRevision: 'v1',
    generatedAt: '2026-09-03T00:02:00.000Z'
  }
  const codes = validateGroupCompletionProof(proof, requirements, [delivery], [verification]).map(item => item.code)
  assert.ok(codes.includes('mandatory_unverified'))
  assert.ok(codes.includes('outcome_unknown'))
})

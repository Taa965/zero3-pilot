import assert from 'node:assert/strict'
import test from 'node:test'

import { ZERO3_DEVELOPMENT_DELIVERY_CONTRACT, type DevelopmentDelivery, type DevelopmentGroupPolicy, type DevelopmentRequirement, type DevelopmentSessionDefinition, type DevelopmentSessionRuntime, type IntegrationMilestone, type VerificationRun } from '../contracts/index.ts'
import { assertGroupCompletable, buildCompletionProof, buildRequirementEvidenceMatrix } from './index.ts'

const sha = 'cccccccccccccccccccccccccccccccccccccccc'
const requirement = { groupId: 'G1', requirementId: 'REQ-1', title: 'Feature', description: 'Feature', mandatory: true, acceptanceCriteria: ['works'], sourceAnchor: 'plan#1', dependencies: [] } as DevelopmentRequirement
const session = { groupId: 'G1', sessionId: 'S1', requirements: ['REQ-1'] } as DevelopmentSessionDefinition
const delivery: DevelopmentDelivery = { contract: ZERO3_DEVELOPMENT_DELIVERY_CONTRACT, groupId: 'G1', sessionId: 'S1', executionId: 'E1', status: 'completed', baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', headSha: sha, changedPaths: ['src/a.ts'], requirements: ['REQ-1'], testsAdded: [], testsExecuted: ['unit'], artifacts: [], knownIssues: [], downstreamNotes: [], deliveryHash: 'D1', createdAt: '2026-09-03T00:00:00.000Z' }
const integration: IntegrationMilestone = { integrationRunId: 'I1', groupId: 'G1', baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', headSha: sha, deliveryHashes: ['D1'], mergedSessionIds: ['S1'], status: 'merged', conflicts: [], createdAt: '2026-09-03T00:00:00.000Z' }
const verification: VerificationRun = { verificationRunId: 'V1', groupId: 'G1', integrationSha: sha, policyRevision: 'v1', commands: [], results: [], environment: {}, startedAt: '2026-09-03T00:00:00.000Z', finishedAt: '2026-09-03T00:01:00.000Z', status: 'passed' }
const runtime = { groupId: 'G1', sessionId: 'S1', executionId: 'E1', status: 'verified', attempt: 1, writerGeneration: 1, lastEventSequence: 1, updatedAt: '2026-09-03T00:00:00.000Z' } as DevelopmentSessionRuntime
const policy = { completionMode: 'strict', verificationPolicyRevision: 'v1' } as DevelopmentGroupPolicy

test('Requirement becomes verified only with valid Delivery + exact Integration + exact Verification', () => {
  const matrix = buildRequirementEvidenceMatrix({ requirements: [requirement], sessions: [session], deliveries: [delivery], validDeliveryHashes: new Set(['D1']), integrations: [integration], verifications: [verification], finalIntegrationSha: sha })
  assert.equal(matrix[0].state, 'verified')
  const noVerify = buildRequirementEvidenceMatrix({ requirements: [requirement], sessions: [session], deliveries: [delivery], validDeliveryHashes: new Set(['D1']), integrations: [integration], verifications: [], finalIntegrationSha: sha })
  assert.equal(noVerify[0].state, 'integrated')
})

test('complete proof passes only when every evidence class is closed', () => {
  const result = buildCompletionProof({ groupId: 'G1', policy, requirements: [requirement], sessions: [session], runtimes: [runtime], deliveries: [delivery], validDeliveryHashes: new Set(['D1']), integrations: [integration], verifications: [verification], finalIntegrationSha: sha, unresolvedBlockers: [] })
  assert.equal(result.issues.length, 0)
  assert.equal(assertGroupCompletable(result).verificationStatus, 'passed')
})

test('OutcomeUnknown or missing Session Delivery prevents completion', () => {
  const unknown = { ...runtime, status: 'outcome_unknown' as const }
  const result = buildCompletionProof({ groupId: 'G1', policy, requirements: [requirement], sessions: [session], runtimes: [unknown], deliveries: [], validDeliveryHashes: new Set(), integrations: [integration], verifications: [verification], finalIntegrationSha: sha, unresolvedBlockers: [] })
  assert.ok(result.issues.some(issue => issue.code === 'outcome_unknown'))
  assert.ok(result.issues.some(issue => issue.code === 'missing_session_delivery'))
})

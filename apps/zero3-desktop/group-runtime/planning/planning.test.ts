import assert from 'node:assert/strict'
import test from 'node:test'

import { PlanningValidationError, compilePlanningProposal, stablePlanHash } from './index.ts'

const baseline = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const policy = {
  maxParallelSessions: 5,
  maxSessionAttempts: 3,
  maxRepairSessions: 3,
  maxRepairWaves: 3,
  maxSameFailureAttempts: 2,
  maxSessionSubagents: 4,
  permissionProfile: 'standard' as const,
  completionMode: 'strict' as const,
  verificationPolicyRevision: 'v1',
  targetBranch: 'integration/development-group-v1',
  protectedPaths: ['package-lock.json', 'apps/zero3-desktop/package.json'],
  mandatoryTests: ['typecheck']
}
const request = {
  repository: 'Taa965/fixture',
  masterGoal: 'Implement twenty features',
  masterPrompt: 'Build the fixture project',
  developmentPlan: '20 feature modules',
  baselineSha: baseline,
  integrationRef: 'integration/development-group-v1',
  policy
}

function twentyRequirements() {
  return Array.from({ length: 20 }, (_, index) => {
    const bucket = Math.floor(index / 4)
    return {
      id: `REQ-${String(index + 1).padStart(3, '0')}`,
      title: `Feature ${index + 1}`,
      description: `Implement feature ${index + 1}`,
      acceptanceCriteria: [`feature ${index + 1} verified`],
      sourceAnchor: `plan#feature-${index + 1}`,
      pathHints: [`src/module-${bucket}/**`],
      tags: [`module-${bucket}`],
      dependencies: index > 0 && index % 4 === 0 ? [`REQ-${String(index).padStart(3, '0')}`] : []
    }
  })
}

test('stable plan hash ignores object key insertion order', () => {
  assert.equal(stablePlanHash({ b: 2, a: 1 }), stablePlanHash({ a: 1, b: 2 }))
})

test('20-feature deterministic fallback produces bounded sessions and multiple waves', () => {
  const plan = compilePlanningProposal(
    request,
    { requirements: twentyRequirements() },
    { groupId: 'G20', createdAt: '2026-09-03T00:00:00.000Z' }
  )
  assert.equal(plan.requirements.length, 20)
  assert.ok(plan.sessions.length >= 4 && plan.sessions.length <= 6)
  assert.ok(plan.waves.length >= 2)
  assert.equal(new Set(plan.sessions.flatMap(session => session.requirements)).size, 20)
  assert.ok(plan.sessions.every(session => session.subagentPolicy.maxConcurrency <= 4))
})

test('shared and protected paths never become freely owned', () => {
  const plan = compilePlanningProposal(
    request,
    {
      requirements: [
        { id: 'REQ-001', title: 'A', description: 'A', acceptanceCriteria: ['A'], sourceAnchor: 'a', pathHints: ['src/shared/**', 'apps/zero3-desktop/package.json'] },
        { id: 'REQ-002', title: 'B', description: 'B', acceptanceCriteria: ['B'], sourceAnchor: 'b', pathHints: ['src/shared/**', 'src/b/**'] }
      ],
      sessions: [
        { id: 'S01', objective: 'A', requirementIds: ['REQ-001'] },
        { id: 'S02', objective: 'B', requirementIds: ['REQ-002'] }
      ]
    },
    { groupId: 'G2', createdAt: '2026-09-03T00:00:00.000Z' }
  )
  assert.ok(plan.redZonePaths.includes('src/shared/**'))
  assert.ok(plan.sessions.every(session => !session.ownedPaths.includes('src/shared/**')))
  assert.ok(plan.sessions[0].forbiddenPaths.includes('apps/zero3-desktop/package.json'))
})

test('invalid controller proposal is rejected by frozen C1 validator', () => {
  assert.throws(
    () => compilePlanningProposal(
      request,
      {
        requirements: [
          { id: 'REQ-001', title: 'A', description: 'A', acceptanceCriteria: ['A'], sourceAnchor: 'a' },
          { id: 'REQ-002', title: 'B', description: 'B', acceptanceCriteria: ['B'], sourceAnchor: 'b' }
        ],
        sessions: [
          { id: 'S01', objective: 'A', requirementIds: ['REQ-001', 'REQ-002'], dependencies: ['S02'] },
          { id: 'S02', objective: 'B', requirementIds: ['REQ-002'], dependencies: ['S01'] }
        ]
      },
      { groupId: 'GBAD', createdAt: '2026-09-03T00:00:00.000Z' }
    ),
    PlanningValidationError
  )
})

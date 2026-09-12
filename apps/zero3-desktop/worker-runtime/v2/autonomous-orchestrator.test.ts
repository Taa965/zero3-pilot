import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { Zero3AgentLifecycleStore } from './lifecycle-store.ts'
import {
  buildAutonomousAgentDispatchRequest,
  createAutonomousPlanProposal,
  createBasicPlanProposal,
  decideAutonomousCandidate,
  evaluateAttentionBudget,
  evaluatePluginCapabilityBaseline,
  guardEventToCandidate,
  projectHumanAttention,
  projectExecutionGraph,
  projectDailyReview
} from './autonomous-orchestrator.ts'

test('v1.3 governance keeps warnings deferred unless explicitly blocking', () => {
  const warning = decideAutonomousCandidate({ entityType: 'warning', detail: { message: 'minor issue' }, sourceTaskId: null })
  assert.equal(warning.disposition, 'DEFER')
  const blocker = decideAutonomousCandidate({ entityType: 'warning', detail: { message: 'blocks root', blocking: true }, sourceTaskId: 'root' })
  assert.equal(blocker.disposition, 'INTERRUPT')
  assert.equal(blocker.mainlineImpact, 'interrupt')
})

test('v1.3 post-plugin capability gate fails closed until every required capability is advertised', () => {
  const missing = evaluatePluginCapabilityBaseline(['memory.shared.lifecycle'])
  assert.equal(missing.ready, false)
  assert.ok(missing.missing.includes('agent.dispatch.unified'))
  const ready = evaluatePluginCapabilityBaseline([
    'zero3.full-capability.web-gpt', 'agent.dispatch.unified', 'agent.dispatch.codex.full',
    'session.bootstrap.project', 'memory.shared.lifecycle'
  ])
  assert.equal(ready.ready, true)
})

test('v1.3 guard adapters produce intake candidates and never Tasks', () => {
  const candidate = guardEventToCandidate({ source: 'git', projectId: 'p1', eventRef: 'evt-1', kind: 'push_failed', message: 'push denied', blocking: true })
  assert.equal(candidate.entityType, 'blocker')
  assert.deepEqual(candidate.sourceRefs, ['evt-1'])
  assert.equal(candidate.detail.blocking, true)
})

test('v1.3 attention budget rejects recursive spawn deterministically', () => {
  const result = evaluateAttentionBudget({ childDepth: 5, parallelAutoTasks: 0, spawnedForRoot: 0, retries: 0, autonomousSessions: 0 })
  assert.equal(result.allowed, false)
  assert.match(result.reason ?? '', /maxChildDepth/)
})

test('v1.3 planner output is proposal-only and does not mutate execution authority', () => {
  const proposal = createBasicPlanProposal({
    proposalId: 'plan-1', projectId: 'p1', createdAt: '2026-09-12T00:00:00.000Z', intakes: [{
      sourceKey: 'ati-1', projectId: 'p1', entityType: 'blocker', entityId: 'b1', sourceTaskId: 'root', sourceVersion: 1,
      fingerprint: 'a'.repeat(64), taskId: null, detail: { title: 'Fix blocker' }, disposition: 'INTERRUPT',
      severity: 'blocking', firstSeenAt: '2026-09-12T00:00:00.000Z', lastSeenAt: '2026-09-12T00:00:00.000Z'
    }] as any })
  assert.equal(proposal.materialized, false)
  assert.equal(proposal.actions[0].type, 'EXECUTE')
})

test('v1.3 human attention projection references intake authority instead of creating an event store', () => {
  const items = projectHumanAttention([{ sourceKey: 'ati-1', projectId: 'p1', entityType: 'problem', entityId: 'x', sourceTaskId: null,
    sourceVersion: 1, fingerprint: 'b'.repeat(64), taskId: null, detail: {}, severity: 'high', humanAttentionReason: 'budget exceeded',
    firstSeenAt: '2026-09-12T00:00:00.000Z', lastSeenAt: '2026-09-12T00:00:00.000Z' }] as any)
  assert.deepEqual(items.map(item => item.reason), ['budget exceeded'])
})

test('v1.3 lifecycle store migrates legacy autonomous intake rows without losing them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zero3-v13-migration-'))
  const file = path.join(root, 'lifecycle.sqlite3')
  const legacy = new DatabaseSync(file)
  legacy.exec(`CREATE TABLE autonomous_task_intake (
    source_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    source_task_id TEXT, source_version INTEGER NOT NULL, fingerprint TEXT NOT NULL, task_id TEXT,
    detail_json TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    INSERT INTO autonomous_task_intake VALUES ('ati-old','p1','problem','old',NULL,1,'${'c'.repeat(64)}',NULL,'{}','2026-09-11','2026-09-11');`)
  legacy.close()
  const store = new Zero3AgentLifecycleStore(file)
  try {
    const old = store.getAutonomousIntake('ati-old')
    assert.equal(old?.category, null)
    store.upsertAutonomousIntake({ ...old!, category: 'legacy-problem', severity: 'normal', confidence: 0.8,
      affectedResources: ['repo:r'], mainlineImpact: 'parallel', disposition: 'PARALLEL', decisionReason: 'migrated',
      rootTaskId: 'root', parentTaskId: null, attentionCost: 'medium', sourceRefs: ['legacy'], at: '2026-09-12' })
    const migrated = store.getAutonomousIntake('ati-old')
    assert.equal(migrated?.category, 'legacy-problem')
    assert.deepEqual(migrated?.affectedResources, ['repo:r'])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

test('v1.3 execution graph and daily review remain projection-only', () => {
  const tasks = [{
    definition: { task: { taskId: 'root', projectId: 'p1', title: 'Root goal', metadata: {} } },
    runtime: { task: { status: 'running' }, sessionBindings: [] }
  }] as any
  const intakes = [{
    sourceKey: 'ati-x', projectId: 'p1', entityType: 'warning', entityId: 'w', sourceTaskId: 'root', sourceVersion: 1,
    fingerprint: 'd'.repeat(64), taskId: null, detail: { title: 'Deferred warning' }, disposition: 'DEFER', parentTaskId: 'root',
    firstSeenAt: '2026-09-12T00:00:00.000Z', lastSeenAt: '2026-09-12T00:00:00.000Z'
  }] as any
  const graph = projectExecutionGraph({ projectId: 'p1', tasks, intakes })
  assert.ok(graph.nodes.some(node => node.id === 'task:root'))
  assert.ok(graph.nodes.some(node => node.id === 'candidate:ati-x'))
  assert.ok(graph.edges.some(edge => edge.from === 'task:root' && edge.to === 'candidate:ati-x'))
  const review = projectDailyReview({ projectId: 'p1', generatedAt: '2026-09-12T00:00:00.000Z', tasks, intakes })
  assert.equal(review.userRootTasks, 1)
  assert.equal(review.discoveredCandidates, 1)
  assert.equal(review.dispositions.DEFER, 1)
})

test('v1.3 unified dispatch request preserves Execution identity while delegating executor selection', () => {
  const snapshot = {
    definition: {
      task: { taskId: 'goal-1', projectId: 'p1', workspace: 'C:/repo', workflowId: 'autonomous-root-goal', title: 'Goal', goal: 'Finish it', metadata: { autonomousRootGoal: true, importance: 'high' } },
      steps: [{ stepId: 'goal-work', title: 'Goal', objective: 'Finish it', executor: 'AUTO', requiredSkills: [], optionalSkills: [], expectedOutputs: [], completionGate: ['verified'], metadata: { requiredCapabilities: ['software.development'] } }]
    },
    runtime: { task: { lastEventSequence: 7 }, steps: [{ stepId: 'goal-work', skillPreflight: { executor: 'CODEX' } }] }
  } as any
  const request = buildAutonomousAgentDispatchRequest(snapshot, 'goal-work', 1, '2026-09-12T00:00:00.000Z')
  assert.equal(request.taskSpec.target, 'CODEX')
  assert.equal(request.taskSpec.projectId, 'p1')
  assert.deepEqual(request.taskSpec.requirements, ['software.development'])
  assert.equal(request.context.routingMode, 'PINNED')
})

test('v1.3 context-aware planner escalates missing capabilities without mutating tasks', () => {
  const proposal = createAutonomousPlanProposal({
    projectId: 'p1', rootTaskId: 'root', tasks: [], capabilities: [], generatedAt: '2026-09-12T00:00:00.000Z',
    intakes: [{ sourceKey: 'ati-cap', projectId: 'p1', entityType: 'blocker', entityId: 'cap', sourceTaskId: 'root', sourceVersion: 1,
      fingerprint: 'e'.repeat(64), taskId: null, detail: { title: 'Needs GPU', requiredCapabilities: ['video.generation'] }, disposition: 'INTERRUPT',
      severity: 'blocking', mainlineImpact: 'interrupt', firstSeenAt: '2026-09-12T00:00:00.000Z', lastSeenAt: '2026-09-12T00:00:00.000Z' }] as any
  })
  assert.equal(proposal.materialized, false)
  assert.equal(proposal.actions[0].type, 'ESCALATE')
  assert.match(proposal.actions[0].reason, /video.generation/)
})

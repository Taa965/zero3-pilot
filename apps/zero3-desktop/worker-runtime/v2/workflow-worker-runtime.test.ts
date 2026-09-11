import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3WorkflowWorkerStore } from './worker-store.ts'
import { Zero3WorkflowWorkerRuntime } from './workflow-worker-runtime.ts'

const SECRET = 'zero3-workflow-worker-test-secret-0123456789abcdef0123456789'
const CLOCK = new Date('2026-09-11T00:00:00.000Z')

function runtime(options: { defaultLeaseSeconds?: number } = {}) {
  const store = new Zero3WorkflowWorkerStore(':memory:')
  const worker = new Zero3WorkflowWorkerRuntime(store, {
    ticketSecret: SECRET,
    clock: () => new Date(CLOCK),
    defaultLeaseSeconds: options.defaultLeaseSeconds ?? 1800
  })
  return { store, worker }
}

function binding(workerSlotId = 'script-worker-01', maxBatchSize = 1, maxItemsPerPhysicalSession: number | null = null) {
  return {
    workflowRunId: 'run-001', moduleId: 'cognitive-store', moduleVersion: 'v2',
    workerDefinitionId: 'script-rewriter', workerSlotId, provider: 'GPT_WEB',
    requiredCapabilities: ['script-rewrite'], maxBatchSize,
    sessionPolicy: { maxItemsPerPhysicalSession, rotateOnContextRisk: true, rotateOnStall: true }
  }
}

function seedSingleStage(worker: Zero3WorkflowWorkerRuntime, count = 20) {
  worker.ensureWorkflowRun({ workflowRunId: 'run-001', taskId: 'task-001', moduleId: 'cognitive-store', moduleVersion: 'v2' })
  worker.ensureWorkerBinding({ binding: binding(), role: '脚本重构工位', promptRevision: 'script-worker.v4' })
  worker.addWorkItems({
    workflowRunId: 'run-001', idempotencyKey: 'seed-items',
    items: Array.from({ length: count }, (_, index) => ({
      workItemId: `item-${String(index + 1).padStart(2, '0')}`,
      title: `Script ${index + 1}`,
      stages: [{
        stageRunId: `stage-${String(index + 1).padStart(2, '0')}-script`,
        stageKey: 'script-rewrite', workerDefinitionId: 'script-rewriter',
        requiredCapability: 'script-rewrite', instruction: `Rewrite script ${index + 1}`,
        inputs: [], expectedOutputs: [{ logicalName: '重构脚本.md', kind: 'markdown', required: true }],
        policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: {}
      }]
    }))
  })
}

function artifactFor(claim: any, sessionId: string, suffix = '') {
  const unit = claim.units[0]
  return {
    artifactId: `art-${unit.stageRunId}${suffix}`,
    workflowRunId: 'run-001', workItemId: unit.workItemId, stageRunId: unit.stageRunId,
    logicalName: '重构脚本.md', kind: 'markdown',
    storage: { provider: 'GOOGLE_DRIVE', fileId: `drive-${unit.workItemId}${suffix}` },
    producer: { workerDefinitionId: 'script-rewriter', workerSlotId: 'script-worker-01', workerSessionId: sessionId }
  }
}

test('P2 single long-lived worker processes 20 WorkItems continuously', () => {
  const { store, worker } = runtime()
  try {
    seedSingleStage(worker, 20)
    const opened = worker.openPhysicalSession({ workerSlotId: 'script-worker-01', logicalSessionId: 'gpt-script-01' }) as any
    const boot = worker.bootstrapWorker({ bindingTicket: opened.ticket }) as any
    assert.equal(boot.activeClaim, null)
    let result = worker.claimWorkV2({ bindingTicket: opened.ticket, idempotencyKey: 'claim-1' }) as any
    let completed = 0
    while (result.state === 'CLAIMED') {
      const claim = result.claim ?? result.next?.claim
      completed += 1
      const commit = worker.commitAndClaimNext({
        bindingTicket: opened.ticket, claimId: claim.claimId,
        artifacts: [artifactFor(claim, opened.workerSessionId, `-${completed}`)],
        idempotencyKey: `commit-${completed}`
      }) as any
      result = commit.next
    }
    assert.equal(completed, 20)
    assert.equal(result.state, 'NO_WORK_AVAILABLE')
    const snapshot = worker.workflowSnapshot('run-001') as any
    assert.equal(snapshot.run.status, 'COMPLETED')
    assert.equal(snapshot.counts.workItemsCompleted, 20)
    assert.equal(snapshot.counts.stageRunsCompleted, 20)
  } finally { store.close() }
})

test('P2 two worker slots never claim the same StageRun', () => {
  const { store, worker } = runtime()
  try {
    worker.ensureWorkflowRun({ workflowRunId: 'run-001', taskId: 'task-001', moduleId: 'cognitive-store', moduleVersion: 'v2' })
    worker.ensureWorkerBinding({ binding: binding('script-worker-01', 5) })
    worker.ensureWorkerBinding({ binding: binding('script-worker-02', 5) })
    worker.addWorkItems({ workflowRunId: 'run-001', idempotencyKey: 'seed-parallel', items: Array.from({ length: 20 }, (_, i) => ({
      workItemId: `p-${i + 1}`, title: `Parallel ${i + 1}`,
      stages: [{ stageRunId: `p-${i + 1}-script`, stageKey: 'script-rewrite', workerDefinitionId: 'script-rewriter',
        requiredCapability: 'script-rewrite', instruction: 'rewrite', inputs: [], expectedOutputs: [],
        policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: {} }]
    })) })
    const a = worker.openPhysicalSession({ workerSlotId: 'script-worker-01', logicalSessionId: 'gpt-a' }) as any
    const b = worker.openPhysicalSession({ workerSlotId: 'script-worker-02', logicalSessionId: 'gpt-b' }) as any
    const ca = (worker.claimWorkV2({ bindingTicket: a.ticket, maxItems: 5, idempotencyKey: 'ca' }) as any).claim
    const cb = (worker.claimWorkV2({ bindingTicket: b.ticket, maxItems: 5, idempotencyKey: 'cb' }) as any).claim
    const ids = [...ca.units, ...cb.units].map((unit: any) => unit.stageRunId)
    assert.equal(ids.length, 10)
    assert.equal(new Set(ids).size, 10)
  } finally { store.close() }
})

test('P2 completing an upstream StageRun immediately releases its dependent StageRun', () => {
  const { store, worker } = runtime()
  try {
    worker.ensureWorkflowRun({ workflowRunId: 'run-001', taskId: 'task-001', moduleId: 'cognitive-store', moduleVersion: 'v2' })
    worker.ensureWorkerBinding({ binding: binding('script-worker-01', 1) })
    worker.ensureWorkerBinding({ binding: {
      ...binding('visual-worker-01', 1), workerDefinitionId: 'visual-planner', requiredCapabilities: ['visual-plan']
    } })
    worker.addWorkItems({ workflowRunId: 'run-001', idempotencyKey: 'seed-pipeline', items: [{
      workItemId: 'item-01', title: 'Pipeline item', stages: [
        { stageRunId: 'item-01-script', stageKey: 'script-rewrite', workerDefinitionId: 'script-rewriter', requiredCapability: 'script-rewrite',
          instruction: 'rewrite', inputs: [], expectedOutputs: [{ logicalName: '重构脚本.md', required: true }], policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: {} },
        { stageRunId: 'item-01-visual', stageKey: 'visual-plan', workerDefinitionId: 'visual-planner', requiredCapability: 'visual-plan',
          dependsOn: ['item-01-script'], instruction: 'plan visuals', inputs: [], expectedOutputs: [], policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: {} }
      ]
    }] })
    const s = worker.openPhysicalSession({ workerSlotId: 'script-worker-01', logicalSessionId: 'script' }) as any
    const v = worker.openPhysicalSession({ workerSlotId: 'visual-worker-01', logicalSessionId: 'visual' }) as any
    assert.equal((worker.claimWorkV2({ bindingTicket: v.ticket, idempotencyKey: 'v-before' }) as any).state, 'NO_WORK_AVAILABLE')
    const scriptClaim = (worker.claimWorkV2({ bindingTicket: s.ticket, idempotencyKey: 's-claim' }) as any).claim
    const commit = worker.commitAndClaimNext({ bindingTicket: s.ticket, claimId: scriptClaim.claimId,
      artifacts: [artifactFor(scriptClaim, s.workerSessionId, '-pipeline')], idempotencyKey: 's-done' }) as any
    assert.deepEqual(commit.releasedStages, ['item-01-visual'])
    const visual = worker.claimWorkV2({ bindingTicket: v.ticket, idempotencyKey: 'v-after' }) as any
    assert.equal(visual.state, 'CLAIMED')
    assert.equal(visual.claim.units[0].stageRunId, 'item-01-visual')
  } finally { store.close() }
})

test('P2 session rotation fences the old ticket generation', () => {
  const { store, worker } = runtime()
  try {
    worker.ensureWorkflowRun({ workflowRunId: 'run-001', taskId: 'task-001', moduleId: 'cognitive-store', moduleVersion: 'v2' })
    worker.ensureWorkerBinding({ binding: binding('script-worker-01', 1, 1) })
    worker.addWorkItems({ workflowRunId: 'run-001', idempotencyKey: 'seed-rotate', items: [{
      workItemId: 'r-1', title: 'Rotate', stages: [{ stageRunId: 'r-1-script', stageKey: 'script-rewrite',
        workerDefinitionId: 'script-rewriter', requiredCapability: 'script-rewrite', instruction: 'rewrite', inputs: [],
        expectedOutputs: [{ logicalName: '重构脚本.md', required: true }], policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: {} }]
    }] })
    const first = worker.openPhysicalSession({ workerSlotId: 'script-worker-01', logicalSessionId: 'old-session' }) as any
    const claim = (worker.claimWorkV2({ bindingTicket: first.ticket, idempotencyKey: 'old-claim' }) as any).claim
    const done = worker.commitAndClaimNext({ bindingTicket: first.ticket, claimId: claim.claimId,
      artifacts: [artifactFor(claim, first.workerSessionId, '-rotate')], idempotencyKey: 'old-done' }) as any
    assert.equal(done.rotateRequired, true)
    const rotated = worker.rotatePhysicalSession({ workerSlotId: 'script-worker-01', logicalSessionId: 'new-session', reason: 'item_limit' }) as any
    assert.equal(rotated.state, 'ROTATED')
    assert.equal(rotated.generation, 2)
    assert.throws(() => worker.recoverWorker({ bindingTicket: first.ticket }), /generation is stale|no longer active/)
    const recovered = worker.recoverWorker({ bindingTicket: rotated.ticket }) as any
    assert.equal(recovered.slot.generation, 2)
  } finally { store.close() }
})

test('P2 expired lease requeues work for another worker slot', () => {
  const { store, worker } = runtime({ defaultLeaseSeconds: 10 })
  try {
    worker.ensureWorkflowRun({ workflowRunId: 'run-001', taskId: 'task-001', moduleId: 'cognitive-store', moduleVersion: 'v2' })
    worker.ensureWorkerBinding({ binding: binding('script-worker-01', 1) })
    worker.ensureWorkerBinding({ binding: binding('script-worker-02', 1) })
    worker.addWorkItems({ workflowRunId: 'run-001', idempotencyKey: 'seed-expire', items: [{
      workItemId: 'e-1', title: 'Expire', stages: [{ stageRunId: 'e-1-script', stageKey: 'script-rewrite', workerDefinitionId: 'script-rewriter',
        requiredCapability: 'script-rewrite', instruction: 'rewrite', inputs: [], expectedOutputs: [], policy: { maxAttempts: 3, leaseSeconds: 10 }, metadata: {} }]
    }] })
    const first = worker.openPhysicalSession({ workerSlotId: 'script-worker-01', logicalSessionId: 'expire-a' }) as any
    const second = worker.openPhysicalSession({ workerSlotId: 'script-worker-02', logicalSessionId: 'expire-b' }) as any
    const original = (worker.claimWorkV2({ bindingTicket: first.ticket, leaseSeconds: 10, idempotencyKey: 'expire-claim-a' }) as any).claim
    const expired = worker.expireLeases({ workflowRunId: 'run-001', at: '2026-09-11T00:00:11.000Z' }) as any
    assert.deepEqual(expired.expiredClaimIds, [original.claimId])
    const reclaimed = worker.claimWorkV2({ bindingTicket: second.ticket, idempotencyKey: 'expire-claim-b' }) as any
    assert.equal(reclaimed.state, 'CLAIMED')
    assert.equal(reclaimed.claim.units[0].stageRunId, 'e-1-script')
  } finally { store.close() }
})

test('P5 READY queue 0->1 creates one deduped wakeup and claimed work suppresses it', () => {
  const { store, worker } = runtime()
  try {
    worker.ensureWorkflowRun({ workflowRunId: 'run-001', taskId: 'task-001', moduleId: 'cognitive-store', moduleVersion: 'v2' })
    worker.ensureWorkerBinding({ binding: binding('script-worker-01', 1) })
    worker.ensureWorkerBinding({ binding: {
      ...binding('visual-worker-01', 1), workerDefinitionId: 'visual-planner', requiredCapabilities: ['visual-plan']
    } })
    worker.addWorkItems({ workflowRunId: 'run-001', idempotencyKey: 'seed-wakeup', items: [{
      workItemId: 'wake-item', title: 'Wake item', stages: [
        { stageRunId: 'wake-script', stageKey: 'script-rewrite', workerDefinitionId: 'script-rewriter', requiredCapability: 'script-rewrite',
          instruction: 'rewrite', inputs: [], expectedOutputs: [{ logicalName: '重构脚本.md', required: true }], policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: {} },
        { stageRunId: 'wake-visual', stageKey: 'visual-plan', workerDefinitionId: 'visual-planner', requiredCapability: 'visual-plan',
          dependsOn: ['wake-script'], instruction: 'visual', inputs: [], expectedOutputs: [], policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: {} }
      ]
    }] })
    const visual = worker.openPhysicalSession({ workerSlotId: 'visual-worker-01', logicalSessionId: 'gpt-visual-entry' }) as any
    assert.equal((worker.claimWorkV2({ bindingTicket: visual.ticket, idempotencyKey: 'visual-wait' }) as any).state, 'NO_WORK_AVAILABLE')
    const script = worker.openPhysicalSession({ workerSlotId: 'script-worker-01', logicalSessionId: 'gpt-script-entry' }) as any
    const scriptClaim = (worker.claimWorkV2({ bindingTicket: script.ticket, idempotencyKey: 'script-claim-wakeup' }) as any).claim
    worker.commitAndClaimNext({ bindingTicket: script.ticket, claimId: scriptClaim.claimId,
      artifacts: [artifactFor(scriptClaim, script.workerSessionId, '-wakeup')], idempotencyKey: 'script-complete-wakeup' })
    const first = worker.pendingWakeups()
    const second = worker.pendingWakeups()
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.equal(first[0].wakeupId, second[0].wakeupId)
    assert.equal(first[0].logicalSessionId, 'gpt-visual-entry')
    assert.equal((worker.claimWorkV2({ bindingTicket: visual.ticket, idempotencyKey: 'visual-claims-ready' }) as any).state, 'CLAIMED')
    assert.deepEqual(worker.pendingWakeups(), [])
  } finally { store.close() }
})

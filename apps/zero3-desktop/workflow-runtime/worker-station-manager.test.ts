import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3WorkflowWorkerStore } from '../worker-runtime/v2/worker-store.ts'
import { Zero3WorkflowWorkerRuntime } from '../worker-runtime/v2/workflow-worker-runtime.ts'
import { installCognitiveStoreWorkflow, type CognitiveStoreSource } from './cognitive-store-module.ts'
import { Zero3WorkerStationManager, type WorkerStationGptPort } from './worker-station-manager.ts'

const SECRET = 'zero3-station-manager-test-secret-0123456789abcdef0123456789'
const CLOCK = new Date('2026-09-11T00:00:00.000Z')

function setup() {
  const store = new Zero3WorkflowWorkerStore(':memory:')
  const worker = new Zero3WorkflowWorkerRuntime(store, { ticketSecret: SECRET, clock: () => new Date(CLOCK) })
  return { store, worker }
}

function source(): CognitiveStoreSource {
  return {
    workItemId: 'script-01',
    title: 'Script 01',
    chapterImageCounts: [8],
    sourceArtifact: {
      artifactId: 'source-01', workflowRunId: 'source-run', workItemId: 'script-01', stageRunId: 'source-stage',
      logicalName: 'script-01.txt', kind: 'text', storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-source-01' },
      producer: { workerDefinitionId: 'source', workerSlotId: 'source-01', workerSessionId: 'source-session' }
    }
  }
}
function fakeGpt() {
  const created: string[] = []
  const sent: Array<{ entryId: string; message: string }> = []
  const gpt: WorkerStationGptPort = {
    async create() {
      const id = `gpt-web-${created.length + 1}`
      created.push(id)
      return { id, conversationUrl: null }
    },
    async sendWakeup(entryId, message) {
      sent.push({ entryId, message })
      return { sent: true }
    },
    async executionStatus() { return { executing: false, health: null } }
  }
  return { gpt, created, sent }
}

test('Station Manager auto-creates three GPT stations and injects versioned bootstrap prompts', async () => {
  const { store, worker } = setup()
  try {
    installCognitiveStoreWorkflow(worker, {
      workflowRunId: 'cognitive-run', taskId: 'task-01', projectId: 'project-01',
      sources: [source()], idempotencyKey: 'install'
    })
    const fake = fakeGpt()
    const manager = new Zero3WorkerStationManager(worker, fake.gpt)
    await manager.tick()
    assert.deepEqual(fake.created, ['gpt-web-1', 'gpt-web-2', 'gpt-web-3'])
    assert.equal(fake.sent.length, 3)
    assert.equal(fake.sent.every(item => item.message.includes('bootstrap_worker')), true)
    assert.equal(fake.sent.some(item => item.message.includes('认知便利店脚本重构工位')), true)
    assert.equal(fake.sent.some(item => item.message.includes('认知便利店视觉规划工位')), true)
    assert.equal(fake.sent.some(item => item.message.includes('认知便利店图片生产工位')), true)
    const snapshot = worker.workflowSnapshot('cognitive-run') as any
    for (const slot of snapshot.slots) {
      assert.equal(slot.activeSession.state, 'STARTING')
      const issued = worker.issueBindingTicket(slot.slot.workerSlotId) as any
      worker.bootstrapWorker({ bindingTicket: issued.ticket })
    }
    await manager.tick()
    assert.equal(fake.created.length, 3)
    assert.equal(fake.sent.length, 3)
  } finally { store.close() }
})

test('Station Manager rotates a completed physical session and injects a new generation ticket', async () => {
  const { store, worker } = setup()
  try {
    worker.ensureWorkflowRun({
      workflowRunId: 'run-rotate', taskId: 'task-rotate', moduleId: 'test-module', moduleVersion: 'v1',
      metadata: { projectId: 'project-rotate', autoProvisionGptWorkers: true }
    })
    worker.ensureWorkerBinding({
      binding: {
        workflowRunId: 'run-rotate', moduleId: 'test-module', moduleVersion: 'v1',
        workerDefinitionId: 'script-rewriter', workerSlotId: 'rotate-slot', provider: 'GPT_WEB',
        requiredCapabilities: ['script-rewrite'], maxBatchSize: 1,
        sessionPolicy: { maxItemsPerPhysicalSession: 1, rotateOnContextRisk: true, rotateOnStall: true }
      },
      role: '轮换测试工位', promptRevision: 'zero3-worker-default.v1'
    })
    worker.addWorkItems({
      workflowRunId: 'run-rotate', idempotencyKey: 'seed-rotate', items: [1, 2].map(index => ({
        workItemId: `item-${index}`, title: `Rotate Item ${index}`, stages: [{
          stageRunId: `item-${index}-script`, stageKey: 'script-rewrite', workerDefinitionId: 'script-rewriter',
          requiredCapability: 'script-rewrite', instruction: 'rewrite', inputs: [], expectedOutputs: [],
          policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: {}
        }]
      }))
    })
    const fake = fakeGpt()
    const manager = new Zero3WorkerStationManager(worker, fake.gpt)
    await manager.tick()
    assert.equal(fake.created.length, 1)
    const firstTicket = (worker.issueBindingTicket('rotate-slot') as any).ticket
    worker.bootstrapWorker({ bindingTicket: firstTicket })
    const claim = (worker.claimWorkV2({ bindingTicket: firstTicket, idempotencyKey: 'claim' }) as any).claim
    const done = worker.commitAndClaimNext({
      bindingTicket: firstTicket, claimId: claim.claimId, artifacts: [], idempotencyKey: 'done'
    }) as any
    assert.equal(done.rotateRequired, true)

    await manager.tick()
    assert.equal(fake.created.length, 2)
    assert.equal(fake.sent.length, 2)
    const snapshot = worker.workflowSnapshot('run-rotate') as any
    assert.equal(snapshot.slots[0].slot.generation, 2)
    assert.equal(snapshot.slots[0].activeSession.logicalSessionId, 'gpt-web-2')
    assert.equal(snapshot.slots[0].activeSession.state, 'STARTING')
    assert.throws(() => worker.recoverWorker({ bindingTicket: firstTicket }), /generation is stale|no longer active/)
    assert.equal(fake.sent[1].message.includes('WorkerSlot：rotate-slot'), true)
  } finally { store.close() }
})

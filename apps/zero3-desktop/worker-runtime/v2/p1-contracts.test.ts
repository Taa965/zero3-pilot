import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3WorkerProtocol } from '../worker-protocol.mjs'
import {
  adaptV1WorkUnitToV2,
  adaptV2ArtifactToV1Ref,
  issueWorkerBindingTicket,
  nextWorkerGeneration,
  normalizePhysicalWorkerSession,
  normalizeWorkflowArtifactRef,
  normalizeWorkflowWorkUnit,
  normalizeWorkflowWorkerBinding,
  verifyWorkerBindingTicket,
  type PhysicalWorkerSession,
  type WorkflowWorkerBinding
} from './index.ts'

const SECRET = 'zero3-worker-ticket-test-secret-0123456789abcdef0123456789'
const NOW = new Date('2026-09-11T00:00:00.000Z')

function binding(): WorkflowWorkerBinding {
  return {
    workflowRunId: 'run-001',
    moduleId: 'cognitive-store',
    moduleVersion: 'v2',
    workerDefinitionId: 'script-rewriter',
    workerSlotId: 'script-rewriter-01',
    provider: 'GPT_WEB',
    requiredCapabilities: ['script-rewrite'],
    maxBatchSize: 1,
    sessionPolicy: {
      maxItemsPerPhysicalSession: 10,
      rotateOnContextRisk: true,
      rotateOnStall: true
    }
  }
}

function session(generation = 3): PhysicalWorkerSession {
  return {
    workerSlotId: 'script-rewriter-01',
    workerSessionId: `gptws-00${generation}`,
    logicalSessionId: `chatgpt-script-${generation}`,
    conversationId: `conv-${generation}`,
    conversationUrl: `https://chatgpt.com/c/conv-${generation}`,
    generation,
    state: 'ACTIVE',
    processedItemCount: 0,
    startedAt: NOW.toISOString()
  }
}

function inputArtifact() {
  return normalizeWorkflowArtifactRef({
    artifactId: 'art-input-003', workflowRunId: 'run-001', workItemId: 'item-003',
    stageRunId: 'stage-item003-source', logicalName: '博弈论.txt', kind: 'text',
    storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-file-id-003' },
    producer: {
      workerDefinitionId: 'source-importer', workerSlotId: 'source-importer-01', workerSessionId: 'source-session-01'
    }
  })
}

test('P1 schemas normalize long-lived binding, physical session, WorkUnit v2 and Artifact v2', () => {
  const normalizedBinding = normalizeWorkflowWorkerBinding(binding())
  const normalizedSession = normalizePhysicalWorkerSession(session())
  const work = normalizeWorkflowWorkUnit({
    workItemId: 'item-003', stageRunId: 'stage-item003-script', title: '博弈论',
    instruction: '调用认知便利店脚本 Skill 完成重构',
    skill: { id: 'cognitive-store-script', revision: 'v4' },
    inputs: [inputArtifact()],
    expectedOutputs: [{ logicalName: '重构脚本.md', kind: 'markdown', required: true }],
    policy: { maxAttempts: 3, leaseSeconds: 1800 }, metadata: { chapterCount: 5 }
  })
  assert.equal(normalizedBinding.workerSlotId, 'script-rewriter-01')
  assert.equal(normalizedSession.generation, 3)
  assert.equal(work.inputs[0].storage.provider, 'GOOGLE_DRIVE')
  assert.equal(work.expectedOutputs[0].required, true)
  assert.throws(() => normalizeWorkflowArtifactRef({
    ...inputArtifact(), storage: { provider: 'GOOGLE_DRIVE' }
  }), /requires fileId/)
})

test('Binding Ticket is scoped to one worker slot/session and allowed capability', () => {
  const issued = issueWorkerBindingTicket(binding(), session(), {
    secret: SECRET, clock: () => NOW, expiresInSeconds: 3600
  })
  const claims = verifyWorkerBindingTicket(issued.ticket, {
    secret: SECRET, clock: () => new Date(NOW.getTime() + 1000),
    expected: {
      workflowRunId: 'run-001', workerDefinitionId: 'script-rewriter',
      workerSlotId: 'script-rewriter-01', workerSessionId: 'gptws-003',
      provider: 'GPT_WEB', generation: 3, requiredCapability: 'script-rewrite'
    }
  })
  assert.equal(claims.generation, 3)
  assert.throws(() => verifyWorkerBindingTicket(issued.ticket, {
    secret: SECRET, clock: () => NOW,
    expected: { workerSlotId: 'visual-worker-01' }
  }), /scope mismatch/)
  assert.throws(() => verifyWorkerBindingTicket(issued.ticket, {
    secret: SECRET, clock: () => NOW,
    expected: { requiredCapability: 'visual-plan' }
  }), /does not allow capability/)
})

test('generation fencing rejects a rotated physical session ticket', () => {
  const oldTicket = issueWorkerBindingTicket(binding(), session(3), { secret: SECRET, clock: () => NOW }).ticket
  assert.equal(nextWorkerGeneration(3), 4)
  assert.throws(() => verifyWorkerBindingTicket(oldTicket, {
    secret: SECRET, clock: () => NOW,
    expected: { workerSlotId: 'script-rewriter-01', generation: 4 }
  }), /generation is stale/)
  const newTicket = issueWorkerBindingTicket(binding(), session(4), { secret: SECRET, clock: () => NOW }).ticket
  const claims = verifyWorkerBindingTicket(newTicket, {
    secret: SECRET, clock: () => NOW,
    expected: { workerSlotId: 'script-rewriter-01', workerSessionId: 'gptws-004', generation: 4 }
  })
  assert.equal(claims.generation, 4)
})

test('ticket signature and expiry fail closed', () => {
  const issued = issueWorkerBindingTicket(binding(), session(), {
    secret: SECRET, clock: () => NOW, expiresInSeconds: 60
  })
  const tampered = `${issued.ticket.slice(0, -1)}${issued.ticket.endsWith('A') ? 'B' : 'A'}`
  assert.throws(() => verifyWorkerBindingTicket(tampered, { secret: SECRET, clock: () => NOW }), /signature is invalid/)
  assert.throws(() => verifyWorkerBindingTicket(issued.ticket, {
    secret: SECRET, clock: () => new Date(NOW.getTime() + 61_000)
  }), /has expired/)
})

test('v1 compatibility adapter preserves legacy unit semantics without changing v1 runtime', () => {
  const context = {
    workflowRunId: 'run-legacy', taskId: 'task-legacy', stepId: 'images',
    workerDefinitionId: 'legacy-image-worker', workerSlotId: 'legacy-slot-01',
    workerSessionId: 'legacy-session-01'
  }
  const adapted = adaptV1WorkUnitToV2({
    unitId: 'U001', ordinal: 1, title: 'Legacy Image',
    payload: { prompt: 'draw a diagram', expectedOutputs: [{ logicalName: 'U001.png', required: true }] },
    maxAttempts: 3, artifactRefs: ['chatgpt://asset/U001']
  }, context)
  assert.equal(adapted.workItemId, 'U001')
  assert.equal(adapted.instruction, 'draw a diagram')
  assert.equal(adapted.inputs[0].storage.uri, 'chatgpt://asset/U001')
  assert.equal(adaptV2ArtifactToV1Ref(adapted.inputs[0]), 'chatgpt://asset/U001')

  const v1 = new Zero3WorkerProtocol(':memory:')
  try {
    v1.ensureStage({ taskId: 'task-legacy', stepId: 'images', assignmentId: 'asg-legacy', requiredCapability: 'image_generation' })
    v1.addWorkUnits({ taskId: 'task-legacy', stepId: 'images', units: [{ unitId: 'U001', payload: { prompt: 'draw a diagram' } }] })
    const worker = v1.registerWorker({
      taskId: 'task-legacy', stepId: 'images', assignmentId: 'asg-legacy', workerType: 'chatgpt_web',
      capabilities: ['image_generation'], maxBatchSize: 10, logicalSessionId: 'legacy-gpt', idempotencyKey: 'register-legacy'
    })
    const claimed = v1.claimWork({ ...worker, idempotencyKey: 'claim-legacy' })
    assert.equal(claimed.state, 'CLAIMED')
    assert.equal(claimed.claim.units[0].unitId, 'U001')
  } finally {
    v1.close()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3WorkflowWorkerStore } from '../worker-runtime/v2/worker-store.ts'
import { Zero3WorkflowWorkerRuntime } from '../worker-runtime/v2/workflow-worker-runtime.ts'
import {
  cognitiveStoreImageBatches,
  cognitiveStoreWorkItem,
  installCognitiveStoreWorkflow,
  type CognitiveStoreSource
} from './cognitive-store-module.ts'

const SECRET = 'zero3-cognitive-store-test-secret-0123456789abcdef0123456789'
const CLOCK = new Date('2026-09-11T00:00:00.000Z')

function runtime() {
  const store = new Zero3WorkflowWorkerStore(':memory:')
  const worker = new Zero3WorkflowWorkerRuntime(store, {
    ticketSecret: SECRET,
    clock: () => new Date(CLOCK),
    defaultLeaseSeconds: 1800
  })
  return { store, worker }
}

function openSession(worker: Zero3WorkflowWorkerRuntime, input: Record<string, unknown>) {
  const opened = worker.openPhysicalSession(input) as any
  worker.bootstrapWorker({ bindingTicket: opened.ticket })
  return opened
}

function source(index: number, chapterImageCounts = [8]): CognitiveStoreSource {
  const workItemId = `script-${String(index).padStart(2, '0')}`
  return {
    workItemId,
    title: `Script ${index}`,
    chapterImageCounts,
    sourceArtifact: {
      artifactId: `source-art-${index}`,
      workflowRunId: 'source-run',
      workItemId,
      stageRunId: `${workItemId}:source`,
      logicalName: `${workItemId}.txt`,
      kind: 'text',
      mimeType: 'text/plain',
      storage: { provider: 'GOOGLE_DRIVE', fileId: `drive-source-${index}` },
      producer: {
        workerDefinitionId: 'source-importer',
        workerSlotId: 'source-importer-01',
        workerSessionId: 'source-session-01'
      }
    }
  }
}

function artifact(unit: any, producer: { workerDefinitionId: string; workerSlotId: string; workerSessionId: string }, logicalName: string, kind: string) {
  return {
    artifactId: `art-${unit.stageRunId}`,
    workflowRunId: 'cognitive-run',
    workItemId: unit.workItemId,
    stageRunId: unit.stageRunId,
    logicalName,
    kind,
    storage: { provider: 'GOOGLE_DRIVE', fileId: `drive-${unit.stageRunId}` },
    producer
  }
}

test('P6 image batching keeps the 10-image limit inside the Cognitive Store module', () => {
  assert.deepEqual(cognitiveStoreImageBatches(8), [8])
  assert.deepEqual(cognitiveStoreImageBatches(17), [10, 7])
  assert.deepEqual(cognitiveStoreImageBatches(23), [10, 10, 3])
})

test('P6 installs 20 scripts and the three fixed long-lived worker stations', () => {
  const { store, worker } = runtime()
  try {
    const sources = Array.from({ length: 20 }, (_, index) => {
      if (index === 1) return source(index + 1, [17])
      if (index === 2) return source(index + 1, [23])
      return source(index + 1, [8])
    })
    const installed = installCognitiveStoreWorkflow(worker, {
      workflowRunId: 'cognitive-run',
      taskId: 'task-cognitive-20',
      projectId: 'project-cognitive',
      sources,
      idempotencyKey: 'install-20'
    }) as any
    assert.deepEqual(installed.bindings, ['script-worker-01', 'visual-worker-01', 'image-worker-01'])
    assert.equal(installed.snapshot.items.length, 20)
    assert.equal(installed.snapshot.slots.length, 3)
    assert.equal(installed.snapshot.counts.workItemsTotal, 20)
    assert.equal(installed.snapshot.counts.stageRunsReady, 20)
    const item = cognitiveStoreWorkItem(sources[2]) as any
    const batches = item.stages.filter((stage: any) => stage.stageKey === 'image-chapter-batch')
    assert.deepEqual(batches.map((stage: any) => stage.metadata.imageCount), [10, 10, 3])
    assert.equal(batches.every((stage: any) => stage.expectedOutputs.length <= 10), true)
    const packageStage = item.stages.find((stage: any) => stage.stageKey === 'image-package')
    assert.equal(packageStage.dependsOn.length, 4)
  } finally {
    store.close()
  }
})

test('P6 Script -> Visual -> Image claims receive upstream artifacts without scanning Drive', () => {
  const { store, worker } = runtime()
  try {
    installCognitiveStoreWorkflow(worker, {
      workflowRunId: 'cognitive-run',
      taskId: 'task-cognitive-one',
      projectId: 'project-cognitive',
      sources: [source(1, [8])],
      idempotencyKey: 'install-one'
    })
    const script = openSession(worker, { workerSlotId: 'script-worker-01', logicalSessionId: 'gpt-script' }) as any
    const visual = openSession(worker, { workerSlotId: 'visual-worker-01', logicalSessionId: 'gpt-visual' }) as any
    const image = openSession(worker, { workerSlotId: 'image-worker-01', logicalSessionId: 'gpt-image' }) as any

    const scriptClaim = (worker.claimWorkV2({ bindingTicket: script.ticket, idempotencyKey: 'script-claim' }) as any).claim
    const scriptUnit = scriptClaim.units[0]
    const scriptArtifact = artifact(scriptUnit, {
      workerDefinitionId: 'script-rewriter',
      workerSlotId: 'script-worker-01',
      workerSessionId: script.workerSessionId
    }, '重构脚本.md', 'markdown')
    worker.commitAndClaimNext({
      bindingTicket: script.ticket,
      claimId: scriptClaim.claimId,
      artifacts: [scriptArtifact],
      idempotencyKey: 'script-done'
    })

    const visualClaim = (worker.claimWorkV2({ bindingTicket: visual.ticket, idempotencyKey: 'visual-claim' }) as any).claim
    const visualUnit = visualClaim.units[0]
    assert.equal(visualUnit.stageKey, 'visual-plan')
    assert.equal(visualUnit.inputs.some((item: any) => item.artifactId === scriptArtifact.artifactId), true)

    const visualArtifact = artifact(visualUnit, {
      workerDefinitionId: 'visual-planner',
      workerSlotId: 'visual-worker-01',
      workerSessionId: visual.workerSessionId
    }, '完整视觉规划.md', 'markdown')
    worker.commitAndClaimNext({
      bindingTicket: visual.ticket,
      claimId: visualClaim.claimId,
      artifacts: [visualArtifact],
      idempotencyKey: 'visual-done'
    })

    const imageClaim = (worker.claimWorkV2({ bindingTicket: image.ticket, idempotencyKey: 'image-claim' }) as any).claim
    const imageUnit = imageClaim.units[0]
    assert.equal(imageUnit.stageKey, 'image-overview')
    assert.equal(imageUnit.inputs.some((item: any) => item.artifactId === visualArtifact.artifactId), true)
  } finally {
    store.close()
  }
})

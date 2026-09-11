import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorkflowArtifactRef } from '../worker-runtime/v2/contracts.ts'
import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'
import { buildWorkflowWorkerBindings } from './worker-v2-adapter.ts'
import { Zero3WorkflowWorkerQueueService } from './workflow-worker-queue.ts'

function runtimeWithScripts(count: number, scriptWorkers = 1) {
  const store = new Zero3WorkflowStore(':memory:')
  const runtime = new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry())
  const snapshot = runtime.createRun({
    moduleId: 'cognitive-store-video',
    input: {
      projectId: 'zero3',
      scripts: Array.from({ length: count }, (_, index) => ({ title: `脚本${index + 1}`, driveFileId: `drive-${index + 1}` })),
      workers: { script: scriptWorkers, visual: 1, image: 1 }
    }
  })
  return { store, runtime, snapshot }
}

function outputArtifact(args: {
  runId: string
  itemId: string
  stageRunId: string
  workerDefinitionId: string
  workerSlotId: string
  workerSessionId: string
  suffix?: string
}): WorkflowArtifactRef {
  return {
    artifactId: `artifact-${args.itemId}-${args.suffix ?? 'script'}`,
    workflowRunId: args.runId,
    workItemId: args.itemId,
    stageRunId: args.stageRunId,
    logicalName: '重构脚本.md',
    kind: 'markdown',
    mimeType: 'text/markdown',
    storage: { provider: 'GOOGLE_DRIVE', fileId: `drive-output-${args.itemId}` },
    producer: {
      workerDefinitionId: args.workerDefinitionId,
      workerSlotId: args.workerSlotId,
      workerSessionId: args.workerSessionId
    }
  }
}

test('two workflow worker slots atomically claim distinct WorkItems and recover their active claims', () => {
  const { store, runtime, snapshot } = runtimeWithScripts(4, 2)
  try {
    const bindings = buildWorkflowWorkerBindings(snapshot).filter(value => value.workerDefinitionId === 'script-worker')
    const queue = new Zero3WorkflowWorkerQueueService(runtime, { verify: async () => true })
    const first = queue.claimNext(bindings[0], 'session-1')
    const second = queue.claimNext(bindings[1], 'session-2')
    assert.equal(first.state, 'CLAIMED')
    assert.equal(second.state, 'CLAIMED')
    if (first.state !== 'CLAIMED' || second.state !== 'CLAIMED') return
    assert.notEqual(first.workUnit.workItemId, second.workUnit.workItemId)
    const recovered = queue.claimNext(bindings[0], 'session-1')
    assert.equal(recovered.state, 'CLAIMED')
    if (recovered.state === 'CLAIMED') assert.equal(recovered.stage.stageRunId, first.stage.stageRunId)
  } finally { store.close() }
})

test('commit verifies scoped Drive artifacts, releases only the same item downstream and claims the next script', async () => {
  const { store, runtime, snapshot } = runtimeWithScripts(3, 1)
  try {
    const binding = buildWorkflowWorkerBindings(snapshot).find(value => value.workerDefinitionId === 'script-worker')!
    const queue = new Zero3WorkflowWorkerQueueService(runtime, { verify: async artifact => artifact.storage.provider === 'GOOGLE_DRIVE' })
    const claimed = queue.claimNext(binding, 'session-1')
    assert.equal(claimed.state, 'CLAIMED')
    if (claimed.state !== 'CLAIMED') return
    const artifact = outputArtifact({
      runId: binding.workflowRunId,
      itemId: claimed.stage.itemId,
      stageRunId: claimed.stage.stageRunId,
      workerDefinitionId: binding.workerDefinitionId,
      workerSlotId: binding.workerSlotId,
      workerSessionId: 'session-1'
    })
    const committed = await queue.commitAndClaimNext(binding, 'session-1', claimed.stage.stageRunId, [artifact])
    assert.equal(committed.state, 'COMPLETED')
    assert.equal(committed.replayed, false)
    assert.equal(committed.next.state, 'CLAIMED')
    if (committed.next.state === 'CLAIMED') assert.notEqual(committed.next.stage.itemId, claimed.stage.itemId)
    const after = runtime.getRun(binding.workflowRunId)
    assert.equal(after.stages.find(stage => stage.itemId === claimed.stage.itemId && stage.stageId === 'script-rewrite')?.status, 'COMPLETED')
    assert.equal(after.stages.find(stage => stage.itemId === claimed.stage.itemId && stage.stageId === 'visual-plan')?.status, 'READY')
    assert.equal(after.artifacts.some(value => value.artifactId === artifact.artifactId && value.state === 'VERIFIED'), true)
  } finally { store.close() }
})

test('worker output producer scope and storage verification fail closed', async () => {
  const { store, runtime, snapshot } = runtimeWithScripts(1, 1)
  try {
    const binding = buildWorkflowWorkerBindings(snapshot).find(value => value.workerDefinitionId === 'script-worker')!
    const queue = new Zero3WorkflowWorkerQueueService(runtime, { verify: async () => false })
    const claimed = queue.claimNext(binding, 'session-1')
    assert.equal(claimed.state, 'CLAIMED')
    if (claimed.state !== 'CLAIMED') return
    const artifact = outputArtifact({
      runId: binding.workflowRunId,
      itemId: claimed.stage.itemId,
      stageRunId: claimed.stage.stageRunId,
      workerDefinitionId: binding.workerDefinitionId,
      workerSlotId: binding.workerSlotId,
      workerSessionId: 'session-1'
    })
    await assert.rejects(
      queue.commitAndClaimNext(binding, 'session-1', claimed.stage.stageRunId, [{ ...artifact, producer: { ...artifact.producer, workerSlotId: 'wrong-slot' } }]),
      /producer does not match/
    )
    const failed = await queue.commitAndClaimNext(binding, 'session-1', claimed.stage.stageRunId, [artifact])
    assert.equal(failed.state, 'FIX_REQUIRED')
    const after = runtime.getRun(binding.workflowRunId)
    assert.equal(after.stages.find(stage => stage.stageRunId === claimed.stage.stageRunId)?.status, 'FIX_REQUIRED')
    assert.equal(after.stages.find(stage => stage.itemId === claimed.stage.itemId && stage.stageId === 'visual-plan')?.status, 'WAITING_DEPENDENCY')
  } finally { store.close() }
})

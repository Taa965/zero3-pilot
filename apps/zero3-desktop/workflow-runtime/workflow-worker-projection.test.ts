import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3WorkflowWorkerStore } from '../worker-runtime/v2/worker-store.ts'
import { Zero3WorkflowWorkerRuntime } from '../worker-runtime/v2/workflow-worker-runtime.ts'
import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'
import { buildWorkflowWorkerBindings } from './worker-v2-adapter.ts'
import { Zero3WorkflowWorkerProjectionService } from './workflow-worker-projection.ts'
import { Zero3WorkflowWorkerQueueService } from './workflow-worker-queue.ts'

const SECRET = 'projection-test-worker-binding-secret-0123456789abcdef0123456789'

function admin(worker: Zero3WorkflowWorkerRuntime) {
  return {
    ensureWorkflowRun: (input: Record<string, unknown>) => worker.ensureWorkflowRun(input),
    ensureWorkerBinding: (input: Record<string, unknown>) => worker.ensureWorkerBinding(input),
    addWorkItems: (input: Record<string, unknown>) => worker.addWorkItems(input),
    workflowSnapshot: (runId: string) => worker.workflowSnapshot(runId)
  }
}

test('Task Workflow Runtime projects READY GPT stages to Worker v2 and reconciles completed artifacts back through the Task Completion Gate', async () => {
  const taskStore = new Zero3WorkflowStore(':memory:')
  const workerStore = new Zero3WorkflowWorkerStore(':memory:')
  try {
    const task = new Zero3WorkflowRuntime(taskStore, createBuiltinWorkflowRegistry())
    const worker = new Zero3WorkflowWorkerRuntime(workerStore, { ticketSecret: SECRET })
    let snapshot = task.createRun({
      moduleId: 'cognitive-store-video',
      input: {
        projectId: 'zero3',
        scripts: [
          { title: '脚本1', driveFileId: 'input-drive-1' },
          { title: '脚本2', driveFileId: 'input-drive-2' }
        ]
      }
    })
    const queue = new Zero3WorkflowWorkerQueueService(task, { verify: async artifact => artifact.storage.provider === 'GOOGLE_DRIVE' })
    const projection = new Zero3WorkflowWorkerProjectionService(task, admin(worker), queue)
    const firstSync = await projection.syncRun(snapshot.run.workflowRunId)
    assert.equal(firstSync.seededStageRunIds.length, 2)

    snapshot = task.getRun(snapshot.run.workflowRunId)
    const scriptBinding = buildWorkflowWorkerBindings(snapshot).find(value => value.workerDefinitionId === 'script-worker')!
    const opened = worker.openPhysicalSession({ workerSlotId: scriptBinding.workerSlotId, logicalSessionId: 'gpt-script-worker' }) as any
    const claimResult = worker.claimWorkV2({
      bindingTicket: opened.ticket,
      idempotencyKey: 'claim-script-1',
      maxItems: 1
    }) as any
    assert.equal(claimResult.state, 'CLAIMED')
    const unit = claimResult.claim.units[0]
    assert.equal(unit.inputs.length, 1)
    assert.equal(unit.inputs[0].logicalName, '原始脚本')
    assert.equal(unit.inputs[0].storage.fileId, 'input-drive-1')
    const authoritativeStageRunId = String(unit.metadata.authoritativeStageRunId)
    const taskStage = snapshot.stages.find(value => value.stageRunId === authoritativeStageRunId)!

    const committed = worker.commitAndClaimNext({
      bindingTicket: opened.ticket,
      claimId: claimResult.claim.claimId,
      idempotencyKey: 'commit-script-1',
      maxItems: 1,
      artifacts: [{
        artifactId: 'rewritten-script-1',
        workflowRunId: snapshot.run.workflowRunId,
        workItemId: unit.workItemId,
        stageRunId: unit.stageRunId,
        logicalName: '重构脚本.md',
        kind: 'markdown',
        mimeType: 'text/markdown',
        storage: { provider: 'GOOGLE_DRIVE', fileId: 'rewritten-drive-1' },
        producer: {
          workerDefinitionId: scriptBinding.workerDefinitionId,
          workerSlotId: scriptBinding.workerSlotId,
          workerSessionId: opened.workerSessionId
        }
      }]
    }) as any
    assert.equal(committed.committed, true)

    const secondSync = await projection.syncRun(snapshot.run.workflowRunId)
    assert.deepEqual(secondSync.reconciledStageRunIds, [taskStage.stageRunId])
    snapshot = task.getRun(snapshot.run.workflowRunId)
    assert.equal(snapshot.stages.find(value => value.stageRunId === taskStage.stageRunId)?.status, 'COMPLETED')
    assert.equal(snapshot.stages.find(value => value.itemId === taskStage.itemId && value.stageId === 'visual-plan')?.status, 'READY')
    const rewritten = snapshot.artifacts.find(value => value.artifactId === 'rewritten-script-1')
    assert.equal(rewritten?.itemId, taskStage.itemId)
    assert.equal(rewritten?.storage.fileId, 'rewritten-drive-1')

    const mirrored = worker.workflowSnapshot(snapshot.run.workflowRunId) as any
    const visualMirror = mirrored.stages.find((value: any) => value.metadata?.authoritativeStageRunId === snapshot.stages.find(stage => stage.itemId === taskStage.itemId && stage.stageId === 'visual-plan')?.stageRunId)
    assert.ok(visualMirror)
    assert.equal(visualMirror.inputs.some((value: any) => value.logicalName === '重构脚本.md' && value.storage.fileId === 'rewritten-drive-1'), true)
  } finally {
    workerStore.close()
    taskStore.close()
  }
})

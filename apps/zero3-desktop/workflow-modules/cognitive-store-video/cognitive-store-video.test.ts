import assert from 'node:assert/strict'
import test from 'node:test'

import { cognitiveStoreVideoModule } from './module.ts'
import { splitChapterIntoImageBatches } from './image-batching.ts'

test('chapter image batches never exceed ten images', () => {
  assert.deepEqual(splitChapterIntoImageBatches('c1', 8).batches.map(batch => batch.count), [8])
  assert.deepEqual(splitChapterIntoImageBatches('c2', 17).batches.map(batch => batch.count), [10, 7])
  assert.deepEqual(splitChapterIntoImageBatches('c3', 23).batches.map(batch => batch.count), [10, 10, 3])
})

test('cognitive-store module freezes prompts, workers and pipeline into each run plan', () => {
  const plan = cognitiveStoreVideoModule.createRun({
    projectId: 'zero3',
    scripts: [{ title: '资本论', driveFileId: 'drive-1' }]
  })
  assert.equal(plan.moduleId, 'cognitive-store-video')
  assert.equal(plan.moduleVersion, '1.0.0')
  assert.deepEqual(plan.stages.map(stage => stage.stageId), [
    'input-ingest', 'script-rewrite', 'visual-plan', 'image-production', 'local-ingest', 'cloud-render', 'pullback'
  ])
  assert.deepEqual(plan.workers.map(worker => worker.workerDefinitionId), ['script-worker', 'visual-worker', 'image-worker'])
  assert.equal(plan.workers.every(worker => typeof worker.metadata?.prompt === 'string' && String(worker.metadata.prompt).length > 20), true)
  assert.deepEqual(plan.items[0].completedStageIds, ['input-ingest'])
})

test('handoff manifest validation prevents image-count drift and blind remote resubmission', async () => {
  const { COGNITIVE_STORE_HANDOFF_PROTOCOL, cognitiveStoreDriveLayout, shouldSubmitRemoteRender, validateCognitiveStoreHandoffManifest } = await import('./handoff.ts')
  const layout = cognitiveStoreDriveLayout('run-1', 'item-1')
  assert.match(layout.handoff, /40_handoff$/)
  const manifest = {
    protocol: COGNITIVE_STORE_HANDOFF_PROTOCOL, workflow: 'cognitive-store-video@1.0.0', workflowRunId: 'run-1', workItemId: 'item-1', title: '资本论',
    imageCount: 2, images: ['U001.png', 'U002.png'], scriptFile: '重构脚本.md', visualPlanFile: '视觉内容.md', remoteExecutionId: null
  }
  assert.deepEqual(validateCognitiveStoreHandoffManifest(manifest), [])
  assert.equal(shouldSubmitRemoteRender(manifest), true)
  assert.ok(validateCognitiveStoreHandoffManifest({ ...manifest, imageCount: 3 }).some(error => error.includes('does not match')))
  assert.equal(shouldSubmitRemoteRender({ ...manifest, remoteExecutionId: 'aigate-123' }), false)
})

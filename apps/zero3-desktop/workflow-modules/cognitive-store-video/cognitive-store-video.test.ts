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

test('handoff manifest matches the deployed GPT-GPU runner schema and blocks blind resubmission', async () => {
  const {
    COGNITIVE_STORE_HANDOFF_SCHEMA,
    COGNITIVE_STORE_WAN_WORKFLOW,
    cognitiveStoreDriveLayout,
    shouldSubmitRemoteRender,
    validateCognitiveStoreHandoffManifest
  } = await import('./handoff.ts')
  const layout = cognitiveStoreDriveLayout('run-1', 'item-1')
  assert.match(layout.handoff, /40_handoff$/)
  const manifest = {
    schema: COGNITIVE_STORE_HANDOFF_SCHEMA,
    package_id: 'RUN-1-ITEM-1',
    project_id: 'project-1',
    workflowRunId: 'run-1',
    workItemId: 'item-1',
    title: '资本论',
    execution: { max_parallel: 2 },
    jobs: [{
      id: 'QWEN-B01-U01',
      workflow: COGNITIVE_STORE_WAN_WORKFLOW,
      start_image: 'assets/QWEN-B01-U01.png',
      prompt: 'Slow camera push-in.',
      negative_prompt: 'blur, flicker',
      seed: 2026091101,
      width: 1248,
      height: 704,
      timeout_seconds: 7200
    }]
  }
  assert.deepEqual(validateCognitiveStoreHandoffManifest(manifest), [])
  assert.equal(shouldSubmitRemoteRender(manifest), true)
  assert.equal(shouldSubmitRemoteRender({ ...manifest, remoteExecutionId: 'remote-1' }), false)
  assert.ok(validateCognitiveStoreHandoffManifest({ ...manifest, schema: 'wrong' }).some(error => error.includes('schema')))
  assert.ok(validateCognitiveStoreHandoffManifest({ ...manifest, jobs: [{ ...manifest.jobs[0], width: 1000 }] }).some(error => error.includes('width')))
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3WorkflowWorkerStore } from '../worker-runtime/v2/worker-store.ts'
import { Zero3WorkflowWorkerRuntime } from '../worker-runtime/v2/workflow-worker-runtime.ts'
import { materializeVideoGenerationProductionPlan, installVideoGenerationWorkflow, type VideoGenerationSource } from './video-generation-module.ts'
import { parseVisualPlan, ZERO3_VISUAL_PLAN_BEGIN, ZERO3_VISUAL_PLAN_END } from './visual-plan-parser.ts'
import { planImageBatches } from './image-batch-planner.ts'

const SECRET = 'zero3-video-generation-test-secret-0123456789abcdef0123456789'
function runtime() {
  const store = new Zero3WorkflowWorkerStore(':memory:')
  return { store, worker: new Zero3WorkflowWorkerRuntime(store, { ticketSecret: SECRET, clock: () => new Date('2026-09-12T00:00:00.000Z') }) }
}
function source(): VideoGenerationSource {
  return {
    workItemId: 'script-01', scriptName: '博弈论', productionDate: '2026-09-12',
    sourceArtifact: {
      artifactId: 'source-01', workflowRunId: 'source-run', workItemId: 'script-01', stageRunId: 'script-01:source', logicalName: '博弈论.txt', kind: 'text', mimeType: 'text/plain',
      storage: { provider: 'LOCAL', path: 'C:/tmp/game-theory.txt' },
      producer: { workerDefinitionId: 'source-importer', workerSlotId: 'source-slot', workerSessionId: 'source-session' }
    }
  }
}
function visualPlan() {
  const shots = [
    ...Array.from({ length: 30 }, (_, i) => ({ shotId: `S${i + 1}`, type: 'static', requiresImage: true, imagePrompt: `static ${i + 1}` })),
    ...Array.from({ length: 10 }, (_, i) => ({ shotId: `V${i + 1}`, type: 'image_to_video', requiresImage: true, imagePrompt: `frame ${i + 1}`, videoPrompt: `motion ${i + 1}` })),
    ...Array.from({ length: 10 }, (_, i) => ({ shotId: `R${i + 1}`, type: 'remotion', requiresImage: false, remotionPrompt: `remotion ${i + 1}` }))
  ]
  return { schema: 'zero3.visual-plan.v1', scriptId: 'script-01', shots }
}
function completeVisual(worker: Zero3WorkflowWorkerRuntime) {
  const scriptOpen = worker.openPhysicalSession({ workerSlotId: 'video-run:script', logicalSessionId: 'gpt-script' }) as any
  worker.bootstrapWorker({ bindingTicket: scriptOpen.ticket })
  const scriptClaim = (worker.claimWorkV2({ bindingTicket: scriptOpen.ticket, idempotencyKey: 'script-claim' }) as any).claim
  const scriptUnit = scriptClaim.units[0]
  worker.commitAndClaimNext({ bindingTicket: scriptOpen.ticket, claimId: scriptClaim.claimId, idempotencyKey: 'script-done', artifacts: [{ artifactId: 'rewrite-art', workflowRunId: 'video-run', workItemId: 'script-01', stageRunId: scriptUnit.stageRunId, logicalName: '博弈论_重构_2026-09-12.md', kind: 'markdown', storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-rewrite' }, producer: { workerDefinitionId: 'script-rewriter', workerSlotId: 'video-run:script', workerSessionId: scriptOpen.workerSessionId } }] })
  const visualOpen = worker.openPhysicalSession({ workerSlotId: 'video-run:visual', logicalSessionId: 'gpt-visual' }) as any
  worker.bootstrapWorker({ bindingTicket: visualOpen.ticket })
  const visualClaim = (worker.claimWorkV2({ bindingTicket: visualOpen.ticket, idempotencyKey: 'visual-claim' }) as any).claim
  const unit = visualClaim.units[0]
  worker.commitAndClaimNext({ bindingTicket: visualOpen.ticket, claimId: visualClaim.claimId, idempotencyKey: 'visual-done', artifacts: [
    { artifactId: 'visual-md', workflowRunId: 'video-run', workItemId: 'script-01', stageRunId: unit.stageRunId, logicalName: '博弈论_视觉方案_2026-09-12.md', kind: 'markdown', storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-visual-md' }, producer: { workerDefinitionId: 'visual-planner', workerSlotId: 'video-run:visual', workerSessionId: visualOpen.workerSessionId } },
    { artifactId: 'visual-json', workflowRunId: 'video-run', workItemId: 'script-01', stageRunId: unit.stageRunId, logicalName: '博弈论_视觉方案_2026-09-12.json', kind: 'json', storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-visual-json' }, producer: { workerDefinitionId: 'visual-planner', workerSlotId: 'video-run:visual', workerSessionId: visualOpen.workerSessionId } },
    { artifactId: 'remotion', workflowRunId: 'video-run', workItemId: 'script-01', stageRunId: unit.stageRunId, logicalName: '博弈论_Remotion35云端执行交接包_2026-09-12.zip', kind: 'archive', storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-remotion' }, producer: { workerDefinitionId: 'visual-planner', workerSlotId: 'video-run:visual', workerSessionId: visualOpen.workerSessionId } }
  ] })
}

test('P0 visual plan parser accepts the machine block and derives 40 image-required shots from 50 total shots', () => {
  const raw = visualPlan()
  const md = `# 视觉方案\n${ZERO3_VISUAL_PLAN_BEGIN}\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`\n${ZERO3_VISUAL_PLAN_END}`
  const parsed = parseVisualPlan(md)
  assert.equal(parsed.totalShots, 50)
  assert.equal(parsed.staticShots, 30)
  assert.equal(parsed.imageToVideoShots, 10)
  assert.equal(parsed.remotionShots, 10)
  assert.equal(parsed.imageRequiredShotIds.length, 40)
  assert.deepEqual(planImageBatches(parsed.plan.shots).map(batch => batch.shotIds.length), [10, 10, 10, 10])
})

test('P0 video workflow seeds only rewrite/visual first and materializes deterministic image batches after verified visual output', () => {
  const { store, worker } = runtime()
  try {
    const installed = installVideoGenerationWorkflow(worker, { workflowRunId: 'video-run', taskId: 'task-video-1', projectId: 'project-1', profileRevision: 3, driveFolderId: 'drive-folder', imageBatchSize: 10, sources: [source()], idempotencyKey: 'install' }) as any
    assert.equal(installed.snapshot.counts.stageRunsTotal, 2)
    assert.deepEqual(installed.bindings, ['video-run:script', 'video-run:visual', 'video-run:image'])
    completeVisual(worker)
    const materialized = materializeVideoGenerationProductionPlan(worker, { workflowRunId: 'video-run', workItemId: 'script-01', scriptName: '博弈论', productionDate: '2026-09-12', visualPlan: visualPlan(), imageBatchSize: 10, idempotencyKey: 'plan' }) as any
    assert.deepEqual(materialized.batches.map((batch: any) => batch.shotIds.length), [10, 10, 10, 10])
    assert.equal(materialized.summary.totalShots, 50)
    assert.equal(materialized.summary.imageRequiredShots, 40)
    const production = materialized.snapshot.items.find((item: any) => item.workItemId === 'script-01-production')
    assert.equal(production.metadata.imageBatchCount, 4)
    const stages = materialized.snapshot.stages.filter((stage: any) => stage.workItemId === 'script-01-production')
    assert.equal(stages.filter((stage: any) => stage.stageKey === 'image-batch').length, 4)
    assert.equal(stages.find((stage: any) => stage.stageKey === 'image-package').expectedOutputs.length, 3)
    const replay = materializeVideoGenerationProductionPlan(worker, { workflowRunId: 'video-run', workItemId: 'script-01', scriptName: '博弈论', productionDate: '2026-09-12', visualPlan: visualPlan(), imageBatchSize: 10, idempotencyKey: 'plan' }) as any
    assert.equal(replay.snapshot.counts.workItemsTotal, materialized.snapshot.counts.workItemsTotal)
  } finally { store.close() }
})

test('P0 production materialization fails closed before visual stage completion or when script identity mismatches', () => {
  const { store, worker } = runtime()
  try {
    installVideoGenerationWorkflow(worker, { workflowRunId: 'video-run', taskId: 'task-video-1', projectId: 'project-1', profileRevision: 1, driveFolderId: 'drive-folder', sources: [source()], idempotencyKey: 'install' })
    assert.throws(() => materializeVideoGenerationProductionPlan(worker, { workflowRunId: 'video-run', workItemId: 'script-01', scriptName: '博弈论', productionDate: '2026-09-12', visualPlan: visualPlan(), idempotencyKey: 'early' }), /visual plan stage must be completed/)
    const wrong = { ...visualPlan(), scriptId: 'script-99' }
    assert.throws(() => materializeVideoGenerationProductionPlan(worker, { workflowRunId: 'video-run', workItemId: 'script-01', scriptName: '博弈论', productionDate: '2026-09-12', visualPlan: wrong, idempotencyKey: 'wrong' }), /does not match/)
  } finally { store.close() }
})
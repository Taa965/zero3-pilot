import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import { Zero3WorkflowAutomationController } from './automation-controller.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'

async function withRuntime(run: (runtime: Zero3WorkflowRuntime) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-automation-'))
  const store = new Zero3WorkflowStore(join(dir, 'workflow.sqlite3'))
  try { await run(new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry())) }
  finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

function finish(runtime: Zero3WorkflowRuntime, runId: string, itemId: string, stageId: string, artifacts: readonly Record<string, unknown>[]) {
  const stage = runtime.getRun(runId).stages.find(value => value.itemId === itemId && value.stageId === stageId)!
  runtime.claimStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
  runtime.startStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
  runtime.requestVerification(runId, stage.stageRunId, artifacts as never)
  runtime.gatePassed(runId, stage.stageRunId)
}

test('automation controller advances local-ingest -> cloud-render -> pullback in one tick while leaving GPT stages to workers', async () => {
  await withRuntime(async runtime => {
    const created = runtime.createRun({ moduleId: 'cognitive-store-video', input: { projectId: 'p1', scripts: [{ title: '资本论', driveFileId: 'input' }] }, start: true })
    const runId = created.run.workflowRunId
    const itemId = created.items[0].itemId
    finish(runtime, runId, itemId, 'script-rewrite', [{ stageId: 'script-rewrite', logicalName: '重构脚本.md', kind: 'markdown', storage: { provider: 'GOOGLE_DRIVE', fileId: 'script' } }])
    finish(runtime, runId, itemId, 'visual-plan', [
      { stageId: 'visual-plan', logicalName: '视觉内容.md', kind: 'markdown', storage: { provider: 'GOOGLE_DRIVE', fileId: 'visual' } },
      { stageId: 'visual-plan', logicalName: '导演审片单.md', kind: 'markdown', storage: { provider: 'GOOGLE_DRIVE', fileId: 'director' } },
      { stageId: 'visual-plan', logicalName: '逐条完整提示词.md', kind: 'markdown', storage: { provider: 'GOOGLE_DRIVE', fileId: 'prompts' } }
    ])
    finish(runtime, runId, itemId, 'image-production', [
      { stageId: 'image-production', logicalName: 'overview.png', kind: 'image', storage: { provider: 'GOOGLE_DRIVE', fileId: 'overview' } },
      { stageId: 'image-production', logicalName: '交接包.zip', kind: 'handoff-package', storage: { provider: 'GOOGLE_DRIVE', fileId: 'handoff' } }
    ])
    let handoffCalls = 0; let remoteCalls = 0; let pullbackCalls = 0
    const handoff = { ingestReady: async (id: string) => {
      handoffCalls += 1
      finish(runtime, id, itemId, 'local-ingest', [{ stageId: 'local-ingest', logicalName: 'local-handoff', kind: 'local-package', storage: { provider: 'LOCAL', path: '/tmp/handoff.zip' }, state: 'VERIFIED' }])
      return { workflowRunId: id, completedStageRunIds: [], failed: [] }
    } }
    const remote = { dispatchOrReconcile: async (id: string, stageRunId: string) => {
      remoteCalls += 1
      const stage = runtime.getRun(id).stages.find(value => value.stageRunId === stageRunId)!
      runtime.claimStage(id, stageRunId, 'remote-test'); runtime.startStage(id, stageRunId, 'remote-test')
      runtime.requestVerification(id, stageRunId, [{ stageId: 'cloud-render', logicalName: '云端视频结果集', kind: 'remote-video-set', storage: { provider: 'REMOTE_COMPUTE', uri: 'zero3-gpt-gpu://run/0123456789abcdef01234567' }, state: 'AVAILABLE' }])
      runtime.gatePassed(id, stageRunId)
      return { state: 'COMPLETED' }
    } }
    const pullback = { pullback: async (id: string, stageRunId: string) => {
      pullbackCalls += 1
      const stage = runtime.getRun(id).stages.find(value => value.stageRunId === stageRunId)!
      runtime.claimStage(id, stageRunId, 'pullback-test'); runtime.startStage(id, stageRunId, 'pullback-test')
      runtime.requestVerification(id, stageRunId, [{ stageId: 'pullback', logicalName: '视频回传清单.json', kind: 'video-result-manifest', storage: { provider: 'LOCAL', path: '/tmp/results.json' }, state: 'VERIFIED' }])
      runtime.gatePassed(id, stageRunId)
      return { state: 'COMPLETED' }
    } }
    const controller = new Zero3WorkflowAutomationController(runtime, { handoffIngest: handoff as never, remoteRender: remote as never, videoPullback: pullback as never }, 5000)
    const tick = await controller.tickOnce()
    assert.equal(tick.errors.length, 0)
    assert.equal(tick.actions, 3)
    assert.equal(handoffCalls, 1); assert.equal(remoteCalls, 1); assert.equal(pullbackCalls, 1)
    assert.equal(runtime.getRun(runId).run.status, 'COMPLETED')
  })
})

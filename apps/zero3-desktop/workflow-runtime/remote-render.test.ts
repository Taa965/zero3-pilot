import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import { Zero3WorkflowRemoteRenderService, type WorkflowRemoteRenderPort, type WorkflowRemoteRenderStatus } from './remote-render.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'

class FakeRemote implements WorkflowRemoteRenderPort {
  readonly provider = 'aigate'
  submits = 0
  resolveResult: WorkflowRemoteRenderStatus | null = null
  statusResult: WorkflowRemoteRenderStatus = { externalId: 'remote-001', state: 'RUNNING', progress: 0.4 }
  submitError: Error | null = null

  async submitIdempotent(): Promise<WorkflowRemoteRenderStatus> {
    this.submits += 1
    if (this.submitError) throw this.submitError
    return { externalId: 'remote-001', state: 'RUNNING', progress: 0.1 }
  }
  async resolveByRequestKey() { return this.resolveResult }
  async getStatus() { return this.statusResult }
}

async function withRuntime(run: (runtime: Zero3WorkflowRuntime) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-remote-render-'))
  const store = new Zero3WorkflowStore(join(dir, 'workflow.sqlite3'))
  try { await run(new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry())) }
  finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

function createRun(runtime: Zero3WorkflowRuntime) {
  return runtime.createRun({
    moduleId: 'cognitive-store-video',
    input: { projectId: 'p1', scripts: [{ title: '资本论', driveFileId: 'drive-input' }] },
    start: true
  })
}

function finishStage(runtime: Zero3WorkflowRuntime, runId: string, itemId: string, stageId: string, outputs: readonly { logicalName: string; kind: string }[]) {
  const snapshot = runtime.getRun(runId)
  const stage = snapshot.stages.find(value => value.itemId === itemId && value.stageId === stageId)!
  runtime.claimStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
  runtime.startStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
  runtime.requestVerification(runId, stage.stageRunId, outputs.map((output, index) => ({
    stageId,
    logicalName: output.logicalName,
    kind: output.kind,
    storage: stage.executor === 'GPT_WEB'
      ? { provider: 'GOOGLE_DRIVE' as const, fileId: `${stageId}-${index}` }
      : { provider: 'LOCAL' as const, path: `/tmp/${stageId}-${index}` }
  })))
  runtime.gatePassed(runId, stage.stageRunId)
}

function prepareCloud(runtime: Zero3WorkflowRuntime) {
  const created = createRun(runtime)
  const runId = created.run.workflowRunId
  const itemId = created.items[0].itemId
  finishStage(runtime, runId, itemId, 'script-rewrite', [{ logicalName: '重构脚本.md', kind: 'markdown' }])
  finishStage(runtime, runId, itemId, 'visual-plan', [
    { logicalName: '视觉内容.md', kind: 'markdown' },
    { logicalName: '导演审片单.md', kind: 'markdown' },
    { logicalName: '逐条完整提示词.md', kind: 'markdown' }
  ])
  finishStage(runtime, runId, itemId, 'image-production', [
    { logicalName: 'overview.png', kind: 'image' },
    { logicalName: '交接包.zip', kind: 'handoff-package' }
  ])
  finishStage(runtime, runId, itemId, 'local-ingest', [{ logicalName: 'local-handoff', kind: 'local-package' }])
  const stage = runtime.getRun(runId).stages.find(value => value.stageId === 'cloud-render')!
  assert.equal(stage.status, 'READY')
  return { runId, itemId, stageRunId: stage.stageRunId }
}

test('remote render persists intent before submit and reconciles the same external id without duplicate submission', async () => {
  await withRuntime(async runtime => {
    const target = prepareCloud(runtime)
    const port = new FakeRemote()
    const service = new Zero3WorkflowRemoteRenderService(runtime, port)
    const first = await service.dispatchOrReconcile(target.runId, target.stageRunId)
    assert.equal(first.state, 'RUNNING')
    assert.equal(port.submits, 1)
    const job = runtime.externalJob(target.runId, target.stageRunId)!
    assert.equal(job.externalId, 'remote-001')
    assert.equal(job.state, 'RUNNING')

    port.statusResult = {
      externalId: 'remote-001',
      state: 'SUCCEEDED',
      output: { storage: { provider: 'REMOTE_COMPUTE', uri: 'remote://gpu/result.mp4' }, mimeType: 'video/mp4', sizeBytes: 1234 }
    }
    const second = await service.dispatchOrReconcile(target.runId, target.stageRunId)
    assert.equal(second.state, 'COMPLETED')
    assert.equal(port.submits, 1)
    const after = runtime.getRun(target.runId)
    assert.equal(after.stages.find(value => value.stageId === 'cloud-render')?.status, 'COMPLETED')
    assert.equal(after.stages.find(value => value.stageId === 'pullback')?.status, 'READY')
    assert.equal(after.artifacts.find(value => value.stageId === 'cloud-render')?.storage.provider, 'REMOTE_COMPUTE')
  })
})

test('ambiguous remote submission becomes OUTCOME_UNKNOWN and is never blindly submitted again', async () => {
  await withRuntime(async runtime => {
    const target = prepareCloud(runtime)
    const port = new FakeRemote()
    port.submitError = new Error('socket closed after request body was sent')
    const service = new Zero3WorkflowRemoteRenderService(runtime, port)
    const first = await service.dispatchOrReconcile(target.runId, target.stageRunId)
    assert.equal(first.state, 'OUTCOME_UNKNOWN')
    assert.equal(port.submits, 1)
    assert.equal(runtime.externalJob(target.runId, target.stageRunId)?.state, 'OUTCOME_UNKNOWN')
    assert.equal(runtime.getRun(target.runId).stages.find(value => value.stageId === 'cloud-render')?.status, 'WAITING_HUMAN')

    const second = await service.dispatchOrReconcile(target.runId, target.stageRunId)
    assert.equal(second.state, 'OUTCOME_UNKNOWN')
    assert.equal(port.submits, 1)
  })
})

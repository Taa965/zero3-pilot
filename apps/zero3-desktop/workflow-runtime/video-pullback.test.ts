import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'
import { Zero3WorkflowVideoPullbackService, type WorkflowGptGpuResultPort, type WorkflowVideoQcPort } from './video-pullback.ts'

class FakeRemote implements WorkflowGptGpuResultPort {
  readonly provider = 'zero3-gpt-gpu-runner'
  downloads: string[] = []
  failJob: string | null = null
  async downloadResult(_runId: string, jobId: string, target: string) {
    if (this.failJob === jobId) throw new Error(`download failed ${jobId}`)
    this.downloads.push(jobId)
    await mkdir(dirname(target), { recursive: true })
    const data = Buffer.from(`fake-video-${jobId}`)
    await writeFile(target, data)
    return { path: target, sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  }
}

class FakeQc implements WorkflowVideoQcPort {
  async inspect(file: string) { return { backend: 'fake-qc', durationSeconds: 5, width: 1248, height: 704, codec: 'h264', sizeBytes: 100 + file.length } }
}

async function withRuntime(run: (runtime: Zero3WorkflowRuntime, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-video-pullback-'))
  const store = new Zero3WorkflowStore(join(dir, 'workflow.sqlite3'))
  try { await run(new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry()), dir) }
  finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

function finish(runtime: Zero3WorkflowRuntime, runId: string, itemId: string, stageId: string, artifacts: readonly Record<string, unknown>[]) {
  const stage = runtime.getRun(runId).stages.find(value => value.itemId === itemId && value.stageId === stageId)!
  runtime.claimStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
  runtime.startStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
  runtime.requestVerification(runId, stage.stageRunId, artifacts as never)
  runtime.gatePassed(runId, stage.stageRunId)
}

function preparePullback(runtime: Zero3WorkflowRuntime) {
  const created = runtime.createRun({ moduleId: 'cognitive-store-video', input: { projectId: 'p1', scripts: [{ title: '资本论', driveFileId: 'drive-input' }] }, start: true })
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
  const jobs = [{ id: 'QWEN-B01-U01' }, { id: 'QWEN-B01-U02' }]
  finish(runtime, runId, itemId, 'local-ingest', [{
    stageId: 'local-ingest', logicalName: 'local-handoff', kind: 'local-package', storage: { provider: 'LOCAL', path: '/tmp/handoff.zip' }, state: 'VERIFIED',
    metadata: { manifest: { schema: 'zero3.gpt-gpu-handoff/1.0', jobs } }
  }])
  const remoteRunId = '0123456789abcdef01234567'
  finish(runtime, runId, itemId, 'cloud-render', [{
    stageId: 'cloud-render', logicalName: '云端视频结果集', kind: 'remote-video-set', storage: { provider: 'REMOTE_COMPUTE', uri: `zero3-gpt-gpu://run/${remoteRunId}` },
    metadata: { externalId: remoteRunId }
  }])
  const stage = runtime.getRun(runId).stages.find(value => value.stageId === 'pullback')!
  assert.equal(stage.status, 'READY')
  return { runId, itemId, stageRunId: stage.stageRunId }
}

test('pullback downloads every handoff job, runs technical QC and completes the WorkItem with a local result manifest', async () => {
  await withRuntime(async (runtime, dir) => {
    const target = preparePullback(runtime)
    const remote = new FakeRemote()
    const service = new Zero3WorkflowVideoPullbackService(runtime, remote, new FakeQc(), join(dir, 'output'))
    const result = await service.pullback(target.runId, target.stageRunId)
    assert.equal(result.state, 'COMPLETED')
    assert.equal(result.videoCount, 2)
    assert.deepEqual(remote.downloads, ['QWEN-B01-U01', 'QWEN-B01-U02'])
    const after = runtime.getRun(target.runId)
    assert.equal(after.stages.find(value => value.stageId === 'pullback')?.status, 'COMPLETED')
    assert.equal(after.items[0].status, 'COMPLETED')
    assert.equal(after.run.status, 'COMPLETED')
    assert.equal(after.artifacts.filter(value => value.logicalName.startsWith('video:') && value.state === 'VERIFIED').length, 2)
    assert.ok(after.artifacts.some(value => value.logicalName === '视频回传清单.json' && value.state === 'VERIFIED'))
    const replay = await service.pullback(target.runId, target.stageRunId)
    assert.equal(replay.state, 'COMPLETED')
    assert.equal(remote.downloads.length, 2)
  })
})

test('pullback failure stops the stage for human recovery without falsely completing the run', async () => {
  await withRuntime(async (runtime, dir) => {
    const target = preparePullback(runtime)
    const remote = new FakeRemote(); remote.failJob = 'QWEN-B01-U02'
    const service = new Zero3WorkflowVideoPullbackService(runtime, remote, new FakeQc(), join(dir, 'output'))
    const result = await service.pullback(target.runId, target.stageRunId)
    assert.equal(result.state, 'BLOCKED')
    const after = runtime.getRun(target.runId)
    assert.equal(after.stages.find(value => value.stageId === 'pullback')?.status, 'WAITING_HUMAN')
    assert.notEqual(after.run.status, 'COMPLETED')
    assert.ok(after.artifacts.some(value => value.logicalName === 'video:QWEN-B01-U01'))
  })
})

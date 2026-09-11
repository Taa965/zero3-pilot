import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'
import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'

async function withRuntime(run: (runtime: Zero3WorkflowRuntime) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-workflow-'))
  const store = new Zero3WorkflowStore(join(dir, 'workflow.sqlite3'))
  try { await run(new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry())) }
  finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

function createInput(count = 3) {
  return {
    projectId: 'zero3',
    title: '20条流水线测试',
    scripts: Array.from({ length: count }, (_, index) => ({
      title: `脚本${index + 1}`,
      driveFileId: `drive-${index + 1}`
    }))
  }
}

test('workflow registry exposes the cognitive-store module and validates input', async () => {
  await withRuntime(async runtime => {
    assert.equal(runtime.listModules().some(module => module.id === 'cognitive-store-video'), true)
    assert.equal(runtime.validateCreateInput('cognitive-store-video', createInput()).valid, true)
    assert.equal(runtime.validateCreateInput('cognitive-store-video', { projectId: 'zero3', scripts: [] }).valid, false)
  })
})

test('item-level completion releases only the same item downstream stage', async () => {
  await withRuntime(async runtime => {
    const created = runtime.createRun({ moduleId: 'cognitive-store-video', input: createInput(3) })
    const scriptStages = created.stages.filter(stage => stage.stageId === 'script-rewrite')
    assert.equal(scriptStages.length, 3)
    assert.equal(scriptStages.every(stage => stage.status === 'READY'), true)
    assert.equal(created.stages.filter(stage => stage.stageId === 'visual-plan').every(stage => stage.status === 'WAITING_DEPENDENCY'), true)

    const item1Script = scriptStages.find(stage => stage.itemId === created.items[0].itemId)!
    runtime.claimStage(created.run.workflowRunId, item1Script.stageRunId, 'script-worker-01')
    runtime.startStage(created.run.workflowRunId, item1Script.stageRunId, 'script-worker-01')
    runtime.reportProgress(created.run.workflowRunId, item1Script.stageRunId, 0.6, '重构中')
    runtime.requestVerification(created.run.workflowRunId, item1Script.stageRunId, [{
      stageId: 'script-rewrite',
      logicalName: '重构脚本.md',
      kind: 'markdown',
      storage: { provider: 'GOOGLE_DRIVE', fileId: 'rewrite-1' }
    }])
    const after = runtime.gatePassed(created.run.workflowRunId, item1Script.stageRunId, { driveFileId: true })

    const item1Visual = after.stages.find(stage => stage.itemId === created.items[0].itemId && stage.stageId === 'visual-plan')!
    const item2Visual = after.stages.find(stage => stage.itemId === created.items[1].itemId && stage.stageId === 'visual-plan')!
    const item2Script = after.stages.find(stage => stage.itemId === created.items[1].itemId && stage.stageId === 'script-rewrite')!
    assert.equal(item1Visual.status, 'READY')
    assert.equal(item2Visual.status, 'WAITING_DEPENDENCY')
    assert.equal(item2Script.status, 'READY')
    assert.equal(after.run.status, 'RUNNING')
  })
})

test('gate failure returns a stage to FIX_REQUIRED without releasing downstream work', async () => {
  await withRuntime(async runtime => {
    const created = runtime.createRun({ moduleId: 'cognitive-store-video', input: createInput(1) })
    const script = created.stages.find(stage => stage.stageId === 'script-rewrite')!
    runtime.claimStage(created.run.workflowRunId, script.stageRunId, 'script-worker-01')
    runtime.startStage(created.run.workflowRunId, script.stageRunId, 'script-worker-01')
    runtime.requestVerification(created.run.workflowRunId, script.stageRunId)
    const failed = runtime.gateFailed(created.run.workflowRunId, script.stageRunId, '缺少重构脚本.md')
    assert.equal(failed.stages.find(stage => stage.stageRunId === script.stageRunId)?.status, 'FIX_REQUIRED')
    assert.equal(failed.stages.find(stage => stage.stageId === 'visual-plan')?.status, 'WAITING_DEPENDENCY')
  })
})

test('local input remains in input-ingest while Drive input starts script stage immediately', async () => {
  await withRuntime(async runtime => {
    const created = runtime.createRun({
      moduleId: 'cognitive-store-video',
      input: {
        projectId: 'zero3',
        scripts: [
          { title: '本地稿', localPath: '/tmp/local.txt' },
          { title: '云端稿', driveFileId: 'drive-cloud' }
        ]
      }
    })
    const local = created.items.find(item => item.title === '本地稿')!
    const cloud = created.items.find(item => item.title === '云端稿')!
    assert.equal(created.stages.find(stage => stage.itemId === local.itemId && stage.stageId === 'input-ingest')?.status, 'READY')
    assert.equal(created.stages.find(stage => stage.itemId === local.itemId && stage.stageId === 'script-rewrite')?.status, 'WAITING_DEPENDENCY')
    assert.equal(created.stages.find(stage => stage.itemId === cloud.itemId && stage.stageId === 'input-ingest')?.status, 'COMPLETED')
    assert.equal(created.stages.find(stage => stage.itemId === cloud.itemId && stage.stageId === 'script-rewrite')?.status, 'READY')
  })
})

test('registry rejects invalid workflow DAGs returned by modules', async () => {
  const { Zero3WorkflowRegistry } = await import('./registry.ts')
  const registry = new Zero3WorkflowRegistry()
  registry.register({
    manifest: {
      contract: 'zero3.pilot.workflow-module.v1', id: 'bad', version: '1.0.0', name: 'bad', description: 'bad', uiKind: 'bad',
      requiredExecutors: [], requiredSkills: [], requiredPlugins: [], requiredArtifactProviders: []
    },
    validateCreateInput: () => ({ valid: true, errors: [], warnings: [] }),
    createRun: () => ({
      contract: 'zero3.pilot.workflow-run.v1', workflowRunId: 'bad-run', moduleId: 'bad', moduleVersion: '1.0.0', projectId: 'zero3', title: 'bad', createdAt: new Date().toISOString(), metadata: {},
      workers: [], items: [{ itemId: 'i1', title: 'item' }],
      stages: [
        { stageId: 'a', title: 'a', executor: 'ZERO3', workerDefinitionId: null, dependsOn: ['b'], expectedOutputs: [], completionGate: [], maxAttempts: 1 },
        { stageId: 'b', title: 'b', executor: 'ZERO3', workerDefinitionId: null, dependsOn: ['a'], expectedOutputs: [], completionGate: [], maxAttempts: 1 }
      ]
    })
  })
  assert.throws(() => registry.createRun('bad', {}), /cycle detected/)
})

test('completion gate refuses to complete a stage when required artifacts are absent', async () => {
  await withRuntime(async runtime => {
    const created = runtime.createRun({ moduleId: 'cognitive-store-video', input: createInput(1) })
    const script = created.stages.find(stage => stage.stageId === 'script-rewrite')!
    runtime.claimStage(created.run.workflowRunId, script.stageRunId, 'script-worker-01')
    runtime.startStage(created.run.workflowRunId, script.stageRunId, 'script-worker-01')
    runtime.requestVerification(created.run.workflowRunId, script.stageRunId)
    assert.throws(() => runtime.gatePassed(created.run.workflowRunId, script.stageRunId), /missing required artifacts/)
  })
})

test('twenty-item batch pipelines downstream work immediately instead of waiting for the whole stage', async () => {
  await withRuntime(async runtime => {
    const created = runtime.createRun({ moduleId: 'cognitive-store-video', input: createInput(20) })
    assert.equal(runtime.readyStages(created.run.workflowRunId, 'script-worker').length, 20)
    const first = runtime.readyStages(created.run.workflowRunId, 'script-worker')[0]
    runtime.claimStage(created.run.workflowRunId, first.stageRunId, 'script-worker-01')
    runtime.startStage(created.run.workflowRunId, first.stageRunId, 'script-worker-01')
    runtime.requestVerification(created.run.workflowRunId, first.stageRunId, [{
      stageId: 'script-rewrite', logicalName: '重构脚本.md', kind: 'markdown', storage: { provider: 'GOOGLE_DRIVE', fileId: 'rewrite-1' }
    }])
    runtime.gatePassed(created.run.workflowRunId, first.stageRunId)
    assert.equal(runtime.readyStages(created.run.workflowRunId, 'visual-worker').length, 1)
    assert.equal(runtime.readyStages(created.run.workflowRunId, 'script-worker').length, 19)
  })
})

test('workflow SQLite state survives process-style reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-workflow-reopen-'))
  const filename = join(dir, 'workflow.sqlite3')
  try {
    const firstStore = new Zero3WorkflowStore(filename)
    const firstRuntime = new Zero3WorkflowRuntime(firstStore, createBuiltinWorkflowRegistry())
    const created = firstRuntime.createRun({ moduleId: 'cognitive-store-video', input: createInput(2) })
    firstStore.close()

    const secondStore = new Zero3WorkflowStore(filename)
    try {
      const secondRuntime = new Zero3WorkflowRuntime(secondStore, createBuiltinWorkflowRegistry())
      const recovered = secondRuntime.getRun(created.run.workflowRunId)
      assert.equal(recovered.items.length, 2)
      assert.equal(recovered.run.status, 'RUNNING')
      assert.equal(recovered.events.some(event => event.type === 'run.created'), true)
    } finally { secondStore.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a fully gated single-item cognitive-store run reaches COMPLETED only after final pullback', async () => {
  await withRuntime(async runtime => {
    let snapshot = runtime.createRun({ moduleId: 'cognitive-store-video', input: createInput(1) })
    const runId = snapshot.run.workflowRunId
    const itemId = snapshot.items[0].itemId
    const outputs: Record<string, { logicalName: string; kind: string }[]> = {
      'script-rewrite': [{ logicalName: '重构脚本.md', kind: 'markdown' }],
      'visual-plan': [
        { logicalName: '视觉内容.md', kind: 'markdown' },
        { logicalName: '导演审片单.md', kind: 'markdown' },
        { logicalName: '逐条完整提示词.md', kind: 'markdown' }
      ],
      'image-production': [{ logicalName: 'overview.png', kind: 'image' }, { logicalName: '交接包.zip', kind: 'handoff-package' }],
      'local-ingest': [{ logicalName: 'local-handoff', kind: 'local-package' }],
      'cloud-render': [{ logicalName: '云端视频结果集', kind: 'remote-video-set' }],
      pullback: [{ logicalName: '视频回传清单.json', kind: 'video-result-manifest' }]
    }
    for (const stageId of ['script-rewrite', 'visual-plan', 'image-production', 'local-ingest', 'cloud-render', 'pullback']) {
      snapshot = runtime.getRun(runId)
      const stage = snapshot.stages.find(value => value.itemId === itemId && value.stageId === stageId)!
      assert.equal(stage.status, 'READY')
      runtime.claimStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
      runtime.startStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
      runtime.requestVerification(runId, stage.stageRunId, outputs[stageId].map((output, index) => ({
        stageId,
        logicalName: output.logicalName,
        kind: output.kind,
        storage: stage.executor === 'GPT_WEB'
          ? { provider: 'GOOGLE_DRIVE' as const, fileId: `${stageId}-${index}` }
          : { provider: 'LOCAL' as const, path: `/tmp/${stageId}-${index}` }
      })))
      snapshot = runtime.gatePassed(runId, stage.stageRunId)
    }
    assert.equal(snapshot.run.status, 'COMPLETED')
    assert.equal(snapshot.items[0].status, 'COMPLETED')
    assert.equal(snapshot.run.progress, 1)
  })
})

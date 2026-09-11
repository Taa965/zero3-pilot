import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import type { GoogleDriveArtifactPort } from './artifact-router.ts'
import { ZERO3_GPT_GPU_HANDOFF_V1, type Zero3HandoffPackageInspection } from './handoff-package.ts'
import { Zero3LocalHandoffIngestService } from './local-handoff-ingest.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'

class FakeDrive implements GoogleDriveArtifactPort {
  constructor(private readonly source: string) {}
  async verifyFile(fileId: string) { return fileId === 'handoff-drive' }
  async downloadFile(_fileId: string, targetRoot: string) {
    const target = join(targetRoot, '交接包.zip')
    await copyFile(this.source, target)
    return { path: target }
  }
}

async function withRuntime(run: (runtime: Zero3WorkflowRuntime, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-local-handoff-'))
  const store = new Zero3WorkflowStore(join(dir, 'workflow.sqlite3'))
  try { await run(new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry()), dir) }
  finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

function finish(runtime: Zero3WorkflowRuntime, runId: string, itemId: string, stageId: string, artifacts: readonly { logicalName: string; kind: string; fileId: string }[]) {
  const stage = runtime.getRun(runId).stages.find(value => value.itemId === itemId && value.stageId === stageId)!
  runtime.claimStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
  runtime.startStage(runId, stage.stageRunId, stage.workerDefinitionId ?? `executor-${stageId}`)
  runtime.requestVerification(runId, stage.stageRunId, artifacts.map(value => ({
    stageId,
    logicalName: value.logicalName,
    kind: value.kind,
    storage: { provider: 'GOOGLE_DRIVE' as const, fileId: value.fileId }
  })))
  runtime.gatePassed(runId, stage.stageRunId)
}

test('Drive handoff materializes locally, validates protocol identity and releases cloud-render', async () => {
  await withRuntime(async (runtime, dir) => {
    const created = runtime.createRun({ moduleId: 'cognitive-store-video', input: { projectId: 'p1', scripts: [{ title: '资本论', driveFileId: 'input-drive' }] }, start: true })
    const runId = created.run.workflowRunId
    const itemId = created.items[0].itemId
    finish(runtime, runId, itemId, 'script-rewrite', [{ logicalName: '重构脚本.md', kind: 'markdown', fileId: 'script' }])
    finish(runtime, runId, itemId, 'visual-plan', [
      { logicalName: '视觉内容.md', kind: 'markdown', fileId: 'visual' }, { logicalName: '导演审片单.md', kind: 'markdown', fileId: 'director' }, { logicalName: '逐条完整提示词.md', kind: 'markdown', fileId: 'prompts' }
    ])
    finish(runtime, runId, itemId, 'image-production', [
      { logicalName: 'overview.png', kind: 'image', fileId: 'overview' }, { logicalName: '交接包.zip', kind: 'handoff-package', fileId: 'handoff-drive' }
    ])
    const localStage = runtime.getRun(runId).stages.find(value => value.stageId === 'local-ingest')!
    assert.equal(localStage.status, 'READY')

    const packageFile = join(dir, 'source.zip')
    await writeFile(packageFile, 'not-a-real-zip-because-inspector-is-injected')
    const inspect = async (_file: string, expected?: { workflowRunId?: string; workItemId?: string }): Promise<Zero3HandoffPackageInspection> => ({
      protocol: ZERO3_GPT_GPU_HANDOFF_V1,
      manifest: { protocol: ZERO3_GPT_GPU_HANDOFF_V1, workflowRunId: expected?.workflowRunId, workItemId: expected?.workItemId },
      manifestEntry: 'handoff.json',
      packageSizeBytes: 42,
      packageSha256: 'a'.repeat(64)
    })
    const result = await new Zero3LocalHandoffIngestService(runtime, new FakeDrive(packageFile), join(dir, 'cache'), inspect).ingestReady(runId)
    assert.equal(result.failed.length, 0)
    assert.equal(result.completedStageRunIds.length, 1)
    const after = runtime.getRun(runId)
    assert.equal(after.stages.find(value => value.stageId === 'local-ingest')?.status, 'COMPLETED')
    assert.equal(after.stages.find(value => value.stageId === 'cloud-render')?.status, 'READY')
    const localArtifact = after.artifacts.find(value => value.stageId === 'local-ingest' && value.logicalName === 'local-handoff')!
    assert.equal(localArtifact.storage.provider, 'LOCAL')
    assert.equal(localArtifact.metadata.handoffProtocol, ZERO3_GPT_GPU_HANDOFF_V1)
  })
})

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import type { GoogleDriveWritableArtifactPort, GoogleDriveUploadRequest, GoogleDriveUploadResult } from './artifact-router.ts'
import { Zero3WorkflowInputIngestService } from './input-ingest.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'

class FakeDrive implements GoogleDriveWritableArtifactPort {
  readonly uploads: GoogleDriveUploadRequest[] = []
  readonly verified = new Set<string>()
  failUpload = false

  async verifyFile(fileId: string) { return this.verified.has(fileId) }
  async downloadFile(_fileId: string, targetRoot: string) { return { path: join(targetRoot, 'downloaded') } }
  async ensureFolder(_parent: string | null, name: string) { return { fileId: `folder-${name}` } }
  async ensureFolderPath(_root: string | null, segments: readonly string[]) { return { fileId: `folder-${segments.at(-1)}` } }
  async uploadFile(request: GoogleDriveUploadRequest): Promise<GoogleDriveUploadResult> {
    if (this.failUpload) throw new Error('simulated Drive outage')
    this.uploads.push(request)
    const fileId = `drive-${request.artifactId}`
    this.verified.add(fileId)
    return { fileId, webUrl: `https://drive.google.com/file/d/${fileId}`, sizeBytes: 5, sha256: 'a'.repeat(64), reused: false }
  }
}

async function fixture(run: (runtime: Zero3WorkflowRuntime, drive: FakeDrive, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-ingest-'))
  const file = join(dir, '资本论.txt')
  await writeFile(file, 'hello')
  const store = new Zero3WorkflowStore(join(dir, 'workflow.sqlite3'))
  const runtime = new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry())
  const drive = new FakeDrive()
  try { await run(runtime, drive, file) } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

test('local cognitive-store input is uploaded, relocated and immediately releases the same item script stage', async () => {
  await fixture(async (runtime, drive, file) => {
    const created = runtime.createRun({
      moduleId: 'cognitive-store-video',
      input: { projectId: 'p1', scripts: [{ title: '资本论', localPath: file }], drive: { rootFolderId: 'root-folder' } },
      start: true
    })
    assert.equal(created.stages.find(stage => stage.stageId === 'input-ingest')?.status, 'READY')
    assert.equal(created.stages.find(stage => stage.stageId === 'script-rewrite')?.status, 'WAITING_DEPENDENCY')

    const result = await new Zero3WorkflowInputIngestService(runtime, drive).ingestRun(created.run.workflowRunId)
    assert.equal(result.failed.length, 0)
    assert.equal(result.ingestedStageRunIds.length, 1)
    assert.equal(drive.uploads.length, 1)

    const after = runtime.getRun(created.run.workflowRunId)
    assert.equal(after.stages.find(stage => stage.stageId === 'input-ingest')?.status, 'COMPLETED')
    assert.equal(after.stages.find(stage => stage.stageId === 'script-rewrite')?.status, 'READY')
    const artifact = after.artifacts.find(value => value.logicalName === '原始脚本')!
    assert.equal(artifact.storage.provider, 'GOOGLE_DRIVE')
    assert.ok(artifact.storage.fileId?.startsWith('drive-'))
    assert.equal(artifact.state, 'VERIFIED')
    assert.ok(after.events.some(event => event.type === 'artifact.relocated'))
  })
})

test('Drive upload failure blocks only the affected input stage for human recovery', async () => {
  await fixture(async (runtime, drive, file) => {
    drive.failUpload = true
    const created = runtime.createRun({ moduleId: 'cognitive-store-video', input: { projectId: 'p1', scripts: [{ title: '资本论', localPath: file }] }, start: true })
    const result = await new Zero3WorkflowInputIngestService(runtime, drive).ingestRun(created.run.workflowRunId)
    assert.equal(result.failed.length, 1)
    const after = runtime.getRun(created.run.workflowRunId)
    assert.equal(after.stages.find(stage => stage.stageId === 'input-ingest')?.status, 'WAITING_HUMAN')
    assert.equal(after.stages.find(stage => stage.stageId === 'script-rewrite')?.status, 'WAITING_DEPENDENCY')
  })
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'

async function withRuntime(run: (runtime: Zero3WorkflowRuntime, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-external-job-'))
  const file = join(dir, 'workflow.sqlite3')
  const store = new Zero3WorkflowStore(file)
  try { await run(new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry()), file) }
  finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

function createRun(runtime: Zero3WorkflowRuntime) {
  return runtime.createRun({
    moduleId: 'cognitive-store-video',
    input: { projectId: 'p1', scripts: [{ title: '资本论', driveFileId: 'drive-input' }] },
    start: true
  })
}

test('remote job intent is durable and prevents a second request identity for the same cloud-render stage', async () => {
  await withRuntime(async runtime => {
    const created = createRun(runtime)
    const stage = created.stages.find(value => value.stageId === 'cloud-render')!
    const first = runtime.ensureExternalJobIntent(created.run.workflowRunId, stage.stageRunId, 'aigate', 'render:capital:v1', { source: 'handoff' })
    const replay = runtime.ensureExternalJobIntent(created.run.workflowRunId, stage.stageRunId, 'aigate', 'render:capital:v1', { ignoredOnReplay: true })
    assert.equal(replay.jobId, first.jobId)
    assert.equal(replay.requestKey, first.requestKey)
    assert.throws(() => runtime.ensureExternalJobIntent(created.run.workflowRunId, stage.stageRunId, 'aigate', 'different-request'))
    runtime.updateExternalJobState(created.run.workflowRunId, stage.stageRunId, 'FAILED', { reason: 'provider rejected job' })
    const retry = runtime.ensureExternalJobIntent(created.run.workflowRunId, stage.stageRunId, 'aigate', 'render:capital:v2')
    assert.notEqual(retry.jobId, first.jobId)
    assert.equal(retry.state, 'PENDING')
    assert.equal(runtime.getRun(created.run.workflowRunId).externalJobs.length, 2)
  })
})

test('submitted external id is immutable and state reconciliation survives database reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-external-job-reopen-'))
  const file = join(dir, 'workflow.sqlite3')
  let store = new Zero3WorkflowStore(file)
  try {
    let runtime = new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry())
    const created = createRun(runtime)
    const runId = created.run.workflowRunId
    const stage = created.stages.find(value => value.stageId === 'cloud-render')!
    runtime.ensureExternalJobIntent(runId, stage.stageRunId, 'aigate', 'render:capital:v1')
    const submitted = runtime.recordExternalJobSubmitted(runId, stage.stageRunId, 'cloud-job-001', { region: 'gpu-a' })
    assert.equal(submitted.state, 'SUBMITTED')
    assert.equal(submitted.externalId, 'cloud-job-001')
    const replay = runtime.recordExternalJobSubmitted(runId, stage.stageRunId, 'cloud-job-001')
    assert.equal(replay.externalId, 'cloud-job-001')
    assert.throws(() => runtime.recordExternalJobSubmitted(runId, stage.stageRunId, 'cloud-job-002'))
    runtime.updateExternalJobState(runId, stage.stageRunId, 'RUNNING', { percent: 0.4 })
    runtime.updateExternalJobState(runId, stage.stageRunId, 'OUTCOME_UNKNOWN', { reason: 'network response ambiguous' })

    store.close()
    store = new Zero3WorkflowStore(file)
    runtime = new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry())
    const job = runtime.externalJob(runId, stage.stageRunId)!
    assert.equal(job.externalId, 'cloud-job-001')
    assert.equal(job.state, 'OUTCOME_UNKNOWN')
    assert.equal(job.metadata.reason, 'network response ambiguous')
    assert.ok(runtime.getRun(runId).events.some(event => event.type === 'external_job.submitted'))
  } finally {
    try { store.close() } catch {}
    await rm(dir, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBuiltinWorkflowRegistry } from '../workflow-modules/index.ts'
import { Zero3WorkflowRuntime } from './runtime.ts'
import { Zero3WorkflowStore } from './store.ts'
import { buildWorkflowWorkerBindings, listReadyWorkflowWorkUnits } from './worker-v2-adapter.ts'
import { normalizeWorkflowWorkerBinding, normalizeWorkflowWorkUnit } from '../worker-runtime/v2/contracts.ts'

test('workflow runtime projects its ready per-item queue into Worker Protocol v2 contracts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-worker-v2-adapter-'))
  const store = new Zero3WorkflowStore(join(dir, 'workflow.sqlite3'))
  try {
    const runtime = new Zero3WorkflowRuntime(store, createBuiltinWorkflowRegistry())
    const snapshot = runtime.createRun({
      moduleId: 'cognitive-store-video',
      input: {
        projectId: 'zero3',
        scripts: [
          { title: '资本论', driveFileId: 'drive-1' },
          { title: '博弈论', driveFileId: 'drive-2' }
        ]
      }
    })
    const bindings = buildWorkflowWorkerBindings(snapshot)
    const scriptBinding = bindings.find(binding => binding.workerDefinitionId === 'script-worker')!
    assert.equal(normalizeWorkflowWorkerBinding(scriptBinding).workerSlotId, scriptBinding.workerSlotId)

    const work = listReadyWorkflowWorkUnits(snapshot, 'script-worker')
    assert.equal(work.length, 2)
    const unit = normalizeWorkflowWorkUnit(work[0])
    assert.equal(unit.inputs[0].storage.provider, 'GOOGLE_DRIVE')
    assert.equal(unit.inputs[0].storage.fileId, 'drive-1')
    assert.equal(unit.expectedOutputs[0].logicalName, '重构脚本.md')
    assert.equal(unit.metadata.workerDefinitionId, 'script-worker')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

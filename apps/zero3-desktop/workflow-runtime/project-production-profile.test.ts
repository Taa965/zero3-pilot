import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ProjectProductionProfileStore } from './project-production-profile.ts'

test('P0 production profile is revisioned and keeps bounded image batches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zero3-production-profile-'))
  try {
    const store = new ProjectProductionProfileStore(path.join(root, 'profiles.json'))
    const first = await store.upsert({
      projectId: 'project-1', driveFolderId: 'drive-folder-1',
      scriptSkill: 'cognitive-store-script', visualSkill: 'cognitive-store-visual', imageBatchSize: 10,
      gpuHandoffRunner: path.join(root, '运行GPT-GPU交接包.cmd'), jianyingExporter: 'default'
    })
    assert.equal(first.revision, 1)
    assert.equal(first.imageBatchSize, 10)
    const second = await store.upsert({ projectId: 'project-1', driveFolderId: 'drive-folder-2', imageBatchSize: 8 })
    assert.equal(second.revision, 2)
    assert.equal(second.driveFolderId, 'drive-folder-2')
    assert.equal(second.scriptSkill, first.scriptSkill)
    const restored = await new ProjectProductionProfileStore(path.join(root, 'profiles.json')).get('project-1')
    assert.deepEqual(restored, second)
    await assert.rejects(store.upsert({ projectId: 'project-2', driveFolderId: 'x', imageBatchSize: 11 }), /between 1 and 10/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
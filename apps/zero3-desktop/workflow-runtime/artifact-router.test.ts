import assert from 'node:assert/strict'
import test from 'node:test'

import { GoogleDriveArtifactProvider, selectArtifactTransport, Zero3ArtifactTransportRouter } from './artifact-router.ts'

test('artifact transport routes web boundaries through Google Drive without forcing local-local traffic through cloud', () => {
  assert.equal(selectArtifactTransport('WEB', 'LOCAL'), 'GOOGLE_DRIVE')
  assert.equal(selectArtifactTransport('LOCAL', 'WEB'), 'GOOGLE_DRIVE')
  assert.equal(selectArtifactTransport('WEB', 'WEB'), 'GOOGLE_DRIVE')
  assert.equal(selectArtifactTransport('LOCAL', 'LOCAL'), 'LOCAL')
  assert.equal(selectArtifactTransport('LOCAL', 'REMOTE'), 'REMOTE_COMPUTE')
})

test('Google Drive provider materializes by fileId through an injected authenticated port', async () => {
  const provider = new GoogleDriveArtifactProvider({
    verifyFile: async fileId => fileId === 'drive-1',
    downloadFile: async (fileId, targetRoot) => ({ path: `${targetRoot}/${fileId}.md` })
  })
  const router = new Zero3ArtifactTransportRouter()
  router.register(provider)
  const artifact = {
    contract: 'zero3.pilot.workflow-artifact.v1' as const,
    artifactId: 'art-1', workflowRunId: 'run-1', itemId: 'item-1', stageRunId: 'stage-run-1', stageId: 'script-rewrite',
    logicalName: '重构脚本.md', kind: 'markdown', mimeType: 'text/markdown', storage: { provider: 'GOOGLE_DRIVE' as const, fileId: 'drive-1' },
    sha256: null, sizeBytes: null, state: 'AVAILABLE' as const, metadata: {}, createdAt: '2026-09-10T00:00:00.000Z'
  }
  assert.equal(await router.verify(artifact), true)
  assert.deepEqual(await router.materialize(artifact, '/tmp/run-1'), { provider: 'LOCAL', path: '/tmp/run-1/drive-1.md' })
})

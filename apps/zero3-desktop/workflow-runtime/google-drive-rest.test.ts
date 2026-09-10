import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GoogleDriveRestArtifactPort, type GoogleDriveAccessTokenProvider } from './google-drive-rest.ts'

class TokenProvider implements GoogleDriveAccessTokenProvider { async accessToken() { return 'test-access-token-123456789' } }

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }

test('Drive REST port verifies, creates folders, uploads idempotently and downloads by fileId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-drive-rest-'))
  const source = join(dir, 'input.md')
  await writeFile(source, '# hello')
  const calls: { url: string; init: RequestInit }[] = []
  let artifactLookupCount = 0
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const auth = new Headers(init.headers).get('authorization')
    assert.equal(auth, 'Bearer test-access-token-123456789')
    if (url.includes('/files/file-verify?')) return json({ id: 'file-verify', name: 'verified.md', trashed: false })
    if (url.includes('/files/file-download?fields=')) return json({ id: 'file-download', name: 'download.md', trashed: false })
    if (url.endsWith('/files/file-download?alt=media')) return new Response('downloaded')
    if (url.includes("mimeType+%3D+%27application%2Fvnd.google-apps.folder%27") || url.includes('mimeType+%3D+')) return json({ files: [] })
    if (url.includes('/drive/v3/files?') && String(url).includes('zero3ArtifactId')) {
      artifactLookupCount += 1
      return json({ files: artifactLookupCount === 1 ? [] : [{ id: 'uploaded-1', name: 'input.md', size: '7', webViewLink: 'https://drive/u' }] })
    }
    if (url.includes('/drive/v3/files?fields=id,name,webViewLink,parents') && init.method === 'POST') return json({ id: 'folder-created', name: '00_input' })
    if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
      assert.equal(init.method, 'POST')
      assert.match(String(new Headers(init.headers).get('content-type')), /^multipart\/related; boundary=zero3_/u)
      assert.ok(Buffer.isBuffer(init.body))
      assert.ok((init.body as Buffer).includes(Buffer.from('# hello')))
      return json({ id: 'uploaded-1', name: 'input.md', size: '7', webViewLink: 'https://drive/u' })
    }
    throw new Error(`unexpected request: ${url}`)
  }
  const port = new GoogleDriveRestArtifactPort(new TokenProvider(), {
    apiBaseUrl: 'https://fake.test/drive/v3',
    uploadBaseUrl: 'https://fake.test/upload/drive/v3',
    fetchImpl
  })
  try {
    assert.equal(await port.verifyFile('file-verify'), true)
    const folder = await port.ensureFolder('root', '00_input', { zero3FolderKey: 'run:item:input' })
    assert.equal(folder.fileId, 'folder-created')
    const first = await port.uploadFile({ sourcePath: source, artifactId: 'art-1', parentFolderId: folder.fileId })
    assert.equal(first.reused, false)
    assert.equal(first.fileId, 'uploaded-1')
    const second = await port.uploadFile({ sourcePath: source, artifactId: 'art-1', parentFolderId: folder.fileId })
    assert.equal(second.reused, true)
    const downloaded = await port.downloadFile('file-download', join(dir, 'out'))
    assert.equal(await readFile(downloaded.path, 'utf8'), 'downloaded')
    assert.ok(calls.length >= 6)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

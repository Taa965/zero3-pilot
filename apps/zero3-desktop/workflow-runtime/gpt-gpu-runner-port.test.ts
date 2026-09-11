import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createZero3GptGpuRunnerPortFromProjectRoot, Zero3GptGpuRunnerPort } from './gpt-gpu-runner-port.ts'
import type { WorkflowRemoteRenderRequest } from './remote-render.ts'

function storedZip(name: string, content: Buffer): Buffer {
  const fileName = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8)
  local.writeUInt32LE(0, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(fileName.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10)
  central.writeUInt32LE(0, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(0, 42)
  const centralOffset = local.length + fileName.length + content.length
  const centralSize = central.length + fileName.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, fileName, content, central, fileName, eocd])
}

function requestFor(file: string, sha256: string): WorkflowRemoteRenderRequest {
  return {
    workflowRunId: 'run-1', workItemId: 'item-1', stageRunId: 'stage-cloud', metadata: {},
    inputArtifact: { artifactId: 'art-local-handoff', logicalName: 'local-handoff', storage: { provider: 'LOCAL', path: file }, sha256, sizeBytes: null }
  }
}

test('GPT-GPU runner adapter uses package SHA as idempotency identity and maps the deployed HTTPS API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-gpt-gpu-port-'))
  try {
    const tokenFile = join(dir, 'token.txt')
    await writeFile(tokenFile, 'x'.repeat(48))
    const manifest = {
      schema: 'zero3.gpt-gpu-handoff/1.0', package_id: 'PKG-1', project_id: 'project-1', workflowRunId: 'run-1', workItemId: 'item-1',
      jobs: [{ id: 'QWEN-B01-U01', workflow: 'wan22-i2v-14b-lightx2v-api', start_image: 'assets/U01.png', prompt: 'motion', width: 1248, height: 704 }]
    }
    const bytes = storedZip('handoff.json', Buffer.from(JSON.stringify(manifest)))
    const file = join(dir, 'handoff.zip')
    await writeFile(file, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const runId = digest.slice(0, 24)
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = String(input); calls.push({ url, init })
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${'x'.repeat(48)}`)
      if (url.endsWith('/api/handoff/v1/runs') && init.method === 'POST') {
        assert.equal(new Headers(init.headers).get('content-type'), 'application/zip')
        assert.deepEqual(Buffer.from(init.body as Buffer), bytes)
        return new Response(JSON.stringify({ run_id: runId, status: 'running', total: 1, completed_or_skipped: 0, failed: 0 }), { status: 200 })
      }
      if (url.endsWith(`/api/handoff/v1/runs/${runId}`)) {
        return new Response(JSON.stringify({ run_id: runId, status: 'completed', total: 1, completed_or_skipped: 1, failed: 0 }), { status: 200 })
      }
      if (url.endsWith(`/api/handoff/v1/runs/${runId}/files/QWEN-B01-U01`)) return new Response('fake-mp4-bytes', { status: 200, headers: { 'content-type': 'video/mp4' } })
      throw new Error(`unexpected request ${url}`)
    }
    const port = new Zero3GptGpuRunnerPort({ baseUrl: 'https://runner.test', tokenFile, fetchImpl })
    const request = requestFor(file, digest)
    const key = await port.requestKeyFor(request)
    assert.equal(key, `gptgpu:${digest}`)
    const submitted = await port.submitIdempotent({ ...request, requestKey: key })
    assert.equal(submitted.externalId, runId)
    assert.equal(submitted.state, 'RUNNING')
    assert.deepEqual(submitted.metadata?.jobIds, ['QWEN-B01-U01'])
    const resolved = await port.resolveByRequestKey(key)
    assert.equal(resolved?.state, 'SUCCEEDED')
    assert.equal(resolved?.output?.storage.uri, `zero3-gpt-gpu://run/${runId}`)
    const target = join(dir, 'result.mp4')
    const downloaded = await port.downloadResult(runId, 'QWEN-B01-U01', target)
    assert.equal(await readFile(target, 'utf8'), 'fake-mp4-bytes')
    assert.equal(downloaded.sizeBytes, 14)
    assert.ok(calls.length >= 3)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('GPT-GPU runner rejects a persisted request key when package bytes changed before submission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-gpt-gpu-change-'))
  try {
    const tokenFile = join(dir, 'token.txt'); await writeFile(tokenFile, 'x'.repeat(48))
    const manifest = { schema: 'zero3.gpt-gpu-handoff/1.0', package_id: 'P', project_id: 'p', workflowRunId: 'run-1', workItemId: 'item-1', jobs: [{ id: 'J1', start_image: 'a.png', prompt: 'p', width: 1248, height: 704 }] }
    const first = storedZip('handoff.json', Buffer.from(JSON.stringify(manifest)))
    const file = join(dir, 'handoff.zip'); await writeFile(file, first)
    const digest = createHash('sha256').update(first).digest('hex')
    const port = new Zero3GptGpuRunnerPort({ baseUrl: 'https://runner.test', tokenFile, fetchImpl: async () => { throw new Error('must not reach network') } })
    const request = requestFor(file, digest)
    const key = await port.requestKeyFor(request)
    await writeFile(file, Buffer.concat([first, Buffer.from('changed')]))
    await assert.rejects(() => port.submitIdempotent({ ...request, requestKey: key }), /changed after request intent/u)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('GPT-GPU runner can be discovered from the selected Zero3 project without copying its secret into Pilot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-gpt-gpu-project-'))
  try {
    await mkdir(join(dir, 'config'), { recursive: true })
    await mkdir(join(dir, 'data', 'secrets'), { recursive: true })
    await writeFile(join(dir, 'config', 'gpt_gpu_runner_remote.json'), JSON.stringify({
      schema: 'zero3.gpt-gpu-runner-remote/1.0',
      base_url: 'https://03.example.test',
      max_download_bytes: 123456789
    }))
    await writeFile(join(dir, 'data', 'secrets', 'gpt-gpu-runner-token.txt'), 'y'.repeat(48))
    const port = createZero3GptGpuRunnerPortFromProjectRoot(dir)
    assert.ok(port instanceof Zero3GptGpuRunnerPort)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

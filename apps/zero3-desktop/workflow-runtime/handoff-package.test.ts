import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { inspectZero3GptGpuHandoffPackage, ZERO3_GPT_GPU_HANDOFF_V1 } from './handoff-package.ts'

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

test('handoff inspector accepts only the reviewed GPT-GPU v1 contract and validates run identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-handoff-zip-'))
  try {
    const file = join(dir, 'handoff.zip')
    const manifest = { protocol: ZERO3_GPT_GPU_HANDOFF_V1, workflowRunId: 'run-1', workItemId: 'item-1', tasks: [] }
    await writeFile(file, storedZip('handoff.json', Buffer.from(JSON.stringify(manifest))))
    const inspected = await inspectZero3GptGpuHandoffPackage(file, { workflowRunId: 'run-1', workItemId: 'item-1' })
    assert.equal(inspected.protocol, ZERO3_GPT_GPU_HANDOFF_V1)
    assert.equal(inspected.manifest.workItemId, 'item-1')
    await assert.rejects(() => inspectZero3GptGpuHandoffPackage(file, { workItemId: 'item-2' }), /workItemId/u)

    const wrong = join(dir, 'wrong.zip')
    await writeFile(wrong, storedZip('handoff.json', Buffer.from(JSON.stringify({ protocol: 'other/1' }))))
    await assert.rejects(() => inspectZero3GptGpuHandoffPackage(wrong), /unsupported handoff protocol/u)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

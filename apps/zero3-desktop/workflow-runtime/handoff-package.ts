import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

export const ZERO3_GPT_GPU_HANDOFF_V1 = 'zero3.gpt-gpu-handoff/1.0' as const
const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024

export interface Zero3HandoffPackageInspection {
  protocol: typeof ZERO3_GPT_GPU_HANDOFF_V1
  manifest: Readonly<Record<string, unknown>>
  manifestEntry: string
  packageSizeBytes: number
  packageSha256: string
}

function findEocd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset
  }
  throw new Error('handoff ZIP end-of-central-directory was not found')
}

function readZipEntry(buffer: Buffer, wanted: string): Buffer {
  const eocd = findEocd(buffer)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset + centralSize > buffer.length) throw new Error('handoff ZIP central directory is truncated')
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) throw new Error('handoff ZIP central directory entry is invalid')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd > buffer.length) throw new Error('handoff ZIP file name is truncated')
    const name = buffer.subarray(offset + 46, nameEnd).toString('utf8').replace(/\\/gu, '/')
    if (name === wanted) {
      if ((flags & 0x1) !== 0) throw new Error('encrypted handoff ZIP entries are not supported')
      if (uncompressedSize > MAX_MANIFEST_BYTES) throw new Error('handoff manifest exceeds size limit')
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error('handoff ZIP local header is invalid')
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const dataEnd = dataStart + compressedSize
      if (dataEnd > buffer.length) throw new Error('handoff ZIP manifest data is truncated')
      const compressed = buffer.subarray(dataStart, dataEnd)
      let data: Buffer
      if (method === 0) data = Buffer.from(compressed)
      else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES })
      else throw new Error(`unsupported handoff manifest compression method ${method}`)
      if (data.length !== uncompressedSize) throw new Error('handoff manifest uncompressed size mismatch')
      return data
    }
    offset = nameEnd + extraLength + commentLength
  }
  throw new Error(`handoff ZIP is missing root ${wanted}`)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('handoff.json must contain a JSON object')
  return value as Record<string, unknown>
}

export async function inspectZero3GptGpuHandoffPackage(file: string, expected?: { workflowRunId?: string; workItemId?: string }): Promise<Zero3HandoffPackageInspection> {
  const info = await stat(file)
  if (!info.isFile() || info.size <= 0) throw new Error('handoff package is missing or empty')
  if (info.size > MAX_ZIP_BYTES) throw new Error('handoff package exceeds 4 GiB v1 limit')
  const data = await readFile(file)
  if (data.length < 4 || data.readUInt32LE(0) !== LOCAL) throw new Error('handoff package is not a ZIP file')
  const manifestBytes = readZipEntry(data, 'handoff.json')
  let parsed: unknown
  try { parsed = JSON.parse(manifestBytes.toString('utf8')) } catch { throw new Error('handoff.json is not valid JSON') }
  const manifest = object(parsed)
  const protocol = String(manifest.protocol ?? manifest.schema ?? '').trim()
  if (protocol !== ZERO3_GPT_GPU_HANDOFF_V1) throw new Error(`unsupported handoff protocol: ${protocol || '(missing)'}`)
  if (expected?.workflowRunId && manifest.workflowRunId != null && String(manifest.workflowRunId) !== expected.workflowRunId) {
    throw new Error('handoff workflowRunId does not match the current WorkflowRun')
  }
  if (expected?.workItemId && manifest.workItemId != null && String(manifest.workItemId) !== expected.workItemId) {
    throw new Error('handoff workItemId does not match the current WorkItem')
  }
  return { protocol: ZERO3_GPT_GPU_HANDOFF_V1, manifest, manifestEntry: 'handoff.json', packageSizeBytes: info.size, packageSha256: createHash('sha256').update(data).digest('hex') }
}

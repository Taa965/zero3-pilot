import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

export const ZERO3_DURABLE_RECORD = 'zero3.pilot.durable-record.v1' as const

export interface DurableEnvelope<T> {
  schema: typeof ZERO3_DURABLE_RECORD
  checksum: string
  payload: T
}

export class DurableStoreCorruptionError extends Error {}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function checksumPayload(payload: unknown): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex')
}

export function durableEnvelope<T>(payload: T): DurableEnvelope<T> {
  return { schema: ZERO3_DURABLE_RECORD, checksum: checksumPayload(payload), payload }
}

export function parseDurableEnvelope<T>(text: string, source = 'durable record'): T {
  let parsed: DurableEnvelope<T>
  try {
    parsed = JSON.parse(text) as DurableEnvelope<T>
  } catch (error) {
    throw new DurableStoreCorruptionError(`${source} is not valid JSON: ${String(error)}`)
  }
  if (parsed?.schema !== ZERO3_DURABLE_RECORD || typeof parsed.checksum !== 'string' || !('payload' in parsed)) {
    throw new DurableStoreCorruptionError(`${source} does not contain a supported durable envelope`)
  }
  const actual = checksumPayload(parsed.payload)
  if (actual !== parsed.checksum) throw new DurableStoreCorruptionError(`${source} checksum mismatch`)
  return parsed.payload
}

async function syncParentDirectory(path: string): Promise<void> {
  try {
    const handle = await open(dirname(path), 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch (error) {
    // Directory handles cannot be fsync'd on every supported Windows filesystem.
    // The file itself has already been fsync'd before the atomic rename.
    if (process.platform !== 'win32') throw error
  }
}

export async function writeDurableJson<T>(path: string, payload: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(durableEnvelope(payload))}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  await syncParentDirectory(path)
}

export async function readDurableJson<T>(path: string): Promise<T> {
  const handle = await open(path, 'r')
  try {
    return parseDurableEnvelope<T>(await handle.readFile('utf8'), path)
  } finally {
    await handle.close()
  }
}

export async function appendLineFsync(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(`${line.replace(/[\r\n]+$/u, '')}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function recoverInterruptedWrite(targetPath: string): Promise<'none' | 'cleaned' | 'recovered'> {
  const directory = dirname(targetPath)
  const prefix = `.${basename(targetPath)}.`
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'none'
    throw error
  }
  const temps = names.filter(name => name.startsWith(prefix) && name.endsWith('.tmp')).sort()
  if (temps.length === 0) return 'none'

  let targetExists = true
  try {
    await readDurableJson(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') targetExists = false
    else throw error
  }

  if (targetExists) {
    await Promise.all(temps.map(name => rm(join(directory, name), { force: true })))
    return 'cleaned'
  }
  if (temps.length !== 1) throw new DurableStoreCorruptionError(`ambiguous interrupted write for ${targetPath}: ${temps.length} temp files`)
  const temp = join(directory, temps[0])
  await readDurableJson(temp)
  await rename(temp, targetPath)
  await syncParentDirectory(targetPath)
  return 'recovered'
}

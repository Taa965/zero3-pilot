import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export type Zero3ArtifactRecord = {
  artifactId: string
  taskId: string
  sourceProvider: 'CODEX' | 'GEMINI'
  sourceCycle: number
  kind: string
  originalPath: string
  storedPath: string
  sha256: string
  sizeBytes: number
  createdAt: string
}

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

function text(value: unknown, label: string, max: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function digest(file: string) {
  const data = await fs.readFile(file)
  if (data.byteLength > MAX_ARTIFACT_BYTES) throw new Error('artifact exceeds 512 MiB')
  return { sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.byteLength, data }
}

export class Zero3ArtifactStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly root: string) {}

  registerFile(input: {
    taskId: string
    sourceProvider: 'CODEX' | 'GEMINI'
    sourceCycle: number
    kind: string
    sourcePath: string
    allowedRoot: string
  }): Promise<Zero3ArtifactRecord> {
    return this.mutate(async () => {
      const taskId = text(input.taskId, 'taskId', 256)
      const kind = text(input.kind, 'kind', 128)
      if (!Number.isInteger(input.sourceCycle) || input.sourceCycle < 1 || input.sourceCycle > 1000) throw new Error('sourceCycle is invalid')
      const allowedRoot = path.resolve(input.allowedRoot)
      const sourcePath = path.resolve(input.sourcePath)
      if (!inside(allowedRoot, sourcePath)) throw new Error('artifact source is outside the task workspace')
      const stat = await fs.stat(sourcePath)
      if (!stat.isFile()) throw new Error('artifact source must be a file')
      const { sha256, sizeBytes, data } = await digest(sourcePath)
      const objectDir = path.join(this.root, 'objects', sha256.slice(0, 2))
      const objectPath = path.join(objectDir, sha256)
      await fs.mkdir(objectDir, { recursive: true })
      try { await fs.access(objectPath) } catch { await fs.writeFile(objectPath, data, { mode: 0o600 }) }

      const record: Zero3ArtifactRecord = {
        artifactId: `artifact-${randomUUID()}`,
        taskId,
        sourceProvider: input.sourceProvider,
        sourceCycle: input.sourceCycle,
        kind,
        originalPath: sourcePath,
        storedPath: objectPath,
        sha256,
        sizeBytes,
        createdAt: new Date().toISOString()
      }
      const indexFile = path.join(this.root, 'tasks', `${taskId}.json`)
      const existing = await this.readIndex(indexFile)
      existing.push(record)
      await this.atomicJson(indexFile, existing)
      return { ...record }
    })
  }

  async list(taskIdValue: unknown): Promise<Zero3ArtifactRecord[]> {
    const taskId = text(taskIdValue, 'taskId', 256)
    return this.readIndex(path.join(this.root, 'tasks', `${taskId}.json`))
  }

  async get(taskIdValue: unknown, artifactIdValue: unknown): Promise<Zero3ArtifactRecord | null> {
    const taskId = text(taskIdValue, 'taskId', 256)
    const artifactId = text(artifactIdValue, 'artifactId', 256)
    return (await this.list(taskId)).find(value => value.artifactId === artifactId) ?? null
  }

  async verify(record: Zero3ArtifactRecord): Promise<boolean> {
    try {
      const value = await digest(record.storedPath)
      return value.sha256 === record.sha256 && value.sizeBytes === record.sizeBytes
    } catch { return false }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  private async readIndex(file: string): Promise<Zero3ArtifactRecord[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async atomicJson(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, file)
  }
}

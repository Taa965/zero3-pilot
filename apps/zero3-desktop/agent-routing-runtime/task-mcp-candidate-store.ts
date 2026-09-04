import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024

function taskId(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error('taskId is invalid')
  return text
}

function storageName(logicalId: string): string {
  return createHash('sha256').update(logicalId, 'utf8').digest('hex')
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await fs.unlink(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export type Zero3TaskMcpResultCandidate = {
  taskId: string
  version: number
  updatedAt: string | null
  payload: unknown
}

export class Zero3TaskMcpCandidateStore {
  constructor(private readonly root: string) {}

  async beginTurn(taskIdValue: unknown): Promise<void> {
    const logicalTaskId = taskId(taskIdValue)
    const name = `${storageName(logicalTaskId)}.json`
    await Promise.all([
      unlinkIfPresent(path.join(this.root, 'progress', name)),
      unlinkIfPresent(path.join(this.root, 'result-candidates', name))
    ])
  }

  async consumeResult(taskIdValue: unknown): Promise<Zero3TaskMcpResultCandidate | null> {
    const logicalTaskId = taskId(taskIdValue)
    const file = path.join(this.root, 'result-candidates', `${storageName(logicalTaskId)}.json`)
    let buffer: Buffer
    try {
      buffer = await fs.readFile(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      if (buffer.byteLength > MAX_CANDIDATE_BYTES) throw new Error('task MCP result candidate exceeds size limit')
      const value = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>
      if (value.taskId !== logicalTaskId) throw new Error('task MCP result candidate identity mismatch')
      const version = Number(value.version)
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('task MCP result candidate version is invalid')
      return {
        taskId: logicalTaskId,
        version,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        payload: structuredClone(value.payload)
      }
    } finally {
      await unlinkIfPresent(file)
    }
  }
}

export function zero3ResultCandidatesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

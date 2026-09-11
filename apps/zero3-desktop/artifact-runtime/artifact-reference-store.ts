import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { zero3AtomicWriteFile } from '../workspace-runtime/atomic-file.ts'
import { normalizeWorkflowArtifactRef, type WorkflowArtifactRef } from '../worker-runtime/v2/contracts.ts'

export type Zero3ArtifactReferenceStatus = 'draft' | 'produced' | 'approved' | 'rejected' | 'superseded'
export type Zero3ArtifactReferenceRecord = WorkflowArtifactRef & {
  projectId: string
  taskId: string
  agentId: string
  agentType: string
  description: string | null
  version: number
  status: Zero3ArtifactReferenceStatus
  idempotencyKey: string
  fingerprint: string
  createdAt: string
  updatedAt: string
}

const ID = /^[A-Za-z0-9._:-]{1,256}$/
function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function text(value: unknown, label: string, max = 4096): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized
}
function optionalText(value: unknown, label: string, max = 4096): string | null {
  if (value == null || value === '') return null
  return text(value, label, max)
}
function storageName(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]))
  }
  return value
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

export class Zero3ArtifactReferenceStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly root: string) {}

  register(input: {
    artifact: WorkflowArtifactRef
    projectId: string
    taskId: string
    agentId: string
    agentType: string
    description?: string | null
    version?: number
    status?: Zero3ArtifactReferenceStatus
    idempotencyKey: string
  }): Promise<Zero3ArtifactReferenceRecord> {
    return this.mutate(async () => {
      const artifact = normalizeWorkflowArtifactRef(input.artifact)
      const projectId = id(input.projectId, 'projectId')
      const taskId = id(input.taskId, 'taskId')
      const agentId = id(input.agentId, 'agentId')
      const agentType = id(input.agentType, 'agentType')
      const idempotencyKey = id(input.idempotencyKey, 'idempotencyKey')
      const description = optionalText(input.description, 'description', 8192)
      const status = input.status ?? 'produced'
      if (!['draft', 'produced', 'approved', 'rejected', 'superseded'].includes(status)) throw new Error('artifact status is invalid')
      const index = await this.readIndex(taskId)
      const canonical = { artifact, projectId, taskId, agentId, agentType, description, status, version: input.version ?? null }
      const hash = fingerprint(canonical)
      const replay = index.find(record => record.idempotencyKey === idempotencyKey)
      if (replay) {
        if (replay.fingerprint !== hash) throw new Error('artifact idempotency key was reused with different content')
        return { ...replay }
      }
      const version = input.version == null
        ? Math.max(0, ...index.filter(record => record.logicalName === artifact.logicalName).map(record => record.version)) + 1
        : input.version
      if (!Number.isSafeInteger(version) || version < 1 || version > 1_000_000) throw new Error('artifact version is invalid')
      if (index.some(record => record.artifactId === artifact.artifactId)) throw new Error('artifactId already exists')
      const now = new Date().toISOString()
      const record: Zero3ArtifactReferenceRecord = {
        ...artifact,
        projectId,
        taskId,
        agentId,
        agentType,
        description,
        version,
        status,
        idempotencyKey,
        fingerprint: hash,
        createdAt: now,
        updatedAt: now
      }
      index.push(record)
      await this.writeIndex(taskId, index)
      return { ...record }
    })
  }

  async list(taskIdValue: unknown): Promise<Zero3ArtifactReferenceRecord[]> {
    return this.readIndex(id(taskIdValue, 'taskId'))
  }

  async get(taskIdValue: unknown, artifactIdValue: unknown): Promise<Zero3ArtifactReferenceRecord | null> {
    const artifactId = id(artifactIdValue, 'artifactId')
    return (await this.list(taskIdValue)).find(record => record.artifactId === artifactId) ?? null
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  private indexFile(taskId: string): string {
    return path.join(this.root, 'tasks', `${storageName(taskId)}.json`)
  }

  private async readIndex(taskId: string): Promise<Zero3ArtifactReferenceRecord[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexFile(taskId), 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('artifact reference index is invalid')
      const records = parsed as Zero3ArtifactReferenceRecord[]
      if (records.some(record => record?.taskId !== taskId)) throw new Error('artifact reference task identity mismatch')
      return records.map(record => ({ ...record, storage: { ...record.storage }, producer: { ...record.producer } }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private writeIndex(taskId: string, records: Zero3ArtifactReferenceRecord[]): Promise<void> {
    return zero3AtomicWriteFile(this.indexFile(taskId), `${JSON.stringify(records, null, 2)}\n`)
  }
}

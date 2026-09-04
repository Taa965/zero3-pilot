import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type {
  Zero3CrossAgentBinding,
  Zero3ExecutionResultV2,
  Zero3ReviewState,
  Zero3TaskSpecV2
} from './agent-contracts'

export type Zero3AgentTaskState =
  | Zero3ReviewState
  | 'OUTCOME_UNKNOWN'
  | 'FAILED'

export type Zero3GptWebReviewAutomationStatus =
  | 'IDLE'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'

export type Zero3GptWebReviewAutomation = {
  status: Zero3GptWebReviewAutomationStatus
  reviewerSessionId: string | null
  cycle: number | null
  attempts: number
  lastError: string | null
  updatedAt: string
}

export type Zero3AgentTaskRecord = {
  task: Zero3TaskSpecV2
  resolvedTarget: 'CODEX' | 'GEMINI'
  state: Zero3AgentTaskState
  binding: Zero3CrossAgentBinding | null
  result: Zero3ExecutionResultV2 | null
  reviewAutomation?: Zero3GptWebReviewAutomation | null
  remoteTaskId: string | null
  remoteExecutionId: string | null
  createdAt: string
  updatedAt: string
}

export type Zero3AgentTaskListInput = {
  projectId?: string | null
  states?: Zero3AgentTaskState[] | null
  limit?: number | null
}

export type Zero3ReviewAutomationUpdate = {
  status: Zero3GptWebReviewAutomationStatus
  reviewerSessionId?: string | null
  cycle?: number | null
  attempts?: number
  lastError?: string | null
}

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_LIST_FILES = 5_000
const MAX_LIST_LIMIT = 1_000
const MAX_REVIEW_ERROR = 8_000

function validId(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function storageName(logicalId: string): string {
  return createHash('sha256').update(logicalId, 'utf8').digest('hex')
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function listLimit(value: unknown): number {
  if (value == null) return 200
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`task list limit must be between 1 and ${MAX_LIST_LIMIT}`)
  }
  return limit
}

function reviewAttempts(value: unknown, fallback: number): number {
  if (value == null) return fallback
  const attempts = Number(value)
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > 10_000) {
    throw new Error('review automation attempts must be an integer between 0 and 10000')
  }
  return attempts
}

function reviewCycle(value: unknown, fallback: number | null): number | null {
  if (value == null) return fallback
  const cycle = Number(value)
  if (!Number.isSafeInteger(cycle) || cycle < 1 || cycle > 10_000) {
    throw new Error('review automation cycle must be a positive integer')
  }
  return cycle
}

function reviewError(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new Error('review automation lastError must be a string or null')
  return value.slice(0, MAX_REVIEW_ERROR)
}

export class Zero3AgentTaskStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly root: string) {}

  async get(taskIdValue: unknown): Promise<Zero3AgentTaskRecord | null> {
    const taskId = validId(taskIdValue, 'taskId')
    try {
      const buffer = await fs.readFile(this.file(taskId))
      if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('agent task record exceeds size limit')
      const value = JSON.parse(buffer.toString('utf8')) as Zero3AgentTaskRecord
      if (value.task?.taskId !== taskId) throw new Error('agent task record identity mismatch')
      return clone(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async list(input: Zero3AgentTaskListInput = {}): Promise<Zero3AgentTaskRecord[]> {
    const projectId = input.projectId == null || input.projectId === '' ? null : validId(input.projectId, 'projectId')
    const states = input.states == null ? null : new Set(input.states)
    const limit = listLimit(input.limit)
    if (states && [...states].some(state => typeof state !== 'string' || !state.trim())) {
      throw new Error('task list states are invalid')
    }

    let entries: string[]
    try {
      entries = (await fs.readdir(this.root))
        .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .slice(0, MAX_LIST_FILES)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const records: Zero3AgentTaskRecord[] = []
    for (const name of entries) {
      const file = path.join(this.root, name)
      const buffer = await fs.readFile(file)
      if (buffer.byteLength > MAX_FILE_BYTES) throw new Error(`agent task record exceeds size limit: ${name}`)
      const record = JSON.parse(buffer.toString('utf8')) as Zero3AgentTaskRecord
      const taskId = validId(record.task?.taskId, 'stored taskId')
      if (storageName(taskId) + '.json' !== name) throw new Error('agent task record filename/identity mismatch')
      if (projectId && record.task.projectId !== projectId) continue
      if (states && !states.has(record.state)) continue
      records.push(clone(record))
    }

    return records
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
  }

  create(task: Zero3TaskSpecV2, resolvedTarget: 'CODEX' | 'GEMINI'): Promise<Zero3AgentTaskRecord> {
    return this.mutate(async () => {
      const existing = await this.get(task.taskId)
      if (existing) {
        if (existing.task.executionId === task.executionId && JSON.stringify(existing.task) === JSON.stringify(task)) {
          return existing
        }
        throw new Error('taskId is already bound to a different task/execution')
      }
      const timestamp = new Date().toISOString()
      const record: Zero3AgentTaskRecord = {
        task: clone(task),
        resolvedTarget,
        state: 'DRAFT',
        binding: null,
        result: null,
        reviewAutomation: null,
        remoteTaskId: null,
        remoteExecutionId: null,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      await this.write(record)
      return clone(record)
    })
  }

  update(
    taskIdValue: unknown,
    updater: (current: Zero3AgentTaskRecord) => Zero3AgentTaskRecord
  ): Promise<Zero3AgentTaskRecord> {
    return this.mutate(async () => {
      const taskId = validId(taskIdValue, 'taskId')
      const current = await this.get(taskId)
      if (!current) throw new Error('agent task record not found')
      const candidate = updater(clone(current)) ?? current
      if (candidate.task.taskId !== taskId || candidate.task.executionId !== current.task.executionId) {
        throw new Error('agent task identity is immutable')
      }
      candidate.updatedAt = new Date().toISOString()
      await this.write(candidate)
      return clone(candidate)
    })
  }

  setState(taskId: string, state: Zero3AgentTaskState): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({ ...current, state }))
  }

  setBinding(taskId: string, binding: Zero3CrossAgentBinding): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({ ...current, binding: clone(binding) }))
  }

  setResult(taskId: string, result: Zero3ExecutionResultV2, state: Zero3AgentTaskState): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => {
      if (result.taskId !== current.task.taskId || result.executionId !== current.task.executionId) {
        throw new Error('execution result identity mismatch')
      }
      return { ...current, result: clone(result), state }
    })
  }

  setReviewAutomation(taskId: string, update: Zero3ReviewAutomationUpdate): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => {
      const previous = current.reviewAutomation ?? null
      const reviewerSessionId = update.reviewerSessionId === undefined
        ? previous?.reviewerSessionId ?? null
        : update.reviewerSessionId == null || update.reviewerSessionId === ''
          ? null
          : validId(update.reviewerSessionId, 'reviewerSessionId')
      const next: Zero3GptWebReviewAutomation = {
        status: update.status,
        reviewerSessionId,
        cycle: reviewCycle(update.cycle, previous?.cycle ?? null),
        attempts: reviewAttempts(update.attempts, previous?.attempts ?? 0),
        lastError: reviewError(update.lastError, previous?.lastError ?? null),
        updatedAt: new Date().toISOString()
      }
      return { ...current, reviewAutomation: next }
    })
  }

  setRemoteMapping(taskId: string, remoteTaskId: string, remoteExecutionId: string): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({
      ...current,
      remoteTaskId: validId(remoteTaskId, 'remoteTaskId'),
      remoteExecutionId: validId(remoteExecutionId, 'remoteExecutionId')
    }))
  }

  private file(taskId: string) {
    return path.join(this.root, `${storageName(taskId)}.json`)
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  private async write(record: Zero3AgentTaskRecord): Promise<void> {
    const taskId = validId(record.task.taskId, 'taskId')
    const serialized = `${JSON.stringify(record, null, 2)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw new Error('agent task record exceeds size limit')
    await fs.mkdir(this.root, { recursive: true })
    const target = this.file(taskId)
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
    await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, target)
  }
}

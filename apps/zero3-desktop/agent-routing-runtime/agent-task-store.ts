import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { zero3AtomicWriteFile } from '../workspace-runtime/atomic-file'
import type { Zero3ResolvedTaskSkill } from '../skill-runtime/skill-types'

import type {
  Zero3CrossAgentBinding,
  Zero3ExecutionResultV2,
  Zero3ExecutorFailureClass,
  Zero3FastPathTelemetry,
  Zero3ResolvedAgentTarget,
  Zero3ReviewState,
  Zero3TaskImportance,
  Zero3TaskSpecV2
} from './agent-contracts'
import type { ExecutorFailureCode } from '../executor-runtime/executor-types'
import type {
  Zero3IntelligentRouteDecision,
  Zero3RoutingMode,
  Zero3VerificationProfileName
} from './intelligent-router-contracts'

export type Zero3AgentTaskState =
  | Zero3ReviewState
  | 'OUTCOME_UNKNOWN'
  | 'FAILED'

// One executor attempt under a stable Task identity. Executor switches append
// attempts; they never create a new task or change taskId/executionId.
export type Zero3TaskAttemptRecord = {
  attemptId: string
  attempt: number
  executor: string
  provider: Zero3ResolvedAgentTarget
  routingMode: Zero3RoutingMode
  importance: Zero3TaskImportance
  verificationProfile: Zero3VerificationProfileName
  startedAt: string
  finishedAt: string | null
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'OUTCOME_UNKNOWN'
  conversationId?: string | null
  failureReason?: string | null
  failoverReason?: string | null
  // Concrete executor instance (for example the Zero3 API profile id) so a
  // failover chain names the exact executor that ran each attempt.
  executorId?: string | null
  // Classified failure. Optional: attempts written before P1 carry only
  // `failureReason`, and those records must keep loading unchanged.
  failureCode?: ExecutorFailureCode | null
  failureClass?: Zero3ExecutorFailureClass | null
}

export type Zero3RoutingMeta = {
  importance: Zero3TaskImportance
  verificationProfile: Zero3VerificationProfileName
}

export type Zero3AgentTaskRecord = {
  task: Zero3TaskSpecV2
  resolvedTarget: Zero3ResolvedAgentTarget
  state: Zero3AgentTaskState
  binding: Zero3CrossAgentBinding | null
  result: Zero3ExecutionResultV2 | null
  skillsUsed: Zero3ResolvedTaskSkill[]
  remoteTaskId: string | null
  remoteExecutionId: string | null
  createdAt: string
  updatedAt: string
  // Intelligent-routing observability. Optional so records written before the
  // Intelligent Agent Task Router still load unchanged.
  importance?: Zero3TaskImportance
  verificationProfile?: Zero3VerificationProfileName
  routingDecisions?: Zero3IntelligentRouteDecision[]
  attempts?: Zero3TaskAttemptRecord[]
  fastPathTelemetry?: Zero3FastPathTelemetry | null
}

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ROUTING_DECISIONS = 20
const MAX_ATTEMPTS = 50

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
      value.skillsUsed ??= []
      value.routingDecisions ??= []
      value.attempts ??= []
      return clone(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  create(task: Zero3TaskSpecV2, resolvedTarget: Zero3ResolvedAgentTarget): Promise<Zero3AgentTaskRecord> {
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
        skillsUsed: [],
        remoteTaskId: null,
        remoteExecutionId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        importance: task.importance ?? 'normal',
        verificationProfile: 'standard',
        routingDecisions: [],
        attempts: []
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


  setSkills(taskId: string, skills: readonly Zero3ResolvedTaskSkill[]): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({ ...current, skillsUsed: structuredClone([...skills]) }))
  }

  setResult(taskId: string, result: Zero3ExecutionResultV2, state: Zero3AgentTaskState): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => {
      if (result.taskId !== current.task.taskId || result.executionId !== current.task.executionId) {
        throw new Error('execution result identity mismatch')
      }
      return { ...current, result: clone(result), state }
    })
  }

  setRemoteMapping(taskId: string, remoteTaskId: string, remoteExecutionId: string): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({
      ...current,
      remoteTaskId: validId(remoteTaskId, 'remoteTaskId'),
      remoteExecutionId: validId(remoteExecutionId, 'remoteExecutionId')
    }))
  }

  setRoutingMeta(taskId: string, meta: Zero3RoutingMeta): Promise<Zero3AgentTaskRecord> {    // Deliberately leaves current.task untouched: the TaskSpec must stay
    // byte-identical for idempotent re-dispatch of the same taskId.
    return this.update(taskId, current => ({
      ...current,
      importance: meta.importance,
      verificationProfile: meta.verificationProfile
    }))
  }

  appendRoutingDecision(taskId: string, decision: Zero3IntelligentRouteDecision): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({
      ...current,
      routingDecisions: [...(current.routingDecisions ?? []), structuredClone(decision)].slice(-MAX_ROUTING_DECISIONS)
    }))
  }

  appendAttempt(taskId: string, attempt: Zero3TaskAttemptRecord): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({
      ...current,
      attempts: [...(current.attempts ?? []), structuredClone(attempt)].slice(-MAX_ATTEMPTS)
    }))
  }

  updateAttempt(
    taskId: string,
    attemptId: string,
    patch: Partial<Omit<Zero3TaskAttemptRecord, 'attemptId' | 'attempt'>>
  ): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => {
      const attempts = current.attempts ?? []
      const index = attempts.findIndex(entry => entry.attemptId === attemptId)
      if (index < 0) throw new Error(`attempt ${attemptId} not found for task ${taskId}`)
      const next = [...attempts]
      next[index] = { ...next[index], ...structuredClone(patch) }
      return { ...current, attempts: next }
    })
  }

  // Updated when failover moves work authority to a different executor so the
  // record always reflects the executor that owns (or last owned) the task.
  setFastPathTelemetry(taskId: string, telemetry: Zero3FastPathTelemetry): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({ ...current, fastPathTelemetry: structuredClone(telemetry) }))
  }

  setResolvedTarget(taskId: string, resolvedTarget: Zero3ResolvedAgentTarget): Promise<Zero3AgentTaskRecord> {
    return this.update(taskId, current => ({ ...current, resolvedTarget }))
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
    await zero3AtomicWriteFile(this.file(taskId), serialized)
  }
}

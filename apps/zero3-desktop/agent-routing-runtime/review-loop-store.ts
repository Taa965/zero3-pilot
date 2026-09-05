import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  ZERO3_REVIEW_DECISION_V1,
  ZERO3_REVIEW_PACKET_V1,
  type Zero3CrossAgentBinding,
  type Zero3ExecutionResultV2,
  type Zero3FixRequest,
  type Zero3ReviewDecision,
  type Zero3ReviewPacket,
  type Zero3ReviewState,
  type Zero3TaskSpecV2
} from './agent-contracts'

const MAX_FILE_BYTES = 4 * 1024 * 1024

type ReviewCycle = {
  cycle: number
  packet: Zero3ReviewPacket
  decision: Zero3ReviewDecision | null
  fixRequest: Zero3FixRequest | null
}

type ReviewRecord = {
  taskId: string
  executionId: string
  state: Zero3ReviewState
  binding: Zero3CrossAgentBinding
  cycles: ReviewCycle[]
  createdAt: string
  updatedAt: string
}

function now() { return new Date().toISOString() }
function id(value: unknown, label: string) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error(`${label} is invalid`)
  return text
}
function storageName(logicalId: string) { return createHash('sha256').update(logicalId, 'utf8').digest('hex') }

export class Zero3ReviewLoopStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly root: string) {}

  async get(taskIdValue: unknown): Promise<ReviewRecord | null> {
    const taskId = id(taskIdValue, 'taskId')
    try {
      const buffer = await fs.readFile(this.file(taskId))
      if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('review record exceeds size limit')
      const record = JSON.parse(buffer.toString('utf8')) as ReviewRecord
      if (record.taskId !== taskId) throw new Error('review record identity mismatch')
      return structuredClone(record)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  createReview(task: Zero3TaskSpecV2, result: Zero3ExecutionResultV2, binding: Zero3CrossAgentBinding): Promise<ReviewRecord> {
    return this.mutate(async () => {
      if (task.taskId !== result.taskId || task.executionId !== result.executionId) throw new Error('task/result identity mismatch')
      if (task.projectId !== result.projectId) throw new Error('task/result project mismatch')
      if (task.contextVersion !== result.contextVersion) throw new Error('result contextVersion does not match TaskSpec')
      if (binding.taskId !== task.taskId || binding.projectId !== task.projectId) throw new Error('cross-agent binding does not match task')
      const existing = await this.get(task.taskId)
      if (existing && existing.executionId !== task.executionId) throw new Error('task review record is bound to another execution')
      const nextCycle = (existing?.cycles.at(-1)?.cycle ?? 0) + 1
      const maxCycles = task.reviewPolicy.maxCycles ?? 20
      if (nextCycle > maxCycles) throw new Error(`review cycle limit reached (${maxCycles})`)
      const packet: Zero3ReviewPacket = {
        protocol: ZERO3_REVIEW_PACKET_V1,
        reviewId: `review-${randomUUID()}`,
        taskId: task.taskId,
        executionId: task.executionId,
        cycle: nextCycle,
        originalGoal: task.goal,
        requirements: [...task.requirements],
        constraints: [...task.constraints],
        provider: result.provider,
        resultSummary: result.summary,
        baseSha: result.git?.baseSha ?? task.baseSha ?? null,
        headSha: result.git?.headSha ?? null,
        diffSummary: null,
        changedFiles: [...result.changedFiles],
        artifacts: result.artifacts.map(value => ({ ...value })),
        verification: result.verification.map(value => ({ ...value })),
        knownIssues: [...result.knownIssues],
        blockers: [...result.blockers],
        createdAt: now()
      }
      const timestamp = now()
      const record: ReviewRecord = existing ?? {
        taskId: task.taskId,
        executionId: task.executionId,
        state: 'DRAFT',
        binding: { ...binding },
        cycles: [],
        createdAt: timestamp,
        updatedAt: timestamp
      }
      record.state = 'REVIEW_PENDING'
      record.binding = { ...record.binding, ...binding, updatedAt: timestamp }
      record.cycles.push({ cycle: nextCycle, packet, decision: null, fixRequest: null })
      record.updatedAt = timestamp
      await this.write(record)
      return structuredClone(record)
    })
  }

  submitDecision(taskIdValue: unknown, decision: Zero3ReviewDecision, contextVersion: number): Promise<ReviewRecord> {
    return this.mutate(async () => {
      const taskId = id(taskIdValue, 'taskId')
      if (decision.protocol !== ZERO3_REVIEW_DECISION_V1 || decision.taskId !== taskId) throw new Error('invalid ReviewDecision identity')
      const record = await this.get(taskId)
      if (!record) throw new Error('review record not found')
      const current = record.cycles.at(-1)
      if (!current || current.cycle !== decision.cycle || current.packet.reviewId !== decision.reviewId) throw new Error('ReviewDecision must target the current review cycle')
      if (current.decision) {
        if (JSON.stringify(current.decision) === JSON.stringify(decision)) return record
        throw new Error('current review cycle already has an immutable decision')
      }
      current.decision = structuredClone(decision)
      const timestamp = now()
      switch (decision.decision) {
        case 'APPROVED':
          record.state = 'COMPLETE'
          break
        case 'BLOCKED':
          record.state = 'BLOCKED'
          break
        case 'ESCALATE_HUMAN':
          record.state = 'ESCALATE_HUMAN'
          break
        case 'CHANGES_REQUESTED': {
          if (decision.requiredFixes.length === 0) throw new Error('CHANGES_REQUESTED requires at least one requiredFix')
          current.fixRequest = {
            taskId,
            reviewId: decision.reviewId,
            cycle: decision.cycle + 1,
            target: current.packet.provider,
            logicalSessionId: record.binding.targetLogicalSessionId,
            runtimeConversationId: record.binding.runtimeConversationId ?? null,
            requiredFixes: [...decision.requiredFixes],
            contextVersion,
            createdAt: timestamp
          }
          record.state = 'FIX_DISPATCHED'
          break
        }
      }
      record.updatedAt = timestamp
      await this.write(record)
      return structuredClone(record)
    })
  }

  latestFixRequest(taskIdValue: unknown): Promise<Zero3FixRequest | null> {
    return this.get(taskIdValue).then(record => record?.cycles.at(-1)?.fixRequest ? structuredClone(record.cycles.at(-1)!.fixRequest) : null)
  }

  private file(taskId: string) { return path.join(this.root, `${storageName(id(taskId, 'taskId'))}.json`) }
  private mutate<T>(operation: () => Promise<T>) {
    const task = this.tail.then(operation, operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
  private async write(record: ReviewRecord) {
    const taskId = id(record.taskId, 'taskId')
    const serialized = `${JSON.stringify(record, null, 2)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw new Error('review record exceeds size limit')
    await fs.mkdir(this.root, { recursive: true })
    const target = this.file(taskId)
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
    await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, target)
  }
}

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { Zero3OperationRecord } from './contracts.ts'

const TERMINAL = new Set(['BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export function zero3CapabilityInputFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
}

export class Zero3OperationStore {
  private readonly records = new Map<string, Zero3OperationRecord>()
  private readonly idempotency = new Map<string, string>()
  private readonly operationsDir: string

  constructor(
    root: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.operationsDir = path.join(root, 'operations')
    fs.mkdirSync(this.operationsDir, { recursive: true, mode: 0o700 })
    this.load()
  }

  private load(): void {
    for (const name of fs.readdirSync(this.operationsDir).filter(name => name.endsWith('.json')).sort()) {
      const file = path.join(this.operationsDir, name)
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Zero3OperationRecord
      if (!parsed.operationId || !parsed.capability || !parsed.idempotencyKey) continue
      if (!TERMINAL.has(parsed.status)) {
        parsed.status = 'FAILED'
        parsed.completedAt = this.now()
        parsed.error = { code: 'RUNTIME_RESTARTED', message: 'Local Zero3 restarted before this operation completed.' }
        parsed.progress = 1
        atomicWrite(file, parsed)
      }
      this.records.set(parsed.operationId, parsed)
      this.idempotency.set(this.idempotencyKey(parsed.capability, parsed.idempotencyKey), parsed.operationId)
    }
  }

  private idempotencyKey(capability: string, key: string): string {
    return `${capability}\u0000${key}`
  }

  create(record: Zero3OperationRecord): Zero3OperationRecord {
    if (this.records.has(record.operationId)) throw new Error(`operation already exists: ${record.operationId}`)
    const dedupe = this.idempotencyKey(record.capability, record.idempotencyKey)
    if (this.idempotency.has(dedupe)) throw new Error('operation idempotency key already exists')
    this.records.set(record.operationId, structuredClone(record))
    this.idempotency.set(dedupe, record.operationId)
    this.persist(record)
    return structuredClone(record)
  }

  get(operationId: string): Zero3OperationRecord | null {
    const record = this.records.get(operationId)
    return record ? structuredClone(record) : null
  }

  findByIdempotency(capability: string, key: string): Zero3OperationRecord | null {
    const operationId = this.idempotency.get(this.idempotencyKey(capability, key))
    return operationId ? this.get(operationId) : null
  }

  update(operationId: string, update: Partial<Zero3OperationRecord>): Zero3OperationRecord {
    const current = this.records.get(operationId)
    if (!current) throw new Error(`operation not found: ${operationId}`)
    const next = { ...current, ...structuredClone(update), operationId: current.operationId }
    this.records.set(operationId, next)
    this.persist(next)
    return structuredClone(next)
  }

  private persist(record: Zero3OperationRecord): void {
    atomicWrite(path.join(this.operationsDir, `${record.operationId}.json`), record)
  }
}

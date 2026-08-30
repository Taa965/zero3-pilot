import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type {
  Zero3RemoteLease,
  Zero3RemoteOutboxEnvelope,
  Zero3RemoteOutboxEventEnvelope,
  Zero3RemoteOutboxTerminalEnvelope,
  Zero3RemoteTerminalState
} from './remote-types'

const MAX_OUTBOX_ENTRIES = 2048
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024
const TERMINAL_STATES = new Set<Zero3RemoteTerminalState>([
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
  'outcome_unknown',
  'quarantined'
])

type CursorFile = {
  schemaVersion: 1
  taskId: string
  executionId: string
  lastSequence: number
}

function safeKey(taskId: string, executionId: string): string {
  return createHash('sha256').update(`${taskId}\u0000${executionId}`).digest('hex')
}

function envelopeText(envelope: Zero3RemoteOutboxEnvelope): string {
  const text = `${JSON.stringify(envelope)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new Error('Zero3 Remote Host outbox envelope exceeds the local size limit')
  }
  return text
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file))
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function parseEnvelope(text: string, file: string): Zero3RemoteOutboxEnvelope {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`invalid Zero3 Remote Host outbox JSON: ${file}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid Zero3 Remote Host outbox envelope: ${file}`)
  }
  const envelope = value as Record<string, unknown>
  if (
    envelope.schemaVersion !== 1 ||
    (envelope.kind !== 'event' && envelope.kind !== 'terminal') ||
    typeof envelope.deliveryId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(envelope.deliveryId) ||
    file !== `${envelope.deliveryId}.json` ||
    typeof envelope.taskId !== 'string' ||
    !envelope.taskId ||
    typeof envelope.executionId !== 'string' ||
    !envelope.executionId ||
    typeof envelope.leaseId !== 'string' ||
    !envelope.leaseId ||
    typeof envelope.fencingToken !== 'number' ||
    !Number.isSafeInteger(envelope.fencingToken) ||
    envelope.fencingToken < 0 ||
    typeof envelope.createdAt !== 'string'
  ) {
    throw new Error(`invalid Zero3 Remote Host outbox envelope fields: ${file}`)
  }
  if (
    envelope.kind === 'event' &&
    (typeof envelope.eventSequence !== 'number' ||
      !Number.isSafeInteger(envelope.eventSequence) ||
      envelope.eventSequence < 1 ||
      typeof envelope.eventType !== 'string' ||
      !envelope.eventType)
  ) {
    throw new Error(`invalid Zero3 Remote Host event envelope: ${file}`)
  }
  if (
    envelope.kind === 'terminal' &&
    (typeof envelope.state !== 'string' || !TERMINAL_STATES.has(envelope.state as Zero3RemoteTerminalState))
  ) {
    throw new Error(`invalid Zero3 Remote Host terminal envelope: ${file}`)
  }
  return envelope as unknown as Zero3RemoteOutboxEnvelope
}

function compareEnvelopes(left: Zero3RemoteOutboxEnvelope, right: Zero3RemoteOutboxEnvelope): number {
  const byTime = left.createdAt.localeCompare(right.createdAt)
  if (byTime !== 0) return byTime

  if (left.taskId === right.taskId && left.executionId === right.executionId) {
    if (left.kind === 'event' && right.kind === 'event') return left.eventSequence - right.eventSequence
    if (left.kind === 'event' && right.kind === 'terminal') return -1
    if (left.kind === 'terminal' && right.kind === 'event') return 1
  }

  return left.deliveryId.localeCompare(right.deliveryId)
}

export class Zero3RemoteOutbox {
  private readonly pendingDir: string
  private readonly cursorDir: string
  private readonly quarantineDir: string

  constructor(private readonly rootDir: string) {
    this.pendingDir = path.join(rootDir, 'pending')
    this.cursorDir = path.join(rootDir, 'cursors')
    this.quarantineDir = path.join(rootDir, 'quarantine')
  }

  async count(): Promise<number> {
    return (await this.pendingFiles()).length
  }

  async list(): Promise<Zero3RemoteOutboxEnvelope[]> {
    const files = await this.pendingFiles()
    const envelopes: Zero3RemoteOutboxEnvelope[] = []
    for (const file of files) {
      envelopes.push(parseEnvelope(await fs.readFile(path.join(this.pendingDir, file), 'utf8'), file))
    }
    return envelopes.sort(compareEnvelopes)
  }

  async enqueueEvent(lease: Zero3RemoteLease, eventType: string, payload: unknown): Promise<Zero3RemoteOutboxEventEnvelope> {
    await this.assertCapacity()
    const eventSequence = await this.nextEventSequence(lease.task.task_id, lease.task.execution_id)
    const envelope: Zero3RemoteOutboxEventEnvelope = {
      schemaVersion: 1,
      kind: 'event',
      deliveryId: randomUUID(),
      taskId: lease.task.task_id,
      executionId: lease.task.execution_id,
      leaseId: lease.lease_id,
      fencingToken: lease.fencing_token,
      createdAt: new Date().toISOString(),
      eventSequence,
      eventType,
      payload
    }
    await this.persist(envelope)
    await this.writeCursor(lease.task.task_id, lease.task.execution_id, eventSequence)
    return envelope
  }

  async enqueueTerminal(
    lease: Zero3RemoteLease,
    state: Zero3RemoteTerminalState,
    result: unknown
  ): Promise<Zero3RemoteOutboxTerminalEnvelope> {
    await this.assertCapacity()
    const envelope: Zero3RemoteOutboxTerminalEnvelope = {
      schemaVersion: 1,
      kind: 'terminal',
      deliveryId: randomUUID(),
      taskId: lease.task.task_id,
      executionId: lease.task.execution_id,
      leaseId: lease.lease_id,
      fencingToken: lease.fencing_token,
      createdAt: new Date().toISOString(),
      state,
      result
    }
    await this.persist(envelope)
    return envelope
  }

  async ack(deliveryId: string): Promise<void> {
    await fs.rm(this.envelopeFile(deliveryId), { force: true })
  }

  async quarantine(envelope: Zero3RemoteOutboxEnvelope, reason: string): Promise<void> {
    await ensureDir(this.quarantineDir)
    const source = this.envelopeFile(envelope.deliveryId)
    const target = path.join(this.quarantineDir, `${envelope.deliveryId}.json`)
    try {
      await fs.rename(source, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
    await atomicWrite(
      path.join(this.quarantineDir, `${envelope.deliveryId}.reason.json`),
      `${JSON.stringify({ quarantinedAt: new Date().toISOString(), reason })}\n`
    )
  }

  private async persist(envelope: Zero3RemoteOutboxEnvelope): Promise<void> {
    await atomicWrite(this.envelopeFile(envelope.deliveryId), envelopeText(envelope))
  }

  private envelopeFile(deliveryId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw new Error('invalid Zero3 Remote Host outbox delivery id')
    return path.join(this.pendingDir, `${deliveryId}.json`)
  }

  private async pendingFiles(): Promise<string[]> {
    try {
      return (await fs.readdir(this.pendingDir)).filter(file => /^[0-9a-f-]{36}\.json$/i.test(file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async assertCapacity(): Promise<void> {
    if ((await this.count()) >= MAX_OUTBOX_ENTRIES) {
      throw new Error(`Zero3 Remote Host outbox reached its ${MAX_OUTBOX_ENTRIES}-entry safety limit`)
    }
  }

  private async nextEventSequence(taskId: string, executionId: string): Promise<number> {
    const persisted = await this.readCursor(taskId, executionId)
    let pendingMaximum = 0
    for (const envelope of await this.list()) {
      if (
        envelope.kind === 'event' &&
        envelope.taskId === taskId &&
        envelope.executionId === executionId &&
        envelope.eventSequence > pendingMaximum
      ) {
        pendingMaximum = envelope.eventSequence
      }
    }
    return Math.max(persisted, pendingMaximum) + 1
  }

  private cursorFile(taskId: string, executionId: string): string {
    return path.join(this.cursorDir, `${safeKey(taskId, executionId)}.json`)
  }

  private async readCursor(taskId: string, executionId: string): Promise<number> {
    const file = this.cursorFile(taskId, executionId)
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<CursorFile>
      if (
        parsed.schemaVersion !== 1 ||
        parsed.taskId !== taskId ||
        parsed.executionId !== executionId ||
        !Number.isSafeInteger(parsed.lastSequence) ||
        Number(parsed.lastSequence) < 0
      ) {
        throw new Error(`invalid Zero3 Remote Host event cursor: ${file}`)
      }
      return Number(parsed.lastSequence)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }

  private async writeCursor(taskId: string, executionId: string, lastSequence: number): Promise<void> {
    const cursor: CursorFile = { schemaVersion: 1, taskId, executionId, lastSequence }
    await atomicWrite(this.cursorFile(taskId, executionId), `${JSON.stringify(cursor)}\n`)
  }
}

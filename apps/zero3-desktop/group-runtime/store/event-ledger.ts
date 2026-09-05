import { open } from 'node:fs/promises'

import type { GroupEvent } from '../contracts/index.ts'
import { appendLineFsync, checksumPayload, stableJson, DurableStoreCorruptionError } from './atomic-file.ts'

export const ZERO3_GROUP_EVENT_RECORD = 'zero3.pilot.group-event-record.v1' as const

interface PersistedGroupEvent {
  schema: typeof ZERO3_GROUP_EVENT_RECORD
  checksum: string
  event: GroupEvent
}

const appendQueues = new Map<string, Promise<void>>()

function recordFor(event: GroupEvent): PersistedGroupEvent {
  return { schema: ZERO3_GROUP_EVENT_RECORD, checksum: checksumPayload(event), event }
}

function parseEventLine(line: string, source: string, lineNumber: number): GroupEvent {
  let record: PersistedGroupEvent
  try {
    record = JSON.parse(line) as PersistedGroupEvent
  } catch (error) {
    throw new DurableStoreCorruptionError(`${source}:${lineNumber} is invalid JSON: ${String(error)}`)
  }
  if (record?.schema !== ZERO3_GROUP_EVENT_RECORD || typeof record.checksum !== 'string' || !record.event) {
    throw new DurableStoreCorruptionError(`${source}:${lineNumber} has an unsupported event envelope`)
  }
  if (checksumPayload(record.event) !== record.checksum) {
    throw new DurableStoreCorruptionError(`${source}:${lineNumber} event checksum mismatch`)
  }
  if (!Number.isSafeInteger(record.event.sequence) || record.event.sequence < 1) {
    throw new DurableStoreCorruptionError(`${source}:${lineNumber} event sequence is invalid`)
  }
  if (!record.event.eventId?.trim() || !record.event.groupId?.trim()) {
    throw new DurableStoreCorruptionError(`${source}:${lineNumber} event identity is invalid`)
  }
  return record.event
}

export async function readEventLedger(path: string): Promise<GroupEvent[]> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  try {
    const text = await handle.readFile('utf8')
    const lines = text.split(/\r?\n/u).filter(Boolean)
    const events = lines.map((line, index) => parseEventLine(line, path, index + 1))
    const ids = new Set<string>()
    let expected = 1
    for (const event of events) {
      if (event.sequence !== expected) {
        throw new DurableStoreCorruptionError(`${path} event sequence gap/regression: expected ${expected}, got ${event.sequence}`)
      }
      if (ids.has(event.eventId)) throw new DurableStoreCorruptionError(`${path} contains duplicate event id ${event.eventId}`)
      ids.add(event.eventId)
      expected += 1
    }
    return events
  } finally {
    await handle.close()
  }
}

async function appendGroupEventSerialized(path: string, event: GroupEvent): Promise<'appended' | 'duplicate'> {
  const events = await readEventLedger(path)
  const existing = events.find(candidate => candidate.eventId === event.eventId)
  if (existing) {
    if (stableJson(existing) === stableJson(event)) return 'duplicate'
    throw new DurableStoreCorruptionError(`event id ${event.eventId} was reused with different content`)
  }
  const expected = events.length + 1
  if (event.sequence !== expected) {
    throw new DurableStoreCorruptionError(`event ${event.eventId} sequence must be ${expected}; got ${event.sequence}`)
  }
  await appendLineFsync(path, JSON.stringify(recordFor(event)))
  return 'appended'
}

export async function appendGroupEvent(path: string, event: GroupEvent): Promise<'appended' | 'duplicate'> {
  const previous = appendQueues.get(path) ?? Promise.resolve()
  let result: 'appended' | 'duplicate' = 'appended'
  const current = previous.then(async () => {
    result = await appendGroupEventSerialized(path, event)
  })
  appendQueues.set(path, current)
  try {
    await current
    return result
  } finally {
    if (appendQueues.get(path) === current) appendQueues.delete(path)
  }
}

export async function nextEventSequence(path: string): Promise<number> {
  return (await readEventLedger(path)).length + 1
}

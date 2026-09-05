import { createHash } from 'node:crypto'
import type { Zero3HandoffCheckpointV1 } from './handoff-types.ts'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    )
  }
  return value
}

export function checkpointHash(checkpoint: Omit<Zero3HandoffCheckpointV1, 'checkpoint_hash'>): string {
  const payload = JSON.stringify(canonicalize(checkpoint))
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function verifyCheckpointHash(checkpoint: Zero3HandoffCheckpointV1): boolean {
  const { checkpoint_hash: expected, ...unsigned } = checkpoint
  return expected.length === 64 && checkpointHash(unsigned) === expected
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

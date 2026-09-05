import { createHash } from 'node:crypto'

import type { DevelopmentGroupPolicy, FailureRecord, RepairTask } from '../contracts/index.ts'

function repairId(groupId: string, waveOrdinal: number, failureIds: readonly string[], owners: readonly string[]): string {
  return `R-${createHash('sha256').update(`${groupId}:${waveOrdinal}:${[...failureIds].sort().join(',')}:${[...owners].sort().join(',')}`).digest('hex').slice(0, 16)}`
}

export function planRepairWave(input: {
  groupId: string
  waveOrdinal: number
  failures: readonly FailureRecord[]
  policy: DevelopmentGroupPolicy
}): readonly RepairTask[] {
  if (!Number.isSafeInteger(input.waveOrdinal) || input.waveOrdinal < 1 || input.waveOrdinal > input.policy.maxRepairWaves) {
    throw new Error('repair wave ordinal exceeds frozen budget')
  }
  const unresolved = input.failures.filter(failure => failure.unresolved)
  const buckets = new Map<string, FailureRecord[]>()
  for (const failure of unresolved) {
    const owners = failure.ownerSessionIds.length > 0 ? [...failure.ownerSessionIds].sort() : []
    const overBudget = failure.attempts >= input.policy.maxSameFailureAttempts || failure.kind === 'outcome_unknown'
    const key = overBudget || owners.length === 0 ? `human:${failure.failureId}` : `owners:${owners.join(',')}`
    const bucket = buckets.get(key) ?? []
    bucket.push(failure)
    buckets.set(key, bucket)
  }

  const tasks = [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, failures]) => {
    const ownerSessionIds = [...new Set(failures.flatMap(failure => failure.ownerSessionIds))].sort()
    const waitingHuman = key.startsWith('human:')
    const failureIds = failures.map(failure => failure.failureId).sort()
    const objective = waitingHuman
      ? `Human resolution required for: ${failures.map(failure => failure.message).join('; ')}`
      : `Repair attributed failures without widening scope: ${failures.map(failure => failure.message).join('; ')}`
    return {
      repairTaskId: repairId(input.groupId, input.waveOrdinal, failureIds, ownerSessionIds),
      groupId: input.groupId,
      waveOrdinal: input.waveOrdinal,
      failureIds,
      ownerSessionIds,
      objective,
      status: waitingHuman ? 'waiting_human' as const : 'planned' as const
    } satisfies RepairTask
  })

  const automated = tasks.filter(task => task.status === 'planned')
  if (automated.length > input.policy.maxRepairSessions) throw new Error(`repair session budget exceeded: ${automated.length} > ${input.policy.maxRepairSessions}`)
  return tasks
}

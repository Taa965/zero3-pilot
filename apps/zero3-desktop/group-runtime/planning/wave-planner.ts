import type { DevelopmentRequirement, DevelopmentWave } from '../contracts/index.ts'
import type { SessionPartition } from './session-partitioner.ts'

export interface SessionDependencyPlan {
  sessionId: string
  dependsOn: readonly string[]
}

export function deriveSessionDependencies(
  requirements: readonly DevelopmentRequirement[],
  partitions: readonly SessionPartition[]
): SessionDependencyPlan[] {
  const owner = new Map<string, string>()
  for (const partition of partitions) {
    for (const requirementId of partition.requirementIds) owner.set(requirementId, partition.key)
  }
  const dependencies = new Map(partitions.map(partition => [partition.key, new Set<string>()] as const))
  for (const requirement of requirements) {
    const sessionId = owner.get(requirement.requirementId)
    if (!sessionId) throw new Error(`requirement ${requirement.requirementId} has no partition`)
    for (const requirementDependency of requirement.dependencies) {
      const dependencySession = owner.get(requirementDependency)
      if (!dependencySession) throw new Error(`requirement dependency ${requirementDependency} has no partition`)
      if (dependencySession !== sessionId) dependencies.get(sessionId)?.add(dependencySession)
    }
  }
  return partitions.map(partition => ({ sessionId: partition.key, dependsOn: [...(dependencies.get(partition.key) ?? [])].sort() }))
}

export function planWaves(
  groupId: string,
  partitions: readonly SessionPartition[],
  dependencies: readonly SessionDependencyPlan[]
): DevelopmentWave[] {
  const dependencyMap = new Map(dependencies.map(item => [item.sessionId, item.dependsOn] as const))
  const known = new Set(partitions.map(partition => partition.key))
  const remaining = new Set(known)
  const completed = new Set<string>()
  const waves: DevelopmentWave[] = []

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(sessionId => (dependencyMap.get(sessionId) ?? []).every(dependency => completed.has(dependency)))
      .sort()
    if (ready.length === 0) throw new Error('session dependency graph contains a cycle')
    const waveId = `W${String(waves.length + 1).padStart(2, '0')}`
    waves.push({
      groupId,
      waveId,
      ordinal: waves.length + 1,
      sessionIds: ready,
      requiredSessionIds: ready,
      dependsOnWaveIds: waves.length === 0 ? [] : [waves[waves.length - 1].waveId]
    })
    ready.forEach(sessionId => {
      remaining.delete(sessionId)
      completed.add(sessionId)
    })
  }
  return waves
}

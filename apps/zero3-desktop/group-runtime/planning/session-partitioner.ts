import type { DevelopmentRequirement } from '../contracts/index.ts'
import { normalizePlanningPathScope, planningScopeOverlapScore } from './path-scope.ts'
import type { PlanningModuleHint } from './planning-types.ts'

export interface SessionPartitionPolicy {
  maxSessions: number
  targetRequirementsPerSession?: number
}

export interface SessionPartition {
  key: string
  requirementIds: readonly string[]
  pathHints: readonly string[]
  tags: readonly string[]
}

interface MutablePartition {
  key: string
  requirementIds: string[]
  pathHints: Set<string>
  tags: Set<string>
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function exactOverlap(a: Set<string>, b: readonly string[]): number {
  let score = 0
  for (const value of b) if (a.has(value)) score += 1
  return score
}

export function partitionRequirements(
  requirements: readonly DevelopmentRequirement[],
  hints: readonly PlanningModuleHint[],
  policy: SessionPartitionPolicy
): SessionPartition[] {
  const maxSessions = positive(policy.maxSessions, 'maxSessions')
  const targetSize = positive(policy.targetRequirementsPerSession ?? 4, 'targetRequirementsPerSession')
  if (requirements.length === 0) return []

  const hintByRequirement = new Map(hints.map(hint => [hint.requirementId, hint] as const))
  const requirementById = new Map(requirements.map(requirement => [requirement.requirementId, requirement] as const))
  const desiredCount = Math.min(maxSessions, Math.max(1, Math.ceil(requirements.length / targetSize)))
  const hardCapacity = Math.max(targetSize, Math.ceil(requirements.length / desiredCount))
  const partitions: MutablePartition[] = Array.from({ length: desiredCount }, (_, index) => ({
    key: `S${String(index + 1).padStart(2, '0')}`,
    requirementIds: [],
    pathHints: new Set(),
    tags: new Set()
  }))
  const ownerByRequirement = new Map<string, number>()

  const ordered = [...requirements].sort((left, right) => left.requirementId.localeCompare(right.requirementId))
  for (const requirement of ordered) {
    const hint = hintByRequirement.get(requirement.requirementId)
    const pathHints = [...new Set((hint?.pathHints ?? []).map(normalizePlanningPathScope).filter(Boolean))]
    const tags = [...new Set((hint?.tags ?? []).map(value => value.trim()).filter(Boolean))]

    let selected = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let index = 0; index < partitions.length; index += 1) {
      const partition = partitions[index]
      if (partition.requirementIds.length >= hardCapacity && partitions.some(candidate => candidate.requirementIds.length < hardCapacity)) continue
      let score = planningScopeOverlapScore(partition.pathHints, pathHints) * 8 + exactOverlap(partition.tags, tags) * 4
      for (const dependency of requirement.dependencies) {
        if (ownerByRequirement.get(dependency) === index) score += 5
      }
      score -= partition.requirementIds.length
      if (score > bestScore || (score === bestScore && partition.key < partitions[selected].key)) {
        selected = index
        bestScore = score
      }
    }

    const partition = partitions[selected]
    partition.requirementIds.push(requirement.requirementId)
    pathHints.forEach(path => partition.pathHints.add(path))
    tags.forEach(tag => partition.tags.add(tag))
    ownerByRequirement.set(requirement.requirementId, selected)
  }

  const result = partitions
    .filter(partition => partition.requirementIds.length > 0)
    .map(partition => ({
      key: partition.key,
      requirementIds: [...partition.requirementIds],
      pathHints: [...partition.pathHints].sort(),
      tags: [...partition.tags].sort()
    }))

  const assigned = new Set(result.flatMap(partition => partition.requirementIds))
  if (assigned.size !== requirementById.size) throw new Error('session partition lost or duplicated requirements')
  return result
}

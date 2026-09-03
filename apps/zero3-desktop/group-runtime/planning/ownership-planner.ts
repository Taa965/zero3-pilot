import { normalizePlanningPathScope, planningPathScopesMayOverlap } from './path-scope.ts'
import type { PlanningModuleHint } from './planning-types.ts'
import type { SessionPartition } from './session-partitioner.ts'

export interface OwnershipPlan {
  sessionId: string
  ownedPaths: readonly string[]
  readOnlyPaths: readonly string[]
  forbiddenPaths: readonly string[]
}

export function planOwnership(
  partitions: readonly SessionPartition[],
  hints: readonly PlanningModuleHint[],
  protectedPaths: readonly string[],
  redZonePaths: readonly string[] = []
): { ownership: OwnershipPlan[]; sharedPaths: readonly string[] } {
  const hintByRequirement = new Map(hints.map(hint => [hint.requirementId, hint] as const))
  const candidateByPartition = new Map<string, string[]>()

  for (const partition of partitions) {
    candidateByPartition.set(
      partition.key,
      [...new Set(partition.requirementIds
        .flatMap(id => hintByRequirement.get(id)?.pathHints ?? [])
        .map(normalizePlanningPathScope)
        .filter(Boolean))].sort()
    )
  }

  const shared = new Set<string>()
  for (let leftIndex = 0; leftIndex < partitions.length; leftIndex += 1) {
    const left = candidateByPartition.get(partitions[leftIndex].key) ?? []
    for (let rightIndex = leftIndex + 1; rightIndex < partitions.length; rightIndex += 1) {
      const right = candidateByPartition.get(partitions[rightIndex].key) ?? []
      for (const leftPath of left) {
        for (const rightPath of right) {
          if (!planningPathScopesMayOverlap(leftPath, rightPath)) continue
          shared.add(leftPath)
          shared.add(rightPath)
        }
      }
    }
  }

  const protectedAll = [...new Set([...protectedPaths, ...redZonePaths].map(normalizePlanningPathScope).filter(Boolean))]
  const sharedPaths = [...shared].sort()

  const ownership = partitions.map(partition => {
    const candidatePaths = candidateByPartition.get(partition.key) ?? []
    const forbiddenPaths = [...new Set(protectedAll.filter(protectedPath =>
      candidatePaths.some(candidate => planningPathScopesMayOverlap(candidate, protectedPath))
    ))].sort()
    const conflictsProtected = (path: string) => forbiddenPaths.some(forbidden => planningPathScopesMayOverlap(path, forbidden))
    const readOnlyPaths = candidatePaths.filter(path => shared.has(path) && !conflictsProtected(path)).sort()
    const ownedPaths = candidatePaths.filter(path => !shared.has(path) && !conflictsProtected(path)).sort()
    return { sessionId: partition.key, ownedPaths, readOnlyPaths, forbiddenPaths }
  })

  return { ownership, sharedPaths }
}

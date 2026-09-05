import type { PlanningModuleHint } from './planning-types.ts'
import type { SessionPartition } from './session-partitioner.ts'

export interface OwnershipPlan {
  sessionId: string
  ownedPaths: readonly string[]
  readOnlyPaths: readonly string[]
  forbiddenPaths: readonly string[]
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function matchesProtected(path: string, protectedPath: string): boolean {
  const candidate = normalizePath(path)
  const protectedCandidate = normalizePath(protectedPath)
  return candidate === protectedCandidate || candidate.startsWith(`${protectedCandidate}/`) || protectedCandidate.startsWith(`${candidate}/`)
}

export function planOwnership(
  partitions: readonly SessionPartition[],
  hints: readonly PlanningModuleHint[],
  protectedPaths: readonly string[],
  redZonePaths: readonly string[] = []
): { ownership: OwnershipPlan[]; sharedPaths: readonly string[] } {
  const hintByRequirement = new Map(hints.map(hint => [hint.requirementId, hint] as const))
  const pathOwners = new Map<string, Set<string>>()

  for (const partition of partitions) {
    for (const requirementId of partition.requirementIds) {
      for (const path of hintByRequirement.get(requirementId)?.pathHints ?? []) {
        const normalized = normalizePath(path)
        if (!normalized) continue
        const owners = pathOwners.get(normalized) ?? new Set<string>()
        owners.add(partition.key)
        pathOwners.set(normalized, owners)
      }
    }
  }

  const protectedAll = [...new Set([...protectedPaths, ...redZonePaths].map(normalizePath).filter(Boolean))]
  const sharedPaths = [...pathOwners.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([path]) => path)
    .sort()

  const ownership = partitions.map(partition => {
    const candidatePaths = [...new Set(partition.requirementIds.flatMap(id => hintByRequirement.get(id)?.pathHints ?? []).map(normalizePath).filter(Boolean))]
    const forbiddenPaths = [...new Set(protectedAll.filter(path => candidatePaths.some(candidate => matchesProtected(candidate, path))))].sort()
    const readOnlyPaths = candidatePaths.filter(path => sharedPaths.includes(path) && !forbiddenPaths.some(forbidden => matchesProtected(path, forbidden))).sort()
    const ownedPaths = candidatePaths.filter(path => !sharedPaths.includes(path) && !forbiddenPaths.some(forbidden => matchesProtected(path, forbidden))).sort()
    return { sessionId: partition.key, ownedPaths, readOnlyPaths, forbiddenPaths }
  })

  return { ownership, sharedPaths }
}

import {
  ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  ZERO3_DEVELOPMENT_SESSION_CONTRACT,
  validateDevelopmentGroupDefinition,
  type DevelopmentSessionDefinition,
  type DevelopmentWave,
  type ValidationIssue
} from '../contracts/index.ts'
import { planOwnership } from './ownership-planner.ts'
import { normalizeRequirementProposals, stablePlanHash } from './requirement-normalizer.ts'
import { partitionRequirements, type SessionPartition } from './session-partitioner.ts'
import type { ControllerPlanningProposal, PlanningProposal, PlanningRequest, SessionProposal, WaveProposal } from './planning-types.ts'
import { deriveSessionDependencies, planWaves, type SessionDependencyPlan } from './wave-planner.ts'

export class PlanningValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`planning proposal failed C1 validation: ${issues.map(item => `${item.code}@${item.path}`).join(', ')}`)
  }
}

export interface CompilePlanningOptions {
  groupId?: string
  createdAt?: string
}

function normalizedSessionId(index: number, explicit?: string): string {
  const value = explicit?.trim()
  return value || `S${String(index + 1).padStart(2, '0')}`
}

function normalizeControllerPartitions(
  sessions: readonly SessionProposal[],
  hints: ReadonlyMap<string, { pathHints: readonly string[]; tags: readonly string[] }>
): SessionPartition[] {
  return sessions.map((session, index) => {
    const key = normalizedSessionId(index, session.id)
    const requirementIds = [...new Set(session.requirementIds.map(value => value.trim()).filter(Boolean))]
    if (!session.objective.trim() || requirementIds.length === 0) throw new Error(`controller session ${key} is missing objective or requirements`)
    return {
      key,
      requirementIds,
      pathHints: [...new Set(requirementIds.flatMap(id => hints.get(id)?.pathHints ?? []))].sort(),
      tags: [...new Set(requirementIds.flatMap(id => hints.get(id)?.tags ?? []))].sort()
    }
  })
}

function normalizeControllerDependencies(
  partitions: readonly SessionPartition[],
  proposals: readonly SessionProposal[],
  derived: readonly SessionDependencyPlan[]
): SessionDependencyPlan[] {
  const derivedMap = new Map(derived.map(item => [item.sessionId, item.dependsOn] as const))
  return partitions.map((partition, index) => ({
    sessionId: partition.key,
    dependsOn: proposals[index].dependencies
      ? [...new Set(proposals[index].dependencies?.map(value => value.trim()).filter(Boolean))].sort()
      : derivedMap.get(partition.key) ?? []
  }))
}

function normalizeControllerWaves(
  groupId: string,
  proposals: readonly WaveProposal[]
): DevelopmentWave[] {
  return proposals.map((proposal, index) => {
    const waveId = proposal.id?.trim() || `W${String(index + 1).padStart(2, '0')}`
    const sessionIds = [...new Set(proposal.sessionIds.map(value => value.trim()).filter(Boolean))]
    return {
      groupId,
      waveId,
      ordinal: index + 1,
      sessionIds,
      requiredSessionIds: [...new Set((proposal.requiredSessionIds ?? sessionIds).map(value => value.trim()).filter(Boolean))],
      dependsOnWaveIds: [...new Set((proposal.dependsOnWaveIds ?? (index === 0 ? [] : [`W${String(index).padStart(2, '0')}`])).map(value => value.trim()).filter(Boolean))]
    }
  })
}

export function compilePlanningProposal(
  request: PlanningRequest,
  controllerProposal: ControllerPlanningProposal,
  options: CompilePlanningOptions = {}
): PlanningProposal {
  const hash = stablePlanHash({ request, controllerProposal })
  const groupId = options.groupId?.trim() || `G-${hash.slice(0, 12)}`
  const createdAt = options.createdAt ?? new Date().toISOString()
  const { requirements, hints } = normalizeRequirementProposals(groupId, controllerProposal.requirements)
  const hintMap = new Map(hints.map(hint => [hint.requirementId, hint] as const))

  const partitions = controllerProposal.sessions?.length
    ? normalizeControllerPartitions(controllerProposal.sessions, hintMap)
    : partitionRequirements(requirements, hints, { maxSessions: request.policy.maxParallelSessions + 2, targetRequirementsPerSession: 4 })

  const derivedDependencies = deriveSessionDependencies(requirements, partitions)
  const dependencies = controllerProposal.sessions?.length
    ? normalizeControllerDependencies(partitions, controllerProposal.sessions, derivedDependencies)
    : derivedDependencies
  const dependencyMap = new Map(dependencies.map(item => [item.sessionId, item.dependsOn] as const))

  const waves = controllerProposal.waves?.length
    ? normalizeControllerWaves(groupId, controllerProposal.waves)
    : planWaves(groupId, partitions, dependencies)
  const waveBySession = new Map<string, string>()
  for (const wave of waves) for (const sessionId of wave.sessionIds) waveBySession.set(sessionId, wave.waveId)

  const ownershipPlan = planOwnership(
    partitions,
    hints,
    request.policy.protectedPaths,
    controllerProposal.redZonePaths ?? []
  )
  const ownershipBySession = new Map(ownershipPlan.ownership.map(item => [item.sessionId, item] as const))
  const proposalById = new Map((controllerProposal.sessions ?? []).map((item, index) => [normalizedSessionId(index, item.id), item] as const))

  const sessions: DevelopmentSessionDefinition[] = partitions.map(partition => {
    const explicit = proposalById.get(partition.key)
    const ownership = ownershipBySession.get(partition.key)
    const requirementSet = requirements.filter(requirement => partition.requirementIds.includes(requirement.requirementId))
    const waveId = waveBySession.get(partition.key)
    if (!waveId) throw new Error(`session ${partition.key} is not assigned to a wave`)
    return {
      contract: ZERO3_DEVELOPMENT_SESSION_CONTRACT,
      groupId,
      sessionId: partition.key,
      executionId: `${groupId}:${partition.key}:attempt-1`,
      waveId,
      objective: explicit?.objective.trim() || `Implement ${requirementSet.map(item => item.title).join('; ')}`,
      baselineSha: request.baselineSha,
      integrationRef: request.integrationRef,
      branch: `dg/${groupId.toLowerCase()}/${partition.key.toLowerCase()}`,
      worktree: `.zero3/worktrees/${groupId}/${partition.key}`,
      ownedPaths: explicit?.ownedPaths?.length ? [...new Set(explicit.ownedPaths.map(value => value.trim()).filter(Boolean))] : ownership?.ownedPaths ?? [],
      readOnlyPaths: explicit?.readOnlyPaths?.length ? [...new Set(explicit.readOnlyPaths.map(value => value.trim()).filter(Boolean))] : ownership?.readOnlyPaths ?? [],
      forbiddenPaths: [...new Set([...(explicit?.forbiddenPaths ?? []), ...(ownership?.forbiddenPaths ?? []), ...request.policy.protectedPaths].map(value => value.trim()).filter(Boolean))],
      dependencies: dependencyMap.get(partition.key) ?? [],
      requirements: partition.requirementIds,
      inputs: [],
      acceptanceCriteria: [...new Set(requirementSet.flatMap(requirement => requirement.acceptanceCriteria))],
      executorPolicy: {
        executorId: 'native-codex',
        permissionProfile: request.policy.permissionProfile,
        approvalRequired: true
      },
      subagentPolicy: {
        allowed: true,
        maxConcurrency: Math.min(4, request.policy.maxSessionSubagents),
        recursiveGroupCreation: false
      },
      deliveryPolicy: {
        requireCleanHead: true,
        requireOwnershipValidation: true,
        requireHandoff: true,
        requireDeliveryHash: true
      }
    }
  })

  const definition = {
    contract: ZERO3_DEVELOPMENT_GROUP_CONTRACT,
    groupId,
    repository: request.repository.trim(),
    masterGoal: request.masterGoal.trim(),
    masterPrompt: request.masterPrompt.trim(),
    developmentPlan: request.developmentPlan.trim(),
    planHash: hash,
    baselineSha: request.baselineSha,
    integrationRef: request.integrationRef,
    requirementIds: requirements.map(item => item.requirementId),
    waveIds: waves.map(item => item.waveId),
    sessionIds: sessions.map(item => item.sessionId),
    policy: { ...request.policy },
    createdAt
  } as const

  const issues = validateDevelopmentGroupDefinition(definition, requirements, sessions, waves)
  if (issues.length > 0) throw new PlanningValidationError(issues)
  return {
    definition,
    requirements,
    sessions,
    waves,
    redZonePaths: [...new Set([...(controllerProposal.redZonePaths ?? []), ...ownershipPlan.sharedPaths])].sort(),
    notes: [...(controllerProposal.notes ?? [])],
    source: controllerProposal.sessions?.length ? 'controller_proposal' : 'deterministic_fallback'
  }
}

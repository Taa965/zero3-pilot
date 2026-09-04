import type {
  DevelopmentGroupDefinition,
  DevelopmentGroupPolicy,
  DevelopmentRequirement,
  DevelopmentSessionDefinition,
  DevelopmentWave
} from '../contracts/index.ts'

export interface PlanningRequest {
  repository: string
  masterGoal: string
  masterPrompt: string
  developmentPlan: string
  baselineSha: string
  integrationRef: string
  policy: DevelopmentGroupPolicy
}

export interface RequirementProposal {
  id?: string
  title: string
  description: string
  mandatory?: boolean
  acceptanceCriteria: readonly string[]
  sourceAnchor: string
  proposedOwner?: string
  dependencies?: readonly string[]
  pathHints?: readonly string[]
  tags?: readonly string[]
}

export interface SessionProposal {
  id?: string
  objective: string
  requirementIds: readonly string[]
  dependencies?: readonly string[]
  ownedPaths?: readonly string[]
  readOnlyPaths?: readonly string[]
  forbiddenPaths?: readonly string[]
}

export interface WaveProposal {
  id?: string
  sessionIds: readonly string[]
  requiredSessionIds?: readonly string[]
  dependsOnWaveIds?: readonly string[]
}

export interface ControllerPlanningProposal {
  requirements: readonly RequirementProposal[]
  sessions?: readonly SessionProposal[]
  waves?: readonly WaveProposal[]
  redZonePaths?: readonly string[]
  notes?: readonly string[]
}

export interface PlanningProposal {
  definition: DevelopmentGroupDefinition
  requirements: readonly DevelopmentRequirement[]
  sessions: readonly DevelopmentSessionDefinition[]
  waves: readonly DevelopmentWave[]
  redZonePaths: readonly string[]
  notes: readonly string[]
  source: 'controller_proposal' | 'deterministic_fallback'
}

export interface PlanningModuleHint {
  requirementId: string
  pathHints: readonly string[]
  tags: readonly string[]
}

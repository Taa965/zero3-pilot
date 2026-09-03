import type {
  DevelopmentDelivery,
  DevelopmentGroupDefinition,
  DevelopmentGroupRuntimeState,
  DevelopmentRequirement,
  DevelopmentSessionDefinition,
  DevelopmentSessionRuntime,
  DevelopmentWave,
  FailureRecord,
  IntegrationMilestone,
  RepairTask,
  VerificationRun
} from '../contracts/index.ts'

export interface GroupListItemView {
  groupId: string
  goal: string
  repository: string
  status: DevelopmentGroupRuntimeState['status']
  activeWaveId?: string
  progress: { verifiedRequirements: number; totalRequirements: number; verifiedSessions: number; totalSessions: number }
  attentionCount: number
}

export interface GroupSessionCardView {
  sessionId: string
  objective: string
  waveId: string
  status: DevelopmentSessionRuntime['status']
  attempt: number
  branch: string
  worktree: string
  requirements: readonly string[]
  dependencies: readonly string[]
  needsAttention: boolean
  blocker?: string
  executorSessionId?: string
}

export interface RequirementMatrixRowView {
  requirementId: string
  title: string
  mandatory: boolean
  ownerSessionId?: string
  deliveryStatus: 'none' | DevelopmentDelivery['status']
  integrated: boolean
  verified: boolean
  testEvidence: readonly string[]
}

export interface WaveView {
  waveId: string
  ordinal: number
  sessionIds: readonly string[]
  dependencies: readonly string[]
  integrated: boolean
}

export interface VerificationView {
  verificationRunId: string
  integrationSha: string
  status: VerificationRun['status']
  passed: number
  failed: number
  notRun: number
}

export interface DevelopmentGroupViewModel {
  summary: GroupListItemView
  sessions: readonly GroupSessionCardView[]
  requirements: readonly RequirementMatrixRowView[]
  waves: readonly WaveView[]
  verifications: readonly VerificationView[]
  failures: readonly FailureRecord[]
  repairs: readonly RepairTask[]
  integrations: readonly IntegrationMilestone[]
}

export function buildDevelopmentGroupViewModel(input: {
  definition: DevelopmentGroupDefinition
  state: DevelopmentGroupRuntimeState
  requirements: readonly DevelopmentRequirement[]
  sessions: readonly DevelopmentSessionDefinition[]
  runtimes: readonly DevelopmentSessionRuntime[]
  deliveries: readonly DevelopmentDelivery[]
  waves: readonly DevelopmentWave[]
  integrations: readonly IntegrationMilestone[]
  verifications: readonly VerificationRun[]
  failures: readonly FailureRecord[]
  repairs: readonly RepairTask[]
}): DevelopmentGroupViewModel {
  const runtimeById = new Map(input.runtimes.map(runtime => [runtime.sessionId, runtime] as const))
  const sessionByRequirement = new Map<string, string>()
  for (const session of input.sessions) for (const requirementId of session.requirements) sessionByRequirement.set(requirementId, session.sessionId)
  const deliveryBySession = new Map(input.deliveries.map(delivery => [delivery.sessionId, delivery] as const))
  const verificationBySha = new Map(input.verifications.filter(run => run.status === 'passed').map(run => [run.integrationSha, run] as const))
  const integratedSessions = new Set(input.integrations.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
  const verifiedSessions = new Set<string>()
  for (const integration of input.integrations) {
    if (integration.status !== 'merged' || !verificationBySha.has(integration.headSha)) continue
    integration.mergedSessionIds.forEach(sessionId => verifiedSessions.add(sessionId))
  }

  const sessions = input.sessions.map(session => {
    const runtime = runtimeById.get(session.sessionId)
    if (!runtime) throw new Error(`missing runtime for ${session.sessionId}`)
    return {
      sessionId: session.sessionId,
      objective: session.objective,
      waveId: session.waveId,
      status: runtime.status,
      attempt: runtime.attempt,
      branch: session.branch,
      worktree: session.worktree,
      requirements: session.requirements,
      dependencies: session.dependencies,
      needsAttention: ['blocked', 'waiting_input', 'outcome_unknown', 'failed'].includes(runtime.status),
      blocker: runtime.blocker,
      executorSessionId: runtime.executorSessionId
    } satisfies GroupSessionCardView
  })

  const requirements = input.requirements.map(requirement => {
    const ownerSessionId = sessionByRequirement.get(requirement.requirementId)
    const delivery = ownerSessionId ? deliveryBySession.get(ownerSessionId) : undefined
    const integration = ownerSessionId ? input.integrations.find(record => record.status === 'merged' && record.mergedSessionIds.includes(ownerSessionId)) : undefined
    const verified = Boolean(integration && verificationBySha.has(integration.headSha))
    return {
      requirementId: requirement.requirementId,
      title: requirement.title,
      mandatory: requirement.mandatory,
      ownerSessionId,
      deliveryStatus: delivery?.status ?? 'none',
      integrated: Boolean(ownerSessionId && integratedSessions.has(ownerSessionId)),
      verified,
      testEvidence: delivery?.testsExecuted ?? []
    } satisfies RequirementMatrixRowView
  })

  return {
    summary: {
      groupId: input.definition.groupId,
      goal: input.definition.masterGoal,
      repository: input.definition.repository,
      status: input.state.status,
      activeWaveId: input.state.activeWaveId,
      progress: {
        verifiedRequirements: requirements.filter(row => row.verified).length,
        totalRequirements: requirements.length,
        verifiedSessions: verifiedSessions.size,
        totalSessions: sessions.length
      },
      attentionCount: sessions.filter(card => card.needsAttention).length + input.failures.filter(failure => failure.unresolved).length
    },
    sessions,
    requirements,
    waves: input.waves.map(wave => ({ waveId: wave.waveId, ordinal: wave.ordinal, sessionIds: wave.sessionIds, dependencies: wave.dependsOnWaveIds, integrated: wave.requiredSessionIds.every(sessionId => integratedSessions.has(sessionId)) })),
    verifications: input.verifications.map(run => ({
      verificationRunId: run.verificationRunId,
      integrationSha: run.integrationSha,
      status: run.status,
      passed: run.results.filter(result => result.status === 'passed').length,
      failed: run.results.filter(result => result.status === 'failed').length,
      notRun: run.results.filter(result => result.status === 'not_run' || result.status === 'not_run_platform').length
    })),
    failures: [...input.failures],
    repairs: [...input.repairs],
    integrations: [...input.integrations]
  }
}

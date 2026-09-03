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

function verificationQualifies(run: VerificationRun, definition: DevelopmentGroupDefinition): boolean {
  if (run.status !== 'passed' || run.policyRevision !== definition.policy.verificationPolicyRevision) return false
  const mandatory = [...new Set(definition.policy.mandatoryTests ?? [])]
  if (mandatory.length === 0) return true
  const requiredCommands = new Set(run.commands.filter(command => command.required).map(command => command.id))
  const passedResults = new Set(run.results.filter(result => result.status === 'passed').map(result => result.commandId))
  return mandatory.every(id => requiredCommands.has(id) && passedResults.has(id))
}

function sessionsCoveredByFinalVerification(integrations: readonly IntegrationMilestone[], finalSha: string): ReadonlySet<string> {
  const byHead = new Map<string, IntegrationMilestone>()
  for (const record of integrations) {
    if (record.status !== 'merged') continue
    const existing = byHead.get(record.headSha)
    if (existing && existing.integrationRunId !== record.integrationRunId) throw new Error(`ambiguous merged IntegrationMilestone head ${record.headSha}`)
    byHead.set(record.headSha, record)
  }
  const sessions = new Set<string>()
  const visited = new Set<string>()
  let cursor = finalSha
  while (true) {
    if (visited.has(cursor)) throw new Error(`IntegrationMilestone ancestry cycle at ${cursor}`)
    visited.add(cursor)
    const record = byHead.get(cursor)
    if (!record) break
    record.mergedSessionIds.forEach(sessionId => sessions.add(sessionId))
    cursor = record.baseSha
  }
  return sessions
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
  const integratedSessions = new Set(input.integrations.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
  const verifiedSessions = new Set<string>()
  for (const verification of input.verifications) {
    if (!verificationQualifies(verification, input.definition)) continue
    sessionsCoveredByFinalVerification(input.integrations, verification.integrationSha).forEach(sessionId => verifiedSessions.add(sessionId))
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
    return {
      requirementId: requirement.requirementId,
      title: requirement.title,
      mandatory: requirement.mandatory,
      ownerSessionId,
      deliveryStatus: delivery?.status ?? 'none',
      integrated: Boolean(ownerSessionId && integratedSessions.has(ownerSessionId)),
      verified: Boolean(ownerSessionId && verifiedSessions.has(ownerSessionId)),
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

import type {
  DevelopmentDelivery,
  DevelopmentRequirement,
  DevelopmentSessionDefinition,
  IntegrationMilestone,
  RequirementCoverage,
  RequirementWaiver,
  VerificationRun
} from '../contracts/index.ts'

export interface RequirementEvidenceMatrixInput {
  requirements: readonly DevelopmentRequirement[]
  sessions: readonly DevelopmentSessionDefinition[]
  deliveries: readonly DevelopmentDelivery[]
  validDeliveryHashes: ReadonlySet<string>
  integrations: readonly IntegrationMilestone[]
  verifications: readonly VerificationRun[]
  finalIntegrationSha: string
  verificationPolicyRevision?: string
  mandatoryTestIds?: readonly string[]
  waivers?: ReadonlyMap<string, RequirementWaiver>
}

function finalIntegrationRunIds(integrations: readonly IntegrationMilestone[], finalIntegrationSha: string): ReadonlySet<string> {
  const byHead = new Map<string, IntegrationMilestone>()
  for (const record of integrations) {
    if (record.status !== 'merged') continue
    const existing = byHead.get(record.headSha)
    if (existing && existing.integrationRunId !== record.integrationRunId) {
      throw new Error(`ambiguous merged IntegrationMilestone head ${record.headSha}`)
    }
    byHead.set(record.headSha, record)
  }

  const chain = new Set<string>()
  const visitedHeads = new Set<string>()
  let cursor = finalIntegrationSha
  while (true) {
    if (visitedHeads.has(cursor)) throw new Error(`IntegrationMilestone ancestry cycle at ${cursor}`)
    visitedHeads.add(cursor)
    const record = byHead.get(cursor)
    if (!record) break
    chain.add(record.integrationRunId)
    cursor = record.baseSha
  }
  return chain
}

function verificationQualifies(run: VerificationRun, input: RequirementEvidenceMatrixInput): boolean {
  if (run.status !== 'passed' || run.integrationSha !== input.finalIntegrationSha) return false
  if (input.verificationPolicyRevision && run.policyRevision !== input.verificationPolicyRevision) return false
  const mandatory = [...new Set(input.mandatoryTestIds ?? [])]
  if (mandatory.length === 0) return true
  const requiredCommands = new Set(run.commands.filter(command => command.required).map(command => command.id))
  const passedResults = new Set(run.results.filter(result => result.status === 'passed').map(result => result.commandId))
  return mandatory.every(id => requiredCommands.has(id) && passedResults.has(id))
}

export function buildRequirementEvidenceMatrix(input: RequirementEvidenceMatrixInput): RequirementCoverage[] {
  const sessionByRequirement = new Map<string, DevelopmentSessionDefinition>()
  for (const session of input.sessions) {
    for (const requirementId of session.requirements) {
      if (sessionByRequirement.has(requirementId)) throw new Error(`Requirement ${requirementId} is assigned to multiple Sessions`)
      sessionByRequirement.set(requirementId, session)
    }
  }
  const deliveryBySession = new Map(input.deliveries.map(delivery => [delivery.sessionId, delivery] as const))
  const finalChain = finalIntegrationRunIds(input.integrations, input.finalIntegrationSha)
  const verification = input.verifications.find(run => verificationQualifies(run, input))

  return input.requirements.map(requirement => {
    const waiver = input.waivers?.get(requirement.requirementId)
    if (waiver) return { requirementId: requirement.requirementId, state: 'waived', testEvidenceIds: [...waiver.evidence], waiver }
    const session = sessionByRequirement.get(requirement.requirementId)
    if (!session) return { requirementId: requirement.requirementId, state: 'planned', testEvidenceIds: [] }
    const delivery = deliveryBySession.get(session.sessionId)
    if (!delivery) return { requirementId: requirement.requirementId, state: 'assigned', sessionId: session.sessionId, testEvidenceIds: [] }

    const testEvidenceIds = delivery.testsExecuted.map((test, index) => `${delivery.deliveryHash}:test:${index}:${test}`)
    const base: RequirementCoverage = {
      requirementId: requirement.requirementId,
      state: delivery.status === 'completed' ? 'implemented' : 'blocked',
      sessionId: session.sessionId,
      deliveryHash: delivery.deliveryHash,
      commitSha: delivery.headSha,
      testEvidenceIds
    }
    if (delivery.status !== 'completed' || !input.validDeliveryHashes.has(delivery.deliveryHash)) return base
    if (testEvidenceIds.length > 0) base.state = 'tested'

    const integration = input.integrations.find(record =>
      finalChain.has(record.integrationRunId) &&
      record.mergedSessionIds.includes(session.sessionId) &&
      record.deliveryHashes.includes(delivery.deliveryHash)
    )
    if (!integration) return base
    base.state = 'integrated'
    base.integrationRunId = integration.integrationRunId

    if (!verification) return base
    base.state = 'verified'
    base.verificationRunId = verification.verificationRunId
    return base
  })
}

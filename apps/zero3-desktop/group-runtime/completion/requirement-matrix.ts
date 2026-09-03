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
  waivers?: ReadonlyMap<string, RequirementWaiver>
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
      record.status === 'merged' &&
      record.mergedSessionIds.includes(session.sessionId) &&
      record.deliveryHashes.includes(delivery.deliveryHash)
    )
    if (!integration) return base
    base.state = 'integrated'
    base.integrationRunId = integration.integrationRunId

    const verification = input.verifications.find(run => run.status === 'passed' && run.integrationSha === input.finalIntegrationSha)
    if (!verification || integration.headSha !== input.finalIntegrationSha) return base
    base.state = 'verified'
    base.verificationRunId = verification.verificationRunId
    return base
  })
}

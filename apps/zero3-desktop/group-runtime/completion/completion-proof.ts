import {
  ZERO3_GROUP_COMPLETION_PROOF,
  validateGroupCompletionProof,
  type DevelopmentDelivery,
  type DevelopmentGroupPolicy,
  type DevelopmentRequirement,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionRuntime,
  type GroupCompletionProof,
  type IntegrationMilestone,
  type RequirementWaiver,
  type ValidationIssue,
  type VerificationRun
} from '../contracts/index.ts'
import { buildRequirementEvidenceMatrix } from './requirement-matrix.ts'

export interface CompletionProofBuildResult {
  proof: GroupCompletionProof
  issues: readonly ValidationIssue[]
}

export function buildCompletionProof(input: {
  groupId: string
  policy: DevelopmentGroupPolicy
  requirements: readonly DevelopmentRequirement[]
  sessions: readonly DevelopmentSessionDefinition[]
  runtimes: readonly DevelopmentSessionRuntime[]
  deliveries: readonly DevelopmentDelivery[]
  validDeliveryHashes: ReadonlySet<string>
  integrations: readonly IntegrationMilestone[]
  verifications: readonly VerificationRun[]
  finalIntegrationSha: string
  unresolvedBlockers: readonly string[]
  waivers?: ReadonlyMap<string, RequirementWaiver>
  generatedAt?: string
}): CompletionProofBuildResult {
  const matrix = buildRequirementEvidenceMatrix({
    requirements: input.requirements,
    sessions: input.sessions,
    deliveries: input.deliveries,
    validDeliveryHashes: input.validDeliveryHashes,
    integrations: input.integrations,
    verifications: input.verifications,
    finalIntegrationSha: input.finalIntegrationSha,
    waivers: input.waivers
  })
  const latestIntegration = [...input.integrations].reverse().find(record => record.headSha === input.finalIntegrationSha)
  const passedVerifications = input.verifications.filter(run => run.integrationSha === input.finalIntegrationSha && run.status === 'passed')
  const outcomeUnknownCount = input.runtimes.filter(runtime => runtime.status === 'outcome_unknown').length
  const deliveryBySession = new Map(input.deliveries.map(delivery => [delivery.sessionId, delivery] as const))
  const sessionDeliveryCoverage = input.sessions.map(session => {
    const delivery = deliveryBySession.get(session.sessionId)
    return { sessionId: session.sessionId, deliveryHash: delivery?.deliveryHash ?? '', valid: Boolean(delivery && delivery.status === 'completed' && input.validDeliveryHashes.has(delivery.deliveryHash)) }
  })
  const proof: GroupCompletionProof = {
    contract: ZERO3_GROUP_COMPLETION_PROOF,
    groupId: input.groupId,
    requirementCoverage: matrix,
    sessionDeliveryCoverage,
    integrationStatus: latestIntegration?.status === 'merged' ? 'clean' : latestIntegration?.status === 'conflict' ? 'conflict' : 'failed',
    verificationStatus: passedVerifications.length > 0 ? 'passed' : input.verifications.some(run => run.integrationSha === input.finalIntegrationSha) ? 'failed' : 'not_run',
    unresolvedBlockers: [...input.unresolvedBlockers],
    outcomeUnknownCount,
    finalIntegrationSha: input.finalIntegrationSha,
    verificationEvidence: passedVerifications.map(run => run.verificationRunId),
    completionPolicyRevision: input.policy.verificationPolicyRevision,
    generatedAt: input.generatedAt ?? new Date().toISOString()
  }
  const issues: ValidationIssue[] = [...validateGroupCompletionProof(proof, input.requirements, input.deliveries, input.verifications)]
  for (const coverage of sessionDeliveryCoverage) {
    if (!coverage.valid) issues.push({ code: 'missing_session_delivery', path: `proof.sessionDeliveryCoverage.${coverage.sessionId}`, message: 'every planned Development Session requires one valid completed Delivery' })
  }
  if (input.policy.completionMode === 'strict' && matrix.some(record => record.state === 'waived')) {
    issues.push({ code: 'waiver_forbidden', path: 'proof.requirementCoverage', message: 'strict completion policy forbids Requirement waivers' })
  }
  return { proof, issues }
}

export function assertGroupCompletable(result: CompletionProofBuildResult): GroupCompletionProof {
  if (result.issues.length > 0) throw new Error(`Development Group is not complete: ${result.issues.map(issue => `${issue.code}@${issue.path}`).join(', ')}`)
  return result.proof
}

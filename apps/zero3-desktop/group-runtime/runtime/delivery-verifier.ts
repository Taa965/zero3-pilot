import type { DevelopmentDelivery, DevelopmentSessionDefinition } from '../contracts/index.ts'
import { GitWorkspaceAdapter, verifyDevelopmentDelivery, type DeliveryGateResult, type DeliveryHandoffEvidence } from '../workspace/index.ts'

export interface RuntimeDeliveryVerifierPort {
  verify(session: DevelopmentSessionDefinition, delivery: DevelopmentDelivery): Promise<DeliveryGateResult>
}

export interface RuntimeHandoffEvidenceResolver {
  resolve(session: DevelopmentSessionDefinition, delivery: DevelopmentDelivery): Promise<DeliveryHandoffEvidence | undefined>
}

export class WorkspaceRuntimeDeliveryVerifier implements RuntimeDeliveryVerifierPort {
  constructor(private readonly handoffResolver?: RuntimeHandoffEvidenceResolver) {}

  async verify(session: DevelopmentSessionDefinition, delivery: DevelopmentDelivery): Promise<DeliveryGateResult> {
    const handoff = this.handoffResolver ? await this.handoffResolver.resolve(session, delivery) : undefined
    return verifyDevelopmentDelivery({
      session,
      delivery,
      git: new GitWorkspaceAdapter(session.worktree),
      ...(handoff ? { handoff } : {})
    })
  }
}

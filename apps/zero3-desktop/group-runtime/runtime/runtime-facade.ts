import type {
  DevelopmentDelivery,
  DevelopmentGroupDefinition,
  DevelopmentGroupRuntimeState,
  DevelopmentSessionRuntime,
  IntegrationMilestone,
  GroupCompletionProof,
  VerificationCommand,
  VerificationRun
} from '../contracts/index.ts'
import { DevelopmentGroupController } from '../controller/index.ts'
import { IntegrationController, IntegrationQueue, type IntegrationGitPort } from '../integration/index.ts'
import type { ControllerPlanningProposal, PlanningProposal, PlanningRequest } from '../planning/index.ts'
import type { ExecutorManagerPort } from '../session/index.ts'
import type { DevelopmentGroupStore } from '../store/index.ts'
import { buildDevelopmentGroupViewModel, type DevelopmentGroupViewModel } from '../ui/groups-view-model.ts'
import { executeVerification, type VerificationCommandExecutor } from '../verification/index.ts'
import { assertGroupCompletable, buildCompletionProof, type CompletionProofBuildResult } from '../completion/index.ts'
import type { WaveGateEvidence } from '../scheduler/index.ts'
import type { RuntimeDeliveryVerifierPort } from './delivery-verifier.ts'
import { loadDurableGroupRecords, type DurableGroupRecords } from './record-reader.ts'
import {
  acceptDevelopmentDelivery,
  applyIntegrationMilestone,
  markSessionIntegrating,
  markSessionVerified,
  reconcileAcceptedDelivery
} from './session-lifecycle.ts'

export interface RuntimeVerificationCommandProvider {
  commands(definition: DevelopmentGroupDefinition): Promise<readonly VerificationCommand[]>
}

export interface DevelopmentGroupRuntimeFacadeOptions {
  store: DevelopmentGroupStore
  executorManager: ExecutorManagerPort
  integrationGit: IntegrationGitPort
  deliveryVerifier: RuntimeDeliveryVerifierPort
  verificationCommands: RuntimeVerificationCommandProvider
  verificationExecutor: VerificationCommandExecutor
  postMergeCheck?: (headSha: string) => Promise<{ ok: boolean; detail?: string }>
}

export interface DevelopmentGroupRuntimeSnapshot {
  plan: PlanningProposal
  state: DevelopmentGroupRuntimeState
  records: DurableGroupRecords
  view: DevelopmentGroupViewModel
}

function mergedSessionIds(records: DurableGroupRecords): Set<string> {
  return new Set(records.integrations.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
}

function finalIntegrationChain(records: DurableGroupRecords, finalSha: string): readonly IntegrationMilestone[] {
  const byHead = new Map(records.integrations.filter(record => record.status === 'merged').map(record => [record.headSha, record] as const))
  const chain: IntegrationMilestone[] = []
  const visited = new Set<string>()
  let cursor = finalSha
  while (true) {
    if (visited.has(cursor)) throw new Error(`Integration ancestry cycle at ${cursor}`)
    visited.add(cursor)
    const record = byHead.get(cursor)
    if (!record) break
    chain.push(record)
    cursor = record.baseSha
  }
  return chain
}

export class DevelopmentGroupRuntimeFacade {
  readonly controller: DevelopmentGroupController

  constructor(readonly options: DevelopmentGroupRuntimeFacadeOptions) {
    this.controller = new DevelopmentGroupController(options.store)
  }

  createGroup(request: PlanningRequest, proposal: ControllerPlanningProposal, options?: { groupId?: string; createdAt?: string }): Promise<PlanningProposal> {
    return this.controller.createGroup(request, proposal, options)
  }

  async snapshot(groupId: string): Promise<DevelopmentGroupRuntimeSnapshot> {
    const plan = await this.controller.loadPlan(groupId)
    await this.controller.resumeGroup(groupId)
    await Promise.all(plan.sessions.map(session => reconcileAcceptedDelivery(this.options.store, session)))
    const [state, records] = await Promise.all([
      this.options.store.loadState(groupId),
      loadDurableGroupRecords(this.options.store, plan)
    ])
    const view = buildDevelopmentGroupViewModel({
      definition: plan.definition,
      state,
      requirements: plan.requirements,
      sessions: plan.sessions,
      runtimes: records.runtimes,
      deliveries: records.deliveries,
      waves: plan.waves,
      integrations: records.integrations,
      verifications: records.verifications,
      failures: records.failures,
      repairs: records.repairs
    })
    return { plan, state, records, view }
  }

  async startWave(groupId: string, waveId: string, requestIdPrefix = `wave-${Date.now()}`): Promise<readonly DevelopmentSessionRuntime[]> {
    const snapshot = await this.snapshot(groupId)
    const wave = snapshot.plan.waves.find(candidate => candidate.waveId === waveId)
    if (!wave) throw new Error(`unknown Development Wave ${waveId}`)
    const waveEvidence = await this.buildWaveEvidence(snapshot)
    const runningSessionCount = snapshot.records.runtimes.filter(runtime => ['starting', 'running', 'waiting_input'].includes(runtime.status)).length
    const schedule = await this.controller.schedule(groupId, waveEvidence, runningSessionCount)
    const eligible = schedule.readySessionIds.filter(sessionId => snapshot.plan.sessions.find(session => session.sessionId === sessionId)?.waveId === waveId)
    if (eligible.length === 0) throw new Error(`Development Wave ${waveId} has no eligible Sessions`)

    await this.controller.record(groupId, 'wave.started', undefined, waveId)
    return Promise.all(eligible.map(async (sessionId, index) => {
      const runner = await this.controller.sessionRunner(groupId, sessionId, this.options.executorManager)
      if (runner.snapshot().status === 'waiting_dependencies') await runner.markReady()
      await this.controller.record(groupId, 'session.started', sessionId, waveId)
      await runner.start()
      return runner.sendInitialInstruction(`${requestIdPrefix}:${index + 1}:${sessionId}`)
    }))
  }

  async submitDelivery(delivery: DevelopmentDelivery): Promise<DevelopmentSessionRuntime> {
    const plan = await this.controller.loadPlan(delivery.groupId)
    const session = plan.sessions.find(candidate => candidate.sessionId === delivery.sessionId)
    if (!session) throw new Error(`unknown Development Session ${delivery.sessionId}`)
    const gate = await this.options.deliveryVerifier.verify(session, delivery)
    if (gate.decision !== 'DELIVERY_ACCEPT') {
      await this.controller.record(delivery.groupId, 'delivery.rejected', delivery.sessionId, session.waveId, gate.reasons.join('; '))
      throw new Error(`Delivery rejected: ${gate.reasons.join('; ')}`)
    }
    const runtime = await acceptDevelopmentDelivery({ store: this.options.store, session, delivery, gate })
    await this.controller.record(delivery.groupId, 'session.delivered', delivery.sessionId, session.waveId, `delivery_hash=${delivery.deliveryHash}`)
    return runtime
  }

  async integrateDelivery(groupId: string, sessionId: string): Promise<IntegrationMilestone> {
    const snapshot = await this.snapshot(groupId)
    const session = snapshot.plan.sessions.find(candidate => candidate.sessionId === sessionId)
    const delivery = snapshot.records.deliveries.find(candidate => candidate.sessionId === sessionId)
    if (!session || !delivery) throw new Error(`missing Session or Delivery for ${sessionId}`)
    const queue = new IntegrationQueue()
    queue.enqueue(session, delivery, snapshot.plan.waves)
    const initialIntegratedSessionIds = [...mergedSessionIds(snapshot.records)]
    if (queue.ready(new Set(initialIntegratedSessionIds)).length === 0) throw new Error(`Delivery ${delivery.deliveryHash} is not dependency-ready for integration`)

    const verifier = {
      verify: async () => this.options.deliveryVerifier.verify(session, delivery)
    }
    const integration = new IntegrationController(queue, this.options.integrationGit, verifier, this.options.store, {
      integrationRef: session.integrationRef,
      initialIntegratedSessionIds,
      ...(this.options.postMergeCheck ? { postMergeCheck: async headSha => this.options.postMergeCheck!(headSha) } : {})
    })

    await this.controller.record(groupId, 'integration.started', sessionId, session.waveId, `delivery_hash=${delivery.deliveryHash}`)
    await markSessionIntegrating(this.options.store, groupId, sessionId)
    const result = await integration.integrateNext()
    if (!result) throw new Error('integration queue became blocked after readiness check')
    await applyIntegrationMilestone(this.options.store, sessionId, result)
    if (result.status === 'merged') {
      const state = await this.controller.record(groupId, 'integration.merged', sessionId, session.waveId, `integration_sha=${result.headSha}`)
      await this.options.store.writeState({ ...state, integrationSha: result.headSha })
    } else {
      await this.controller.record(groupId, 'session.blocked', sessionId, session.waveId, result.conflicts.join('; ') || `integration_${result.status}`)
    }
    return result
  }

  async runVerification(groupId: string, verificationRunId?: string): Promise<VerificationRun> {
    const snapshot = await this.snapshot(groupId)
    const finalSha = snapshot.state.integrationSha ?? snapshot.records.integrations.filter(record => record.status === 'merged').at(-1)?.headSha
    if (!finalSha) throw new Error('verification requires a merged integration SHA')
    const commands = await this.options.verificationCommands.commands(snapshot.plan.definition)
    await this.controller.record(groupId, 'verification.started', undefined, undefined, `integration_sha=${finalSha}`)
    const run = await executeVerification({
      groupId,
      integrationSha: finalSha,
      policyRevision: snapshot.plan.definition.policy.verificationPolicyRevision,
      commands,
      mandatoryCommandIds: snapshot.plan.definition.policy.mandatoryTests,
      environment: {},
      platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      ...(verificationRunId ? { verificationRunId } : {})
    }, this.options.verificationExecutor)
    await this.options.store.writeVerification(run)
    if (run.status !== 'passed') {
      await this.controller.record(groupId, 'verification.failed', undefined, undefined, `verification_run=${run.verificationRunId};status=${run.status}`)
      return run
    }

    const after = await this.snapshot(groupId)
    const verifiedSessionIds = new Set(finalIntegrationChain(after.records, finalSha).flatMap(record => record.mergedSessionIds))
    for (const sessionId of verifiedSessionIds) await markSessionVerified(this.options.store, groupId, sessionId, run)
    return run
  }

  async completionProof(groupId: string): Promise<CompletionProofBuildResult> {
    const snapshot = await this.snapshot(groupId)
    const finalSha = snapshot.state.integrationSha ?? snapshot.records.integrations.filter(record => record.status === 'merged').at(-1)?.headSha
    if (!finalSha) throw new Error('Completion Proof requires a final integration SHA')
    const validDeliveryHashes = new Set<string>()
    for (const delivery of snapshot.records.deliveries) {
      const session = snapshot.plan.sessions.find(candidate => candidate.sessionId === delivery.sessionId)
      if (!session) continue
      const gate = await this.options.deliveryVerifier.verify(session, delivery)
      if (gate.decision === 'DELIVERY_ACCEPT') validDeliveryHashes.add(delivery.deliveryHash)
    }
    return buildCompletionProof({
      groupId,
      policy: snapshot.plan.definition.policy,
      requirements: snapshot.plan.requirements,
      sessions: snapshot.plan.sessions,
      runtimes: snapshot.records.runtimes,
      deliveries: snapshot.records.deliveries,
      validDeliveryHashes,
      integrations: snapshot.records.integrations,
      verifications: snapshot.records.verifications,
      finalIntegrationSha: finalSha,
      unresolvedBlockers: snapshot.state.unresolvedBlockers
    })
  }

  async completeGroup(groupId: string): Promise<GroupCompletionProof> {
    const proof = assertGroupCompletable(await this.completionProof(groupId))
    await this.controller.record(groupId, 'group.completed', undefined, undefined, `integration_sha=${proof.finalIntegrationSha}`)
    return proof
  }

  private async buildWaveEvidence(snapshot: DevelopmentGroupRuntimeSnapshot): Promise<ReadonlyMap<string, WaveGateEvidence>> {
    const integrated = mergedSessionIds(snapshot.records)
    const evidence = new Map<string, WaveGateEvidence>()
    for (const wave of snapshot.plan.waves) {
      let requiredDeliveriesValid = true
      let ownershipValid = true
      for (const sessionId of wave.requiredSessionIds) {
        const session = snapshot.plan.sessions.find(candidate => candidate.sessionId === sessionId)
        const delivery = snapshot.records.deliveries.find(candidate => candidate.sessionId === sessionId)
        if (!session || !delivery) {
          requiredDeliveriesValid = false
          ownershipValid = false
          continue
        }
        const gate = await this.options.deliveryVerifier.verify(session, delivery)
        if (gate.decision !== 'DELIVERY_ACCEPT') requiredDeliveriesValid = false
        if (gate.ownership?.valid === false) ownershipValid = false
      }
      evidence.set(wave.waveId, {
        waveId: wave.waveId,
        integrationValid: wave.requiredSessionIds.every(sessionId => integrated.has(sessionId)),
        requiredDeliveriesValid,
        ownershipValid
      })
    }
    return evidence
  }
}

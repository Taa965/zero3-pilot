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
import { resolveSessionWorktree } from '../workspace/index.ts'
import type { RuntimeDeliveryVerifierPort } from './delivery-verifier.ts'
import type { RuntimeDeliveryMaterializerPort } from './delivery-materializer.ts'
import { loadDurableGroupRecords, type DurableGroupRecords } from './record-reader.ts'
import {
  acceptDevelopmentDelivery,
  applyIntegrationMilestone,
  markSessionBlocked,
  markSessionIntegrating,
  markSessionVerified,
  reconcileAcceptedDelivery,
  reconcileInterruptedExecutorRuntime
} from './session-lifecycle.ts'
import { DevelopmentGroupWorkerSupervisor, type WorkerLaunchResult } from './worker-supervisor.ts'

export interface RuntimeVerificationCommandProvider {
  commands(definition: DevelopmentGroupDefinition): Promise<readonly VerificationCommand[]>
}

export interface DevelopmentGroupRuntimeFacadeOptions {
  store: DevelopmentGroupStore
  executorManager: ExecutorManagerPort
  integrationGit: IntegrationGitPort
  deliveryVerifier: RuntimeDeliveryVerifierPort
  deliveryMaterializer: RuntimeDeliveryMaterializerPort
  verificationCommands: RuntimeVerificationCommandProvider
  verificationExecutor: VerificationCommandExecutor
  supervisor?: DevelopmentGroupWorkerSupervisor
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

function integrationByHead(records: DurableGroupRecords): Map<string, IntegrationMilestone> {
  const byHead = new Map<string, IntegrationMilestone>()
  for (const record of records.integrations) {
    if (record.status !== 'merged') continue
    const existing = byHead.get(record.headSha)
    if (existing && existing.integrationRunId !== record.integrationRunId) {
      throw new Error(`ambiguous merged IntegrationMilestone head ${record.headSha}`)
    }
    byHead.set(record.headSha, record)
  }
  return byHead
}

function finalIntegrationChain(records: DurableGroupRecords, finalSha: string): readonly IntegrationMilestone[] {
  const byHead = integrationByHead(records)
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

function currentBlockers(records: DurableGroupRecords): string[] {
  const values = new Set<string>()
  for (const runtime of records.runtimes) {
    if (!['blocked', 'waiting_input', 'outcome_unknown', 'failed'].includes(runtime.status)) continue
    values.add(runtime.blocker?.trim() || `${runtime.sessionId}:${runtime.status}`)
  }
  for (const failure of records.failures) if (failure.unresolved) values.add(failure.message)
  for (const repair of records.repairs) if (repair.status === 'waiting_human' || repair.status === 'failed') values.add(`${repair.repairTaskId}:${repair.status}`)
  return [...values].filter(Boolean).sort()
}

function normalizeRuntimeState(state: DevelopmentGroupRuntimeState, records: DurableGroupRecords): DevelopmentGroupRuntimeState {
  const outcomeUnknownCount = records.runtimes.filter(runtime => runtime.status === 'outcome_unknown').length
  const unresolvedBlockers = currentBlockers(records)
  const terminal = ['completed', 'cancelled', 'failed'].includes(state.status)
  let status = state.status
  if (outcomeUnknownCount > 0 && !terminal) status = 'outcome_unknown'
  else if (outcomeUnknownCount === 0 && state.status === 'outcome_unknown') status = unresolvedBlockers.length > 0 ? 'blocked' : 'ready'
  return {
    ...state,
    status,
    unresolvedBlockers,
    outcomeUnknownCount
  }
}

export class DevelopmentGroupRuntimeFacade {
  readonly controller: DevelopmentGroupController
  readonly supervisor: DevelopmentGroupWorkerSupervisor

  constructor(readonly options: DevelopmentGroupRuntimeFacadeOptions) {
    this.controller = new DevelopmentGroupController(options.store)
    this.supervisor = options.supervisor ?? new DevelopmentGroupWorkerSupervisor()
  }

  createGroup(request: PlanningRequest, proposal: ControllerPlanningProposal, options?: { groupId?: string; createdAt?: string }): Promise<PlanningProposal> {
    return this.controller.createGroup(request, proposal, options)
  }

  async snapshot(groupId: string): Promise<DevelopmentGroupRuntimeSnapshot> {
    const plan = await this.controller.loadPlan(groupId)
    await this.controller.resumeGroup(groupId)
    await Promise.all(plan.sessions.map(async session => {
      await reconcileInterruptedExecutorRuntime(this.options.store, groupId, session.sessionId, this.supervisor.isActive(session.sessionId))
      await reconcileAcceptedDelivery(this.options.store, session)
    }))
    const [rawState, records] = await Promise.all([
      this.options.store.loadState(groupId),
      loadDurableGroupRecords(this.options.store, plan)
    ])
    const state = normalizeRuntimeState(rawState, records)
    if (JSON.stringify(state) !== JSON.stringify(rawState)) await this.options.store.writeState(state)
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

  async startWave(groupId: string, waveId: string, requestIdPrefix = `wave-${Date.now()}`): Promise<readonly WorkerLaunchResult[]> {
    const snapshot = await this.snapshot(groupId)
    if (snapshot.state.outcomeUnknownCount > 0) throw new Error('Development Group has unresolved OutcomeUnknown and cannot start more Sessions')
    const wave = snapshot.plan.waves.find(candidate => candidate.waveId === waveId)
    if (!wave) throw new Error(`unknown Development Wave ${waveId}`)
    const waveEvidence = await this.buildWaveEvidence(snapshot)
    const runningSessionCount = snapshot.records.runtimes.filter(runtime => ['starting', 'running', 'waiting_input'].includes(runtime.status)).length
    const schedule = await this.controller.schedule(groupId, waveEvidence, runningSessionCount)
    const eligible = schedule.readySessionIds.filter(sessionId => snapshot.plan.sessions.find(session => session.sessionId === sessionId)?.waveId === waveId)
    if (eligible.length === 0) throw new Error(`Development Wave ${waveId} has no eligible Sessions`)

    await this.controller.record(groupId, 'wave.started', undefined, waveId)
    const launches: WorkerLaunchResult[] = []
    for (const [index, sessionId] of eligible.entries()) {
      const persistedSession = snapshot.plan.sessions.find(candidate => candidate.sessionId === sessionId)!
      const session = resolveSessionWorktree(snapshot.plan.definition, persistedSession)
      const runner = await this.controller.sessionRunner(groupId, sessionId, this.options.executorManager)
      if (runner.snapshot().status === 'waiting_dependencies') await runner.markReady()
      await this.controller.record(groupId, 'session.started', sessionId, waveId)
      await runner.start()
      launches.push(this.supervisor.launch({
        runner,
        clientRequestId: `${requestIdPrefix}:${index + 1}:${sessionId}`,
        afterSettled: async runtime => {
          if (runtime.status !== 'delivering') return
          try {
            const delivery = await this.options.deliveryMaterializer.materialize(snapshot.plan.definition, session, runtime)
            await this.submitDelivery(delivery)
          } catch (error) {
            const blocker = `delivery_materialization_failed: ${String(error)}`
            await markSessionBlocked(this.options.store, groupId, sessionId, blocker)
            await this.controller.record(groupId, 'session.blocked', sessionId, waveId, blocker)
          }
        }
      }))
    }
    return launches
  }

  async submitDelivery(delivery: DevelopmentDelivery): Promise<DevelopmentSessionRuntime> {
    const plan = await this.controller.loadPlan(delivery.groupId)
    const persistedSession = plan.sessions.find(candidate => candidate.sessionId === delivery.sessionId)
    if (!persistedSession) throw new Error(`unknown Development Session ${delivery.sessionId}`)
    const session = resolveSessionWorktree(plan.definition, persistedSession)
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
    if (snapshot.state.outcomeUnknownCount > 0) throw new Error('Development Group has unresolved OutcomeUnknown and cannot integrate')
    const persistedSession = snapshot.plan.sessions.find(candidate => candidate.sessionId === sessionId)
    const delivery = snapshot.records.deliveries.find(candidate => candidate.sessionId === sessionId)
    if (!persistedSession || !delivery) throw new Error(`missing Session or Delivery for ${sessionId}`)
    const session = resolveSessionWorktree(snapshot.plan.definition, persistedSession)
    const queue = new IntegrationQueue()
    queue.enqueue(session, delivery, snapshot.plan.waves)
    const initialIntegratedSessionIds = [...mergedSessionIds(snapshot.records)]
    if (queue.ready(new Set(initialIntegratedSessionIds)).length === 0) throw new Error(`Delivery ${delivery.deliveryHash} is not dependency-ready for integration`)

    const verifier = { verify: async () => this.options.deliveryVerifier.verify(session, delivery) }
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
    if (snapshot.state.outcomeUnknownCount > 0) throw new Error('Development Group has unresolved OutcomeUnknown and cannot verify')
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
      const persistedSession = snapshot.plan.sessions.find(candidate => candidate.sessionId === delivery.sessionId)
      if (!persistedSession) continue
      const session = resolveSessionWorktree(snapshot.plan.definition, persistedSession)
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
        const persistedSession = snapshot.plan.sessions.find(candidate => candidate.sessionId === sessionId)
        const delivery = snapshot.records.deliveries.find(candidate => candidate.sessionId === sessionId)
        if (!persistedSession || !delivery) {
          requiredDeliveriesValid = false
          ownershipValid = false
          continue
        }
        const session = resolveSessionWorktree(snapshot.plan.definition, persistedSession)
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

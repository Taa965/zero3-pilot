import type { DevelopmentSessionRuntime } from '../contracts/index.ts'
import { resolveSessionWorktree } from '../workspace/index.ts'
import { markSessionBlocked } from './session-lifecycle.ts'
import type { DevelopmentGroupRuntimeFacade } from './runtime-facade.ts'
import type { WorkerLaunchResult } from './worker-supervisor.ts'

function mergedSessions(integrations: readonly { status: string; mergedSessionIds: readonly string[] }[]): Set<string> {
  return new Set(integrations.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
}

export async function retryDevelopmentSession(
  facade: DevelopmentGroupRuntimeFacade,
  groupId: string,
  sessionId: string,
  clientRequestId = `retry-${Date.now()}-${sessionId}`
): Promise<WorkerLaunchResult> {
  const snapshot = await facade.snapshot(groupId)
  if (snapshot.state.outcomeUnknownCount > 0) throw new Error('Development Group has unresolved OutcomeUnknown and cannot retry Sessions')
  if (facade.supervisor.isActive(sessionId)) throw new Error(`Development Session ${sessionId} still has an active supervised prompt`)
  const persistedSession = snapshot.plan.sessions.find(candidate => candidate.sessionId === sessionId)
  const runtime = snapshot.records.runtimes.find(candidate => candidate.sessionId === sessionId)
  if (!persistedSession || !runtime) throw new Error(`unknown Development Session ${sessionId}`)
  const session = resolveSessionWorktree(snapshot.plan.definition, persistedSession)
  if (runtime.status === 'outcome_unknown') throw new Error('OutcomeUnknown cannot enter retry; resolve the uncertain execution first')
  if (!['failed', 'blocked'].includes(runtime.status)) throw new Error(`only failed/blocked Sessions may retry; got ${runtime.status}`)
  if (runtime.attempt >= snapshot.plan.definition.policy.maxSessionAttempts) throw new Error('session attempt budget exhausted')

  const integrated = mergedSessions(snapshot.records.integrations)
  for (const dependencyId of session.dependencies) {
    if (!integrated.has(dependencyId)) throw new Error(`retry dependency ${dependencyId} is not durably integrated`)
  }

  const wave = snapshot.plan.waves.find(candidate => candidate.waveId === session.waveId)
  if (!wave) throw new Error(`missing Development Wave ${session.waveId}`)
  for (const dependencyWaveId of wave.dependsOnWaveIds) {
    const dependencyWave = snapshot.plan.waves.find(candidate => candidate.waveId === dependencyWaveId)
    if (!dependencyWave) throw new Error(`missing dependency Wave ${dependencyWaveId}`)
    for (const requiredSessionId of dependencyWave.requiredSessionIds) {
      if (!integrated.has(requiredSessionId)) throw new Error(`dependency Wave ${dependencyWaveId} is not fully integrated`)
      const persistedRequiredSession = snapshot.plan.sessions.find(candidate => candidate.sessionId === requiredSessionId)
      const delivery = snapshot.records.deliveries.find(candidate => candidate.sessionId === requiredSessionId)
      if (!persistedRequiredSession || !delivery) throw new Error(`dependency Wave ${dependencyWaveId} is missing durable Delivery evidence`)
      const requiredSession = resolveSessionWorktree(snapshot.plan.definition, persistedRequiredSession)
      const gate = await facade.options.deliveryVerifier.verify(requiredSession, delivery)
      if (gate.decision !== 'DELIVERY_ACCEPT') throw new Error(`dependency Wave ${dependencyWaveId} no longer passes Delivery evidence: ${gate.reasons.join('; ')}`)
    }
  }

  const runner = await facade.controller.sessionRunner(groupId, sessionId, facade.options.executorManager)
  await runner.prepareRetry()
  await facade.controller.record(groupId, 'session.started', sessionId, session.waveId, `explicit_retry_attempt=${runtime.attempt + 1}`)
  await runner.start()
  return facade.supervisor.launch({
    runner,
    clientRequestId,
    afterSettled: async (settled: DevelopmentSessionRuntime) => {
      if (settled.status !== 'delivering') return
      try {
        const delivery = await facade.options.deliveryMaterializer.materialize(snapshot.plan.definition, session, settled)
        await facade.submitDelivery(delivery)
      } catch (error) {
        const blocker = `delivery_materialization_failed: ${String(error)}`
        await markSessionBlocked(facade.options.store, groupId, sessionId, blocker)
        await facade.controller.record(groupId, 'session.blocked', sessionId, session.waveId, blocker)
      }
    }
  })
}

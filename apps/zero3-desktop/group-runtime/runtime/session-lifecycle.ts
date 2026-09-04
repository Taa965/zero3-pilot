import {
  validateDevelopmentDelivery,
  validateSessionStateTransition,
  type DevelopmentDelivery,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionRuntime,
  type DevelopmentSessionStatus,
  type IntegrationMilestone,
  type VerificationRun
} from '../contracts/index.ts'
import type { DeliveryGateResult } from '../workspace/index.ts'
import { DevelopmentGroupStore } from '../store/index.ts'

function transition(runtime: DevelopmentSessionRuntime, status: DevelopmentSessionStatus, patch: Partial<DevelopmentSessionRuntime> = {}): DevelopmentSessionRuntime {
  const issues = validateSessionStateTransition(runtime.status, status)
  if (issues.length > 0) throw new Error(issues[0].message)
  return { ...runtime, ...patch, status, updatedAt: new Date().toISOString() }
}

async function existingDelivery(store: DevelopmentGroupStore, groupId: string, sessionId: string): Promise<DevelopmentDelivery | undefined> {
  try {
    return await store.loadDelivery(groupId, sessionId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function reconcileInterruptedExecutorRuntime(store: DevelopmentGroupStore, groupId: string, sessionId: string, processOwnsPrompt: boolean): Promise<DevelopmentSessionRuntime> {
  const runtime = await store.loadSession(groupId, sessionId)
  if (processOwnsPrompt || !['starting', 'running', 'waiting_input'].includes(runtime.status)) return runtime
  const next = transition(runtime, 'outcome_unknown', {
    blocker: 'runtime_restart_without_authoritative_executor_outcome'
  })
  await store.writeSession(next)
  return next
}

export type OutcomeUnknownResolution = 'failed' | 'cancelled' | 'superseded'

export async function resolveSessionOutcomeUnknown(
  store: DevelopmentGroupStore,
  groupId: string,
  sessionId: string,
  resolution: OutcomeUnknownResolution,
  evidence: string
): Promise<DevelopmentSessionRuntime> {
  const detail = evidence.trim()
  if (!detail) throw new Error('OutcomeUnknown recovery requires explicit evidence/reason')
  const runtime = await store.loadSession(groupId, sessionId)
  if (runtime.status !== 'outcome_unknown') throw new Error(`Session ${sessionId} is not OutcomeUnknown; got ${runtime.status}`)
  const next = transition(runtime, resolution, {
    blocker: `outcome_unknown_resolved:${resolution}:${detail}`
  })
  await store.writeSession(next)
  return next
}

export async function markSessionBlocked(store: DevelopmentGroupStore, groupId: string, sessionId: string, blocker: string): Promise<DevelopmentSessionRuntime> {
  const runtime = await store.loadSession(groupId, sessionId)
  if (runtime.status === 'blocked' && runtime.blocker === blocker) return runtime
  const next = transition(runtime, 'blocked', { blocker })
  await store.writeSession(next)
  return next
}

export async function acceptDevelopmentDelivery(input: {
  store: DevelopmentGroupStore
  session: DevelopmentSessionDefinition
  delivery: DevelopmentDelivery
  gate: DeliveryGateResult
}): Promise<DevelopmentSessionRuntime> {
  const { store, session, delivery, gate } = input
  if (gate.decision !== 'DELIVERY_ACCEPT') throw new Error(`Delivery rejected: ${gate.reasons.join('; ')}`)
  const issues = validateDevelopmentDelivery(delivery, session)
  if (issues.length > 0) throw new Error(`Delivery contract invalid: ${issues.map(issue => issue.message).join('; ')}`)

  const prior = await existingDelivery(store, delivery.groupId, delivery.sessionId)
  if (prior && prior.deliveryHash !== delivery.deliveryHash) throw new Error('a different Delivery is already durable for this Session')

  let runtime = await store.loadSession(delivery.groupId, delivery.sessionId)
  if (prior?.deliveryHash === delivery.deliveryHash && ['delivered', 'integrating', 'integrated', 'verified'].includes(runtime.status)) return runtime
  if (runtime.status !== 'delivering') throw new Error(`Session must be delivering before Delivery acceptance; got ${runtime.status}`)

  const nextStatus: DevelopmentSessionStatus = delivery.status === 'completed'
    ? 'delivered'
    : delivery.status === 'blocked'
      ? 'blocked'
      : delivery.status === 'failed'
        ? 'failed'
        : delivery.status === 'cancelled'
          ? 'cancelled'
          : 'outcome_unknown'

  await store.writeDelivery(delivery)
  runtime = transition(runtime, nextStatus, {
    headSha: delivery.headSha,
    blocker: nextStatus === 'delivered' ? undefined : `delivery_${delivery.status}`
  })
  await store.writeSession(runtime)
  return runtime
}

export async function reconcileAcceptedDelivery(store: DevelopmentGroupStore, session: DevelopmentSessionDefinition): Promise<DevelopmentSessionRuntime> {
  const runtime = await store.loadSession(session.groupId, session.sessionId)
  if (runtime.status !== 'delivering') return runtime
  const delivery = await existingDelivery(store, session.groupId, session.sessionId)
  if (!delivery) return runtime
  const issues = validateDevelopmentDelivery(delivery, session)
  if (issues.length > 0 || delivery.status !== 'completed') return runtime
  const next = transition(runtime, 'delivered', { headSha: delivery.headSha, blocker: undefined })
  await store.writeSession(next)
  return next
}

export async function markSessionIntegrating(store: DevelopmentGroupStore, groupId: string, sessionId: string): Promise<DevelopmentSessionRuntime> {
  const runtime = await store.loadSession(groupId, sessionId)
  if (runtime.status === 'integrating') return runtime
  const next = transition(runtime, 'integrating')
  await store.writeSession(next)
  return next
}

export async function applyIntegrationMilestone(store: DevelopmentGroupStore, sessionId: string, milestone: IntegrationMilestone): Promise<DevelopmentSessionRuntime> {
  let runtime = await store.loadSession(milestone.groupId, sessionId)
  if (milestone.status === 'merged') {
    if (runtime.status === 'integrated' && runtime.headSha === milestone.headSha) return runtime
    runtime = transition(runtime, 'integrated', { headSha: milestone.headSha, blocker: undefined })
  } else {
    runtime = transition(runtime, 'blocked', { blocker: milestone.conflicts.join('; ') || `integration_${milestone.status}` })
  }
  await store.writeSession(runtime)
  return runtime
}

export async function markSessionVerified(store: DevelopmentGroupStore, groupId: string, sessionId: string, run: VerificationRun): Promise<DevelopmentSessionRuntime> {
  const runtime = await store.loadSession(groupId, sessionId)
  if (runtime.status === 'verified') return runtime
  if (runtime.status !== 'integrated') throw new Error(`Session must be integrated before verification; got ${runtime.status}`)
  if (run.status !== 'passed') throw new Error('Session cannot be marked verified from a non-passed Verification Run')
  // A final integration verification covers every Delivery in the cumulative
  // integration ancestry. Earlier Sessions therefore legitimately have an
  // intermediate integration head before they are promoted to the verified
  // final Group head.
  const next = transition(runtime, 'verified', { headSha: run.integrationSha, blocker: undefined })
  await store.writeSession(next)
  return next
}

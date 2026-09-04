import { join } from 'node:path'

import type { GroupEvent, DevelopmentGroupRuntimeState } from '../contracts/index.ts'
import { compilePlanningProposal, type ControllerPlanningProposal, type PlanningProposal, type PlanningRequest } from '../planning/index.ts'
import { DevelopmentSessionScheduler, type WaveGateEvidence } from '../scheduler/index.ts'
import { DevelopmentSessionRunner, initialSessionRuntime, type ExecutorManagerPort } from '../session/index.ts'
import { DevelopmentGroupStore, nextEventSequence, readDurableJson, writeDurableJson } from '../store/index.ts'
import { resolveSessionWorktree } from '../workspace/index.ts'

export const ZERO3_GROUP_PLAN_RECORD = 'zero3.pilot.group-plan-record.v1' as const

export interface PersistedGroupPlan {
  schema: typeof ZERO3_GROUP_PLAN_RECORD
  proposal: PlanningProposal
}

function initialState(groupId: string, at: string): DevelopmentGroupRuntimeState {
  return { groupId, status: 'planning', lastEventSequence: 0, unresolvedBlockers: [], outcomeUnknownCount: 0, repairWaveCount: 0, updatedAt: at }
}

export function reduceGroupEvents(state: DevelopmentGroupRuntimeState, events: readonly GroupEvent[]): DevelopmentGroupRuntimeState {
  const next: DevelopmentGroupRuntimeState = { ...state, unresolvedBlockers: [...state.unresolvedBlockers] }
  for (const event of events) {
    if (event.sequence <= next.lastEventSequence) continue
    if (event.sequence !== next.lastEventSequence + 1) throw new Error(`group event sequence gap: expected ${next.lastEventSequence + 1}, got ${event.sequence}`)
    if (event.groupId !== next.groupId) throw new Error('cross-group event during state reduction')
    switch (event.type) {
      case 'group.created': next.status = 'planning'; break
      case 'plan.frozen': next.status = 'ready'; break
      case 'wave.started': next.status = 'running'; next.activeWaveId = event.waveId; break
      case 'session.blocked': next.status = 'blocked'; if (event.detail && !next.unresolvedBlockers.includes(event.detail)) next.unresolvedBlockers = [...next.unresolvedBlockers, event.detail]; break
      case 'session.delivered': next.status = 'running'; break
      case 'integration.started': next.status = 'integrating'; break
      case 'integration.merged': next.status = 'verifying'; break
      case 'verification.started': next.status = 'verifying'; break
      case 'verification.failed': next.status = 'repairing'; break
      case 'repair.created': next.status = 'repairing'; next.repairWaveCount += 1; break
      case 'group.completed': next.status = 'completed'; break
      case 'session.created':
      case 'session.started':
      case 'delivery.rejected':
        break
    }
    next.lastEventSequence = event.sequence
    next.updatedAt = event.at
  }
  return next
}

export class DevelopmentGroupController {
  #recordQueue: Promise<void> = Promise.resolve()

  constructor(readonly store: DevelopmentGroupStore) {}

  async createGroup(request: PlanningRequest, proposal: ControllerPlanningProposal, options?: { groupId?: string; createdAt?: string }): Promise<PlanningProposal> {
    const plan = compilePlanningProposal(request, proposal, options)
    const state = initialState(plan.definition.groupId, plan.definition.createdAt)
    await this.store.initialize(plan.definition, state, plan.requirements)
    await writeDurableJson(join(this.store.groupDir(plan.definition.groupId), 'plan.json'), { schema: ZERO3_GROUP_PLAN_RECORD, proposal: plan } satisfies PersistedGroupPlan)
    for (const session of plan.sessions) await this.store.writeSession(initialSessionRuntime(session, plan.definition.createdAt))
    await this.record(plan.definition.groupId, 'group.created')
    await this.record(plan.definition.groupId, 'plan.frozen', undefined, undefined, `plan_hash=${plan.definition.planHash}`)
    return plan
  }

  async loadPlan(groupId: string): Promise<PlanningProposal> {
    const record = await readDurableJson<PersistedGroupPlan>(join(this.store.groupDir(groupId), 'plan.json'))
    if (record.schema !== ZERO3_GROUP_PLAN_RECORD || record.proposal.definition.groupId !== groupId) throw new Error('invalid persisted Development Group plan')
    return record.proposal
  }

  async resumeGroup(groupId: string): Promise<DevelopmentGroupRuntimeState> {
    const reconcile = await this.store.reconcile(groupId)
    let state = await this.store.loadState(groupId)
    if (reconcile.needsSemanticReplay) {
      state = reduceGroupEvents(state, await this.store.readEvents(groupId))
      await this.store.writeState(state)
    }
    return state
  }

  async record(groupId: string, type: GroupEvent['type'], sessionId?: string, waveId?: string, detail?: string): Promise<DevelopmentGroupRuntimeState> {
    const path = join(this.store.groupDir(groupId), 'events.jsonl')
    let result: DevelopmentGroupRuntimeState | undefined
    const job = this.#recordQueue.then(async () => {
      const sequence = await nextEventSequence(path)
      const event: GroupEvent = { eventId: `${groupId}:${sequence}:${type}`, sequence, at: new Date().toISOString(), groupId, type, sessionId, waveId, detail }
      await this.store.appendEvent(event)
      const state = reduceGroupEvents(await this.store.loadState(groupId), [event])
      await this.store.writeState(state)
      result = state
    })
    this.#recordQueue = job.then(() => undefined, () => undefined)
    await job
    if (!result) throw new Error('group event recording completed without durable state')
    return result
  }

  async schedule(groupId: string, waveEvidence: ReadonlyMap<string, WaveGateEvidence>, runningSessionCount: number) {
    const plan = await this.loadPlan(groupId)
    const runtimes = await Promise.all(plan.sessions.map(session => this.store.loadSession(groupId, session.sessionId)))
    const scheduler = new DevelopmentSessionScheduler(plan.definition.policy, plan.sessions, plan.waves)
    return scheduler.snapshot({ runtimes, waveEvidence, runningSessionCount })
  }

  async sessionRunner(groupId: string, sessionId: string, executorManager: ExecutorManagerPort): Promise<DevelopmentSessionRunner> {
    const plan = await this.loadPlan(groupId)
    const persistedSession = plan.sessions.find(candidate => candidate.sessionId === sessionId)
    if (!persistedSession) throw new Error(`unknown Development Session ${sessionId}`)
    const session = resolveSessionWorktree(plan.definition, persistedSession)
    const runtime = await this.store.loadSession(groupId, sessionId)
    return new DevelopmentSessionRunner(
      plan.definition,
      session,
      plan.requirements,
      executorManager,
      { save: next => this.store.writeSession(next) },
      undefined,
      runtime
    )
  }
}

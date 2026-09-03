import type {
  DevelopmentGroupDefinition,
  DevelopmentGroupRuntimeState,
  DevelopmentSessionDefinition,
  DevelopmentSessionRuntime,
  GroupEvent
} from '../contracts/index.ts'

export type ControllerSignalKind =
  | 'outcome_unknown'
  | 'blocked_session'
  | 'attempt_budget_exhausted'
  | 'stalled_session'
  | 'scope_drift'
  | 'waiting_human'
  | 'ledger_replay_required'

export interface ControllerSignal {
  kind: ControllerSignalKind
  severity: 'info' | 'warning' | 'blocking'
  sessionId?: string
  detail: string
  evidence: readonly string[]
}

export interface SessionObservation {
  runtime: DevelopmentSessionRuntime
  changedPaths?: readonly string[]
  ownershipValid?: boolean
  lastProgressAt?: string
}

function elapsedMs(nowMs: number, at: string | undefined): number | undefined {
  if (!at) return undefined
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined
}

export function observeDevelopmentGroup(input: {
  definition: DevelopmentGroupDefinition
  state: DevelopmentGroupRuntimeState
  sessions: readonly DevelopmentSessionDefinition[]
  observations: readonly SessionObservation[]
  events: readonly GroupEvent[]
  nowMs?: number
  stalledAfterMs?: number
}): ControllerSignal[] {
  const signals: ControllerSignal[] = []
  const nowMs = input.nowMs ?? Date.now()
  const stalledAfterMs = input.stalledAfterMs ?? 30 * 60 * 1000
  const sessionById = new Map(input.sessions.map(session => [session.sessionId, session] as const))

  if (input.events.length > input.state.lastEventSequence) {
    signals.push({ kind: 'ledger_replay_required', severity: 'blocking', detail: `ledger has ${input.events.length} events while state is reduced through ${input.state.lastEventSequence}`, evidence: [`event_count=${input.events.length}`, `state_sequence=${input.state.lastEventSequence}`] })
  }

  for (const observation of input.observations) {
    const runtime = observation.runtime
    const session = sessionById.get(runtime.sessionId)
    if (!session) {
      signals.push({ kind: 'scope_drift', severity: 'blocking', sessionId: runtime.sessionId, detail: 'runtime references a Session outside the frozen plan', evidence: [runtime.executionId] })
      continue
    }
    if (runtime.status === 'outcome_unknown') {
      signals.push({ kind: 'outcome_unknown', severity: 'blocking', sessionId: runtime.sessionId, detail: runtime.blocker ?? 'execution outcome is unknown', evidence: [`attempt=${runtime.attempt}`] })
    }
    if (runtime.status === 'blocked') {
      signals.push({ kind: 'blocked_session', severity: 'warning', sessionId: runtime.sessionId, detail: runtime.blocker ?? 'session is blocked', evidence: session.dependencies })
    }
    if (runtime.status === 'waiting_human') {
      signals.push({ kind: 'waiting_human', severity: 'blocking', sessionId: runtime.sessionId, detail: runtime.blocker ?? 'human action is required', evidence: [] })
    }
    if (runtime.status === 'failed' && runtime.attempt >= input.definition.policy.maxSessionAttempts) {
      signals.push({ kind: 'attempt_budget_exhausted', severity: 'blocking', sessionId: runtime.sessionId, detail: `attempt budget ${input.definition.policy.maxSessionAttempts} exhausted`, evidence: [`attempt=${runtime.attempt}`] })
    }
    const stalled = elapsedMs(nowMs, observation.lastProgressAt ?? runtime.updatedAt)
    if (runtime.status === 'running' && stalled !== undefined && stalled >= stalledAfterMs) {
      signals.push({ kind: 'stalled_session', severity: 'warning', sessionId: runtime.sessionId, detail: `no durable progress for ${stalled}ms`, evidence: [`threshold_ms=${stalledAfterMs}`] })
    }
    if (observation.ownershipValid === false) {
      signals.push({ kind: 'scope_drift', severity: 'blocking', sessionId: runtime.sessionId, detail: 'changed paths failed ownership validation', evidence: observation.changedPaths ?? [] })
    }
  }
  return signals.sort((left, right) => (left.sessionId ?? '').localeCompare(right.sessionId ?? '') || left.kind.localeCompare(right.kind))
}

export interface ReplanProposal {
  action: 'no_change' | 'retry_sessions' | 'repair_scope' | 'wait_human'
  sessionIds: readonly string[]
  reasons: readonly string[]
}

export function proposeControllerAction(signals: readonly ControllerSignal[]): ReplanProposal {
  const blockers = signals.filter(signal => signal.severity === 'blocking')
  if (blockers.some(signal => ['outcome_unknown', 'waiting_human', 'ledger_replay_required'].includes(signal.kind))) {
    return { action: 'wait_human', sessionIds: [...new Set(blockers.map(signal => signal.sessionId).filter((id): id is string => Boolean(id)))].sort(), reasons: blockers.map(signal => signal.detail) }
  }
  const scope = blockers.filter(signal => signal.kind === 'scope_drift')
  if (scope.length > 0) return { action: 'repair_scope', sessionIds: [...new Set(scope.map(signal => signal.sessionId).filter((id): id is string => Boolean(id)))].sort(), reasons: scope.map(signal => signal.detail) }
  const retry = signals.filter(signal => signal.kind === 'blocked_session' || signal.kind === 'stalled_session')
  if (retry.length > 0) return { action: 'retry_sessions', sessionIds: [...new Set(retry.map(signal => signal.sessionId).filter((id): id is string => Boolean(id)))].sort(), reasons: retry.map(signal => signal.detail) }
  return { action: 'no_change', sessionIds: [], reasons: [] }
}

import type { DevelopmentGroupStatus, DevelopmentSessionStatus } from './contract-types.ts'

const GROUP_TRANSITIONS: Readonly<Record<DevelopmentGroupStatus, readonly DevelopmentGroupStatus[]>> = {
  draft: ['planning', 'cancelled'],
  planning: ['plan_review', 'blocked', 'cancelled', 'failed'],
  plan_review: ['planning', 'ready', 'waiting_approval', 'cancelled'],
  ready: ['running', 'paused', 'cancelled'],
  running: ['integrating', 'paused', 'blocked', 'waiting_approval', 'waiting_human', 'outcome_unknown', 'cancelled', 'failed'],
  integrating: ['running', 'verifying', 'repairing', 'paused', 'blocked', 'waiting_human', 'outcome_unknown', 'cancelled', 'failed'],
  verifying: ['completed', 'repairing', 'paused', 'blocked', 'waiting_human', 'outcome_unknown', 'cancelled', 'failed'],
  repairing: ['integrating', 'verifying', 'paused', 'blocked', 'waiting_human', 'outcome_unknown', 'cancelled', 'failed'],
  paused: ['planning', 'ready', 'running', 'integrating', 'verifying', 'repairing', 'cancelled'],
  blocked: ['planning', 'ready', 'running', 'integrating', 'verifying', 'repairing', 'waiting_human', 'cancelled', 'failed'],
  waiting_approval: ['plan_review', 'running', 'integrating', 'verifying', 'repairing', 'waiting_human', 'cancelled'],
  waiting_human: ['planning', 'ready', 'running', 'integrating', 'verifying', 'repairing', 'cancelled', 'failed'],
  outcome_unknown: ['waiting_human', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: []
}

const SESSION_TRANSITIONS: Readonly<Record<DevelopmentSessionStatus, readonly DevelopmentSessionStatus[]>> = {
  planned: ['waiting_dependencies', 'ready', 'cancelled', 'superseded'],
  waiting_dependencies: ['ready', 'blocked', 'cancelled', 'superseded'],
  ready: ['starting', 'paused', 'cancelled', 'superseded'],
  starting: ['running', 'blocked', 'outcome_unknown', 'failed', 'cancelled'],
  running: ['waiting_input', 'delivering', 'paused', 'blocked', 'outcome_unknown', 'failed', 'cancelled'],
  waiting_input: ['running', 'paused', 'blocked', 'outcome_unknown', 'failed', 'cancelled'],
  delivering: ['delivered', 'blocked', 'outcome_unknown', 'failed', 'cancelled'],
  delivered: ['integrating', 'blocked', 'superseded'],
  integrating: ['integrated', 'blocked', 'failed', 'superseded'],
  integrated: ['verified', 'blocked', 'failed', 'superseded'],
  verified: [],
  paused: ['waiting_dependencies', 'ready', 'running', 'waiting_input', 'delivering', 'cancelled', 'superseded'],
  blocked: ['waiting_dependencies', 'ready', 'running', 'delivering', 'cancelled', 'failed', 'superseded'],
  outcome_unknown: ['cancelled', 'failed', 'superseded'],
  failed: ['ready', 'superseded'],
  cancelled: [],
  superseded: []
}

export function isValidGroupTransition(from: DevelopmentGroupStatus, to: DevelopmentGroupStatus): boolean {
  return from === to || GROUP_TRANSITIONS[from].includes(to)
}

export function isValidSessionTransition(from: DevelopmentSessionStatus, to: DevelopmentSessionStatus): boolean {
  return from === to || SESSION_TRANSITIONS[from].includes(to)
}

export function allowedGroupTransitions(from: DevelopmentGroupStatus): readonly DevelopmentGroupStatus[] {
  return GROUP_TRANSITIONS[from]
}

export function allowedSessionTransitions(from: DevelopmentSessionStatus): readonly DevelopmentSessionStatus[] {
  return SESSION_TRANSITIONS[from]
}

import type { ExecutionSessionBindingState, ExecutionStepStatus, ExecutionTaskStatus } from './contracts.ts'

const TASK_TRANSITIONS: Readonly<Record<ExecutionTaskStatus, readonly ExecutionTaskStatus[]>> = {
  draft: ['ready', 'cancelled'],
  ready: ['running', 'blocked', 'waiting_human', 'cancelled', 'failed'],
  running: ['waiting_human', 'blocked', 'outcome_unknown', 'completed', 'cancelled', 'failed'],
  waiting_human: ['ready', 'running', 'blocked', 'cancelled', 'failed'],
  blocked: ['ready', 'running', 'waiting_human', 'cancelled', 'failed'],
  outcome_unknown: ['waiting_human', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: ['ready', 'cancelled']
}

const STEP_TRANSITIONS: Readonly<Record<ExecutionStepStatus, readonly ExecutionStepStatus[]>> = {
  pending: ['waiting_dependency', 'ready', 'cancelled'],
  waiting_dependency: ['ready', 'blocked', 'cancelled'],
  ready: ['dispatching', 'blocked', 'waiting_human', 'cancelled'],
  dispatching: ['running', 'waiting_human', 'blocked', 'outcome_unknown', 'failed', 'cancelled'],
  running: ['waiting_report', 'verifying', 'fix_required', 'waiting_human', 'blocked', 'outcome_unknown', 'failed', 'cancelled'],
  waiting_report: ['running', 'verifying', 'fix_required', 'waiting_human', 'blocked', 'outcome_unknown', 'failed', 'cancelled'],
  verifying: ['completed', 'fix_required', 'waiting_human', 'blocked', 'outcome_unknown', 'failed', 'cancelled'],
  fix_required: ['dispatching', 'running', 'waiting_human', 'blocked', 'failed', 'cancelled'],
  waiting_human: ['ready', 'dispatching', 'running', 'verifying', 'fix_required', 'blocked', 'failed', 'cancelled'],
  blocked: ['ready', 'dispatching', 'running', 'fix_required', 'waiting_human', 'failed', 'cancelled'],
  failed: ['ready', 'cancelled'],
  completed: [],
  cancelled: [],
  outcome_unknown: ['waiting_human', 'failed', 'cancelled']
}

const SESSION_BINDING_TRANSITIONS: Readonly<Record<ExecutionSessionBindingState, readonly ExecutionSessionBindingState[]>> = {
  created: ['active', 'suspended', 'closed', 'lost'],
  active: ['suspended', 'closed', 'lost'],
  suspended: ['active', 'closed', 'lost'],
  lost: ['active', 'closed'],
  closed: []
}

export class ExecutionStateTransitionError extends Error {}

export function isValidTaskTransition(from: ExecutionTaskStatus, to: ExecutionTaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to)
}

export function isValidStepTransition(from: ExecutionStepStatus, to: ExecutionStepStatus): boolean {
  return from === to || STEP_TRANSITIONS[from].includes(to)
}

export function isValidSessionBindingTransition(from: ExecutionSessionBindingState, to: ExecutionSessionBindingState): boolean {
  return from === to || SESSION_BINDING_TRANSITIONS[from].includes(to)
}

export function assertTaskTransition(from: ExecutionTaskStatus, to: ExecutionTaskStatus): void {
  if (!isValidTaskTransition(from, to)) throw new ExecutionStateTransitionError(`invalid task transition ${from} -> ${to}`)
}

export function assertStepTransition(from: ExecutionStepStatus, to: ExecutionStepStatus): void {
  if (!isValidStepTransition(from, to)) throw new ExecutionStateTransitionError(`invalid step transition ${from} -> ${to}`)
}

export function assertSessionBindingTransition(from: ExecutionSessionBindingState, to: ExecutionSessionBindingState): void {
  if (!isValidSessionBindingTransition(from, to)) throw new ExecutionStateTransitionError(`invalid session binding transition ${from} -> ${to}`)
}

export function allowedTaskTransitions(from: ExecutionTaskStatus): readonly ExecutionTaskStatus[] {
  return TASK_TRANSITIONS[from]
}

export function allowedStepTransitions(from: ExecutionStepStatus): readonly ExecutionStepStatus[] {
  return STEP_TRANSITIONS[from]
}

export function allowedSessionBindingTransitions(from: ExecutionSessionBindingState): readonly ExecutionSessionBindingState[] {
  return SESSION_BINDING_TRANSITIONS[from]
}

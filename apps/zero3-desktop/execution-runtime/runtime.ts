import { randomUUID } from 'node:crypto'

import {
  ZERO3_EXECUTION_ASSIGNMENT,
  ZERO3_EXECUTION_EVENT,
  ZERO3_EXECUTION_SESSION_BINDING,
  ZERO3_EXECUTION_STEP,
  ZERO3_EXECUTION_TASK,
  type ExecutionAssignment,
  type ExecutionEvent,
  type ExecutionEventType,
  type ExecutionExecutorTarget,
  type ExecutionRuntimeState,
  type ExecutionSessionBinding,
  type ExecutionSessionBindingState,
  type ExecutionStepDefinition,
  type ExecutionStepRuntime,
  type ExecutionStepStatus,
  type ExecutionTaskDefinition,
  type ExecutionTaskSnapshot,
  type ExecutionTaskStatus,
  type ExecutionWorkflowDefinition
} from './contracts.ts'
import { computeTaskProgress, dependencyReady, planExecutionSchedule, type ExecutionSchedulePlan } from './scheduler.ts'
import { assertSessionBindingTransition, assertStepTransition, assertTaskTransition } from './state-machine.ts'
import { Zero3ExecutionStore } from './store.ts'

const ACTIVE_STEPS = new Set<ExecutionStepStatus>(['dispatching', 'running', 'waiting_report', 'verifying'])

type StepDraft = Omit<ExecutionStepDefinition, 'contract' | 'taskId' | 'createdAt'> & { createdAt?: string }
type TaskDraft = Omit<ExecutionTaskDefinition, 'contract' | 'createdAt'> & { createdAt?: string }

export interface CreateExecutionTaskInput {
  task: TaskDraft
  steps: readonly StepDraft[]
}

export interface BindExecutionSessionInput {
  logicalSessionId: string
  runtimeConversationId?: string | null
  conversationUrl?: string | null
  state?: ExecutionSessionBindingState
  metadata?: Readonly<Record<string, unknown>>
}

function now(): string { return new Date().toISOString() }
function boundedProgress(value: number): number {
  if (!Number.isFinite(value)) throw new Error('progress must be finite')
  return Math.max(0, Math.min(1, value))
}

function initialStepRuntime(step: ExecutionStepDefinition, completed: ReadonlySet<string> = new Set()): ExecutionStepRuntime {
  return {
    taskId: step.taskId,
    stepId: step.stepId,
    status: step.dependsOn.every(id => completed.has(id)) ? 'ready' : 'waiting_dependency',
    attempt: 0,
    assignmentId: null,
    progress: 0,
    currentActivity: null,
    blocker: null,
    lastEventSequence: 0,
    updatedAt: step.createdAt
  }
}

function refreshDerived(runtime: ExecutionRuntimeState): ExecutionRuntimeState {
  const steps = [...runtime.steps]
  return {
    ...runtime,
    task: {
      ...runtime.task,
      progress: computeTaskProgress(steps),
      activeStepIds: steps.filter(step => ACTIVE_STEPS.has(step.status)).map(step => step.stepId)
    },
    steps
  }
}

function stepMap(runtime: ExecutionRuntimeState): Map<string, ExecutionStepRuntime> {
  return new Map(runtime.steps.map(step => [step.stepId, step] as const))
}

export class Zero3ExecutionRuntime {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(readonly store: Zero3ExecutionStore) {}

  private mutate<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId) ?? Promise.resolve()
    let resolveResult!: (value: T | PromiseLike<T>) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const current = previous.then(async () => {
      try { resolveResult(await operation()) } catch (error) { rejectResult(error) }
    })
    this.tails.set(taskId, current)
    void current.finally(() => { if (this.tails.get(taskId) === current) this.tails.delete(taskId) })
    return result
  }

  private async appendEvent(
    runtime: ExecutionRuntimeState,
    input: Omit<ExecutionEvent, 'contract' | 'eventId' | 'sequence' | 'at'> & { eventId?: string; at?: string }
  ): Promise<{ runtime: ExecutionRuntimeState; event: ExecutionEvent }> {
    const sequence = (await this.store.readEvents(input.taskId)).length + 1
    const at = input.at ?? now()
    const event: ExecutionEvent = {
      contract: ZERO3_EXECUTION_EVENT,
      eventId: input.eventId ?? `evt-${randomUUID()}`,
      sequence,
      taskId: input.taskId,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
      type: input.type,
      ...(input.payload ? { payload: input.payload } : {}),
      at
    }
    await this.store.appendEvent(event)
    const steps = runtime.steps.map(step => step.stepId === input.stepId ? { ...step, lastEventSequence: sequence, updatedAt: at } : step)
    return {
      event,
      runtime: {
        ...runtime,
        task: { ...runtime.task, lastEventSequence: sequence, updatedAt: at },
        steps
      }
    }
  }

  async createTask(input: CreateExecutionTaskInput): Promise<ExecutionTaskSnapshot> {
    const createdAt = input.task.createdAt ?? now()
    const task: ExecutionTaskDefinition = { contract: ZERO3_EXECUTION_TASK, ...input.task, createdAt }
    if (!Number.isInteger(task.maxParallelSteps) || task.maxParallelSteps < 1 || task.maxParallelSteps > 256) {
      throw new Error('maxParallelSteps must be an integer between 1 and 256')
    }
    const seen = new Set<string>()
    const steps = input.steps.map(step => {
      if (seen.has(step.stepId)) throw new Error(`duplicate step id ${step.stepId}`)
      seen.add(step.stepId)
      return { contract: ZERO3_EXECUTION_STEP, ...step, taskId: task.taskId, createdAt: step.createdAt ?? createdAt } satisfies ExecutionStepDefinition
    })
    const definition: ExecutionWorkflowDefinition = { revision: 1, task, steps }
    let runtime: ExecutionRuntimeState = {
      task: { taskId: task.taskId, status: 'ready', progress: 0, activeStepIds: [], blockers: [], lastEventSequence: 0, updatedAt: createdAt },
      steps: steps.map(step => initialStepRuntime(step)),
      assignments: [],
      sessionBindings: []
    }
    runtime = refreshDerived(runtime)
    await this.store.initialize(definition, runtime)
    const recorded = await this.appendEvent(runtime, {
      taskId: task.taskId,
      type: 'task.created',
      payload: { title: task.title, workflowId: task.workflowId, stepIds: steps.map(step => step.stepId) },
      at: createdAt
    })
    await this.store.writeSnapshot(definition, recorded.runtime)
    return this.snapshot(task.taskId)
  }

  async addSteps(taskId: string, drafts: readonly StepDraft[]): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      if (drafts.length === 0) return this.snapshot(taskId)
      const snapshot = await this.store.loadSnapshot(taskId)
      if (snapshot.runtime.task.status === 'completed' || snapshot.runtime.task.status === 'cancelled') {
        throw new Error(`cannot expand terminal task ${taskId} while ${snapshot.runtime.task.status}`)
      }
      const existingIds = new Set(snapshot.definition.steps.map(step => step.stepId))
      const createdAt = now()
      const additions = drafts.map(draft => {
        if (existingIds.has(draft.stepId)) throw new Error(`step id already exists: ${draft.stepId}`)
        existingIds.add(draft.stepId)
        return { contract: ZERO3_EXECUTION_STEP, ...draft, taskId, createdAt: draft.createdAt ?? createdAt } satisfies ExecutionStepDefinition
      })
      const definition: ExecutionWorkflowDefinition = {
        ...snapshot.definition,
        revision: snapshot.definition.revision + 1,
        steps: [...snapshot.definition.steps, ...additions]
      }
      const completed = new Set(snapshot.runtime.steps.filter(step => step.status === 'completed').map(step => step.stepId))
      let runtime: ExecutionRuntimeState = refreshDerived({
        ...snapshot.runtime,
        steps: [...snapshot.runtime.steps, ...additions.map(step => initialStepRuntime(step, completed))]
      })
      for (const step of additions) {
        const recorded = await this.appendEvent(runtime, { taskId, stepId: step.stepId, type: 'step.added', payload: { step } })
        runtime = recorded.runtime
      }
      await this.store.writeSnapshot(definition, refreshDerived(runtime))
      return this.snapshot(taskId)
    })
  }

  async transitionTask(taskId: string, status: ExecutionTaskStatus, reason?: string): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      assertTaskTransition(snapshot.runtime.task.status, status)
      let runtime: ExecutionRuntimeState = {
        ...snapshot.runtime,
        task: { ...snapshot.runtime.task, status, blockers: status === 'blocked' && reason ? [reason] : snapshot.runtime.task.blockers }
      }
      const recorded = await this.appendEvent(runtime, { taskId, type: 'task.state_changed', payload: { from: snapshot.runtime.task.status, to: status, ...(reason ? { reason } : {}) } })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async reconcileReadiness(taskId: string): Promise<ExecutionSchedulePlan> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      let runtime = snapshot.runtime
      let byStep = stepMap(runtime)
      for (const definition of snapshot.definition.steps) {
        const current = byStep.get(definition.stepId)!
        if (current.status !== 'pending' && current.status !== 'waiting_dependency') continue
        const next: ExecutionStepStatus = dependencyReady(definition, byStep) ? 'ready' : 'waiting_dependency'
        if (next === current.status) continue
        assertStepTransition(current.status, next)
        runtime = { ...runtime, steps: runtime.steps.map(step => step.stepId === current.stepId ? { ...step, status: next } : step) }
        const recorded = await this.appendEvent(runtime, { taskId, stepId: current.stepId, type: 'step.state_changed', payload: { from: current.status, to: next, reason: 'dependency_reconcile' } })
        runtime = recorded.runtime
        byStep = stepMap(runtime)
      }
      runtime = refreshDerived(runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return planExecutionSchedule({ steps: snapshot.definition.steps, runtimes: runtime.steps, maxParallelSteps: snapshot.definition.task.maxParallelSteps })
    })
  }

  async createAssignment(taskId: string, stepId: string, executor: Exclude<ExecutionExecutorTarget, 'AUTO'>, executorId: string | null = null): Promise<ExecutionAssignment> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const definition = snapshot.definition.steps.find(step => step.stepId === stepId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!definition || !current) throw new Error(`execution step not found: ${stepId}`)
      if (current.status !== 'ready' && current.status !== 'fix_required') throw new Error(`step ${stepId} is not assignable while ${current.status}`)
      if (current.attempt >= definition.maxAttempts) throw new Error(`step ${stepId} attempt budget exhausted`)
      const assignment: ExecutionAssignment = {
        contract: ZERO3_EXECUTION_ASSIGNMENT,
        assignmentId: `asg-${randomUUID()}`,
        taskId,
        stepId,
        attempt: current.attempt + 1,
        executor,
        executorId,
        createdAt: now()
      }
      assertStepTransition(current.status, 'dispatching')
      let runtime: ExecutionRuntimeState = {
        ...snapshot.runtime,
        task: snapshot.runtime.task.status === 'ready' ? { ...snapshot.runtime.task, status: 'running' } : snapshot.runtime.task,
        steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, status: 'dispatching', attempt: assignment.attempt, assignmentId: assignment.assignmentId, blocker: null } : step),
        assignments: [...snapshot.runtime.assignments, assignment]
      }
      const recorded = await this.appendEvent(runtime, {
        taskId,
        stepId,
        assignmentId: assignment.assignmentId,
        type: 'assignment.created',
        payload: { executor, executorId, attempt: assignment.attempt }
      })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return assignment
    })
  }

  async bindSession(assignmentId: string, input: BindExecutionSessionInput): Promise<ExecutionSessionBinding> {
    const taskId = await this.taskIdForAssignment(assignmentId)
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const assignment = snapshot.runtime.assignments.find(item => item.assignmentId === assignmentId)
      if (!assignment) throw new Error(`assignment not found: ${assignmentId}`)
      const existing = snapshot.runtime.sessionBindings.find(binding => binding.assignmentId === assignmentId && binding.state !== 'closed')
      if (existing) throw new Error(`assignment ${assignmentId} already has an active session binding`)
      const timestamp = now()
      const binding: ExecutionSessionBinding = {
        contract: ZERO3_EXECUTION_SESSION_BINDING,
        bindingId: `bind-${randomUUID()}`,
        taskId,
        stepId: assignment.stepId,
        assignmentId,
        executor: assignment.executor,
        logicalSessionId: input.logicalSessionId.trim(),
        runtimeConversationId: input.runtimeConversationId?.trim() || null,
        conversationUrl: input.conversationUrl?.trim() || null,
        state: input.state ?? 'active',
        metadata: input.metadata ?? {},
        createdAt: timestamp,
        updatedAt: timestamp
      }
      if (!binding.logicalSessionId) throw new Error('logicalSessionId is required')
      let runtime: ExecutionRuntimeState = { ...snapshot.runtime, sessionBindings: [...snapshot.runtime.sessionBindings, binding] }
      const recorded = await this.appendEvent(runtime, {
        taskId,
        stepId: assignment.stepId,
        assignmentId,
        type: 'session.bound',
        payload: { bindingId: binding.bindingId, logicalSessionId: binding.logicalSessionId, executor: binding.executor }
      })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return binding
    })
  }

  private async taskIdForAssignment(assignmentId: string): Promise<string> {
    for (const taskId of await this.store.listTaskIds()) {
      const runtime = await this.store.loadRuntime(taskId)
      if (runtime.assignments.some(item => item.assignmentId === assignmentId)) return taskId
    }
    throw new Error(`assignment not found: ${assignmentId}`)
  }

  async updateSessionBindingState(taskId: string, bindingId: string, state: ExecutionSessionBindingState): Promise<ExecutionSessionBinding> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const binding = snapshot.runtime.sessionBindings.find(item => item.bindingId === bindingId)
      if (!binding) throw new Error(`session binding not found: ${bindingId}`)
      assertSessionBindingTransition(binding.state, state)
      const updated = { ...binding, state, updatedAt: now() }
      let runtime: ExecutionRuntimeState = {
        ...snapshot.runtime,
        sessionBindings: snapshot.runtime.sessionBindings.map(item => item.bindingId === bindingId ? updated : item)
      }
      const recorded = await this.appendEvent(runtime, {
        taskId,
        stepId: binding.stepId,
        assignmentId: binding.assignmentId,
        type: 'session.state_changed',
        payload: { bindingId, from: binding.state, to: state }
      })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return updated
    })
  }

  async transitionStep(taskId: string, stepId: string, status: ExecutionStepStatus, reason?: string): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      assertStepTransition(current.status, status)
      let runtime: ExecutionRuntimeState = {
        ...snapshot.runtime,
        steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? {
          ...step,
          status,
          blocker: ['blocked', 'outcome_unknown', 'failed'].includes(status) ? (reason ?? step.blocker) : null
        } : step)
      }
      const type: ExecutionEventType = status === 'waiting_human' ? 'waiting_human' : status === 'blocked' ? 'blocked' : status === 'outcome_unknown' ? 'outcome_unknown' : 'step.state_changed'
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type, payload: { from: current.status, to: status, ...(reason ? { reason } : {}) } })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async recordProgress(taskId: string, stepId: string, progress: number, currentActivity?: string | null): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      if (!['dispatching', 'running', 'waiting_report'].includes(current.status)) throw new Error(`step ${stepId} cannot report progress while ${current.status}`)
      const normalized = boundedProgress(progress)
      let runtime: ExecutionRuntimeState = {
        ...snapshot.runtime,
        steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, progress: normalized, currentActivity: currentActivity?.trim() || null } : step)
      }
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'progress.updated', payload: { progress: normalized, currentActivity: currentActivity?.trim() || null } })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async recordArtifact(taskId: string, stepId: string, artifact: Readonly<Record<string, unknown>>): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      let runtime = snapshot.runtime
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'artifact.produced', payload: artifact })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async requestCompletion(taskId: string, stepId: string): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      assertStepTransition(current.status, 'verifying')
      let runtime: ExecutionRuntimeState = { ...snapshot.runtime, steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, status: 'verifying', progress: Math.max(step.progress, 0.95) } : step) }
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'completion.requested', payload: { from: current.status, to: 'verifying' } })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async gatePassed(taskId: string, stepId: string, evidence: Readonly<Record<string, unknown>> = {}): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      assertStepTransition(current.status, 'completed')
      let runtime: ExecutionRuntimeState = { ...snapshot.runtime, steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, status: 'completed', progress: 1, currentActivity: null, blocker: null } : step) }
      let recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'gate.passed', payload: evidence })
      runtime = recorded.runtime
      let byStep = stepMap(runtime)
      for (const definition of snapshot.definition.steps) {
        const dependent = byStep.get(definition.stepId)!
        if (dependent.status !== 'waiting_dependency' || !dependencyReady(definition, byStep)) continue
        runtime = { ...runtime, steps: runtime.steps.map(step => step.stepId === dependent.stepId ? { ...step, status: 'ready' } : step) }
        recorded = await this.appendEvent(runtime, { taskId, stepId: dependent.stepId, type: 'step.state_changed', payload: { from: 'waiting_dependency', to: 'ready', reason: 'dependency_completed' } })
        runtime = recorded.runtime
        byStep = stepMap(runtime)
      }
      if (runtime.steps.length > 0 && runtime.steps.every(step => step.status === 'completed')) {
        assertTaskTransition(runtime.task.status, 'completed')
        runtime = { ...runtime, task: { ...runtime.task, status: 'completed' } }
        recorded = await this.appendEvent(runtime, { taskId, type: 'task.completed', payload: { completedStepIds: runtime.steps.map(step => step.stepId) } })
        runtime = recorded.runtime
      }
      runtime = refreshDerived(runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async gateFailed(taskId: string, stepId: string, reason: string): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      assertStepTransition(current.status, 'fix_required')
      let runtime: ExecutionRuntimeState = { ...snapshot.runtime, steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, status: 'fix_required', blocker: reason.trim() || 'completion gate failed' } : step) }
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'gate.failed', payload: { reason: reason.trim() || 'completion gate failed' } })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async snapshot(taskId: string): Promise<ExecutionTaskSnapshot> {
    const [snapshot, events] = await Promise.all([this.store.loadSnapshot(taskId), this.store.readEvents(taskId)])
    return { definition: snapshot.definition, runtime: snapshot.runtime, events }
  }
}

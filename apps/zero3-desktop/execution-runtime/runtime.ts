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
  type ExecutionSkillPreflight,
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
import { stableJson } from '../group-runtime/store/atomic-file.ts'
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

export interface ExecutionEventIdentity {
  eventId?: string
  payload?: Readonly<Record<string, unknown>>
}

function eventPayload(
  base: Readonly<Record<string, unknown>>,
  identity?: ExecutionEventIdentity
): Readonly<Record<string, unknown>> {
  return identity?.payload ? { ...base, ...identity.payload } : base
}

function now(): string { return new Date().toISOString() }
function boundedProgress(value: number): number {
  if (!Number.isFinite(value)) throw new Error('progress must be finite')
  return Math.max(0, Math.min(1, value))
}

function initialSkillPreflight(step: ExecutionStepDefinition): ExecutionSkillPreflight | null {
  const requiredSkills = [...(step.requiredSkills ?? [])]
  const optionalSkills = [...(step.optionalSkills ?? [])]
  if (requiredSkills.length || optionalSkills.length) return null
  return { state: 'not_required', executor: step.executor === 'AUTO' ? null : step.executor, adapterMode: 'unsupported', requiredSkills, optionalSkills, availableRequiredSkills: [], availableOptionalSkills: [], missingRequiredSkills: [], missingOptionalSkills: [], checkedAt: step.createdAt }
}

function initialStepRuntime(step: ExecutionStepDefinition, completed: ReadonlySet<string> = new Set()): ExecutionStepRuntime {
  return {
    taskId: step.taskId,
    stepId: step.stepId,
    status: step.dependsOn.every(id => completed.has(id)) ? 'ready' : 'waiting_dependency',
    skillPreflight: initialSkillPreflight(step),
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
    const events = await this.store.readEvents(input.taskId)
    const explicitId = input.eventId?.trim() || null
    if (explicitId) {
      const existing = events.find(event => event.eventId === explicitId)
      if (existing) {
        const expected = {
          taskId: input.taskId,
          stepId: input.stepId ?? null,
          assignmentId: input.assignmentId ?? null,
          type: input.type,
          payload: input.payload ?? null
        }
        const observed = {
          taskId: existing.taskId,
          stepId: existing.stepId ?? null,
          assignmentId: existing.assignmentId ?? null,
          type: existing.type,
          payload: existing.payload ?? null
        }
        if (stableJson(expected) !== stableJson(observed)) {
          throw new Error(`event id ${explicitId} was reused with different execution report content`)
        }
        const steps = runtime.steps.map(step => step.stepId === input.stepId
          ? { ...step, lastEventSequence: Math.max(step.lastEventSequence, existing.sequence), updatedAt: existing.at }
          : step)
        return {
          event: existing,
          runtime: {
            ...runtime,
            task: { ...runtime.task, lastEventSequence: Math.max(runtime.task.lastEventSequence, existing.sequence), updatedAt: existing.at },
            steps
          }
        }
      }
    }
    const sequence = events.length + 1
    const at = input.at ?? now()
    const event: ExecutionEvent = {
      contract: ZERO3_EXECUTION_EVENT,
      eventId: explicitId ?? `evt-${randomUUID()}`,
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

  async recordSkillPreflight(taskId: string, stepId: string, preflight: ExecutionSkillPreflight): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const definition = snapshot.definition.steps.find(step => step.stepId === stepId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!definition || !current) throw new Error(`execution step not found: ${stepId}`)
      const required = [...(definition.requiredSkills ?? [])]
      const optional = [...(definition.optionalSkills ?? [])]
      if (JSON.stringify(required) !== JSON.stringify([...preflight.requiredSkills]) || JSON.stringify(optional) !== JSON.stringify([...preflight.optionalSkills])) {
        throw new Error(`Skill preflight contract mismatch for step ${stepId}`)
      }
      if (!Number.isFinite(new Date(preflight.checkedAt).getTime())) throw new Error('Skill preflight checkedAt is invalid')
      if (preflight.state === 'ready' && preflight.missingRequiredSkills.length > 0) throw new Error('ready Skill preflight cannot contain missing required Skills')
      const skillBlocker = preflight.missingRequiredSkills.length > 0 ? `Missing required Skills: ${preflight.missingRequiredSkills.join(', ')}` : null
      const blocker = skillBlocker ?? (current.blocker?.startsWith('Missing required Skills:') ? null : current.blocker)
      let runtime: ExecutionRuntimeState = { ...snapshot.runtime, steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, skillPreflight: structuredClone(preflight), blocker } : step) }
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'skill.preflight', payload: { state: preflight.state, executor: preflight.executor, adapterMode: preflight.adapterMode, requiredSkills: preflight.requiredSkills, optionalSkills: preflight.optionalSkills, availableRequiredSkills: preflight.availableRequiredSkills, missingRequiredSkills: preflight.missingRequiredSkills, missingOptionalSkills: preflight.missingOptionalSkills } })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async createAssignment(taskId: string, stepId: string, executor: Exclude<ExecutionExecutorTarget, 'AUTO'>, executorId: string | null = null): Promise<ExecutionAssignment> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const definition = snapshot.definition.steps.find(step => step.stepId === stepId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!definition || !current) throw new Error(`execution step not found: ${stepId}`)
      if (['completed', 'cancelled', 'failed'].includes(snapshot.runtime.task.status)) throw new Error('cannot assign a terminal task')
      const requiredSkills = definition.requiredSkills ?? []
      if (requiredSkills.length > 0) {
        const preflight = current.skillPreflight
        if (!preflight || preflight.state !== 'ready' || preflight.missingRequiredSkills.length > 0) throw new Error(`step ${stepId} required Skills have not passed preflight`)
        if (preflight.executor !== executor) throw new Error(`step ${stepId} Skill preflight recommends ${preflight.executor ?? 'no executor'}, not ${executor}`)
      }
      if (current.status !== 'ready' && current.status !== 'fix_required') throw new Error(`step ${stepId} is not assignable while ${current.status}`)
      if (current.attempt >= definition.maxAttempts) throw new Error(`step ${stepId} attempt budget exhausted`)
      if (!dependencyReady(definition, stepMap(snapshot.runtime))) throw new Error('step dependencies are not completed')
      if (snapshot.runtime.steps.filter(step => ACTIVE_STEPS.has(step.status)).length >= snapshot.definition.task.maxParallelSteps) throw new Error('task parallel step capacity exhausted')
      if (!['GPT_WEB', 'GEMINI_WEB', 'CODEX', 'CLAUDE', 'ANTIGRAVITY', 'ZERO3', 'REMOTE_COMPUTE', 'HUMAN'].includes(executor)) throw new Error('invalid assignment executor')
      if (definition.executor !== 'AUTO' && definition.executor !== executor) throw new Error('assignment executor does not match step')
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

  async transitionStep(taskId: string, stepId: string, status: ExecutionStepStatus, reason?: string, identity?: ExecutionEventIdentity): Promise<ExecutionTaskSnapshot> {
    if (status === 'completed') throw new Error('step completion requires gatePassed')
    if (status === 'verifying') return this.requestCompletion(taskId, stepId, { ...identity, payload: { ...identity?.payload, ...(reason ? { reason } : {}) } })
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      assertStepTransition(current.status, status)
      if (status === 'ready' && !dependencyReady(snapshot.definition.steps.find(step => step.stepId === stepId)!, stepMap(snapshot.runtime))) throw new Error('step dependencies are not completed')
      if (ACTIVE_STEPS.has(status) && !ACTIVE_STEPS.has(current.status)) {
        if (!current.assignmentId) throw new Error('active step requires an assignment')
        if (snapshot.runtime.steps.filter(step => ACTIVE_STEPS.has(step.status)).length >= snapshot.definition.task.maxParallelSteps) throw new Error('task parallel step capacity exhausted')
      }
      let runtime: ExecutionRuntimeState = {
        ...snapshot.runtime,
        steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? {
          ...step,
          status,
          blocker: ['blocked', 'outcome_unknown', 'failed', 'waiting_human'].includes(status) ? (reason ?? step.blocker) : null
        } : step)
      }
      const type: ExecutionEventType = status === 'waiting_human' ? 'waiting_human' : status === 'blocked' ? 'blocked' : status === 'outcome_unknown' ? 'outcome_unknown' : 'step.state_changed'
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type, eventId: identity?.eventId, payload: eventPayload({ from: current.status, to: status, ...(reason ? { reason } : {}) }, identity) })
      runtime = refreshDerived(recorded.runtime)
      if (runtime.task.status !== 'cancelled' && runtime.steps.some(step => step.status === 'cancelled') && runtime.steps.every(step => ['completed', 'cancelled'].includes(step.status))) {
        assertTaskTransition(runtime.task.status, 'cancelled')
        const from = runtime.task.status
        runtime = { ...runtime, task: { ...runtime.task, status: 'cancelled' } }
        runtime = (await this.appendEvent(runtime, { taskId, type: 'task.state_changed', payload: { from, to: 'cancelled', reason: 'all_steps_terminal' } })).runtime
      }
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async recordProgress(taskId: string, stepId: string, progress: number, currentActivity?: string | null, identity?: ExecutionEventIdentity): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      if (!['dispatching', 'running', 'waiting_report', 'fix_required'].includes(current.status)) throw new Error(`step ${stepId} cannot report progress while ${current.status}`)
      const normalized = boundedProgress(progress)
      if (current.status !== 'running') assertStepTransition(current.status, 'running')
      let runtime: ExecutionRuntimeState = {
        ...snapshot.runtime,
        steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, status: 'running', progress: normalized, currentActivity: currentActivity?.trim() || null, blocker: null } : step)
      }
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'progress.updated', eventId: identity?.eventId, payload: eventPayload({ progress: normalized, currentActivity: currentActivity?.trim() || null, fromStatus: current.status, toStatus: 'running' }, identity) })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async recordArtifact(taskId: string, stepId: string, artifact: Readonly<Record<string, unknown>>, identity?: ExecutionEventIdentity): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      let runtime = snapshot.runtime
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'artifact.produced', eventId: identity?.eventId, payload: eventPayload(artifact, identity) })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  async requestCompletion(taskId: string, stepId: string, identity?: ExecutionEventIdentity): Promise<ExecutionTaskSnapshot> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
      if (!current) throw new Error(`execution step not found: ${stepId}`)
      if (!current.assignmentId) throw new Error('completion request requires an assignment')
      if (!ACTIVE_STEPS.has(current.status) && snapshot.runtime.steps.filter(step => ACTIVE_STEPS.has(step.status)).length >= snapshot.definition.task.maxParallelSteps) throw new Error('task parallel step capacity exhausted')
      assertStepTransition(current.status, 'verifying')
      let runtime: ExecutionRuntimeState = { ...snapshot.runtime, steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, status: 'verifying', progress: Math.max(step.progress, 0.95) } : step) }
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'completion.requested', eventId: identity?.eventId, payload: eventPayload({ from: current.status, to: 'verifying' }, identity) })
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
      if (current.status !== 'verifying') throw new Error('completion gate requires a verifying step')
      if (evidence.source === 'human_task_review') {
        if (evidence.assignmentId !== current.assignmentId) throw new Error('review assignment is stale; refresh the task')
        if (typeof evidence.note !== 'string' || !evidence.note.trim()) throw new Error('human review requires evidence')
        const definition = snapshot.definition.steps.find(step => step.stepId === stepId)!
        const artifacts = (await this.store.readEvents(taskId)).filter(event => event.type === 'artifact.produced' && event.stepId === stepId && event.assignmentId === current.assignmentId)
        for (const output of definition.expectedOutputs.filter(output => output.required)) {
          const ids = new Set(artifacts.filter(event => event.payload?.logicalName === output.logicalName).map(event => event.payload?.artifactId ?? event.eventId))
          if (ids.size < (output.minCount ?? 1)) throw new Error(`missing required output: ${output.logicalName}`)
        }
      }
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
      } else if (runtime.steps.every(step => ['completed', 'cancelled'].includes(step.status))) {
        assertTaskTransition(runtime.task.status, 'cancelled')
        const from = runtime.task.status
        runtime = { ...runtime, task: { ...runtime.task, status: 'cancelled' } }
        runtime = (await this.appendEvent(runtime, { taskId, type: 'task.state_changed', payload: { from, to: 'cancelled', reason: 'all_steps_terminal' } })).runtime
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
      if (current.status !== 'verifying') throw new Error('completion gate requires a verifying step')
      assertStepTransition(current.status, 'fix_required')
      let runtime: ExecutionRuntimeState = { ...snapshot.runtime, steps: snapshot.runtime.steps.map(step => step.stepId === stepId ? { ...step, status: 'fix_required', blocker: reason.trim() || 'completion gate failed' } : step) }
      const recorded = await this.appendEvent(runtime, { taskId, stepId, assignmentId: current.assignmentId ?? undefined, type: 'gate.failed', payload: { reason: reason.trim() || 'completion gate failed' } })
      runtime = refreshDerived(recorded.runtime)
      await this.store.writeSnapshot(snapshot.definition, runtime)
      return this.snapshot(taskId)
    })
  }

  /**
   * 归档或取消归档一个任务。归档只写入独立侧车记录并留下一条审计事件，
   * 不修改任务定义与执行状态，因此不会打断正在执行的步骤。
   */
  async setTaskArchived(taskId: string, archived: boolean): Promise<ExecutionTaskSnapshot> {
    if (typeof archived !== 'boolean') throw new Error('archived must be a boolean')
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const current = await this.store.readArchive(taskId)
      if (current.archived === archived) return this.snapshot(taskId)
      const at = now()
      await this.store.writeArchive(taskId, archived, at)
      const recorded = await this.appendEvent(snapshot.runtime, {
        taskId,
        type: archived ? 'task.archived' : 'task.unarchived',
        payload: { title: snapshot.definition.task.title },
        at
      })
      await this.store.writeSnapshot(snapshot.definition, refreshDerived(recorded.runtime))
      return this.snapshot(taskId)
    })
  }

  /**
   * 物理删除任务。有步骤处于活动状态时拒绝删除，避免外部执行方在无主任务上继续回报。
   */
  async deleteTask(taskId: string): Promise<void> {
    return this.mutate(taskId, async () => {
      const snapshot = await this.store.loadSnapshot(taskId)
      const active = snapshot.runtime.steps.filter(step => ACTIVE_STEPS.has(step.status))
      if (active.length > 0) {
        throw new Error(`任务仍有 ${active.length} 个步骤处于执行中，请先取消或归档后再删除。`)
      }
      await this.store.deleteTask(taskId)
    })
  }

  async snapshot(taskId: string): Promise<ExecutionTaskSnapshot> {
    const [snapshot, events, archive] = await Promise.all([
      this.store.loadSnapshot(taskId),
      this.store.readEvents(taskId),
      this.store.readArchive(taskId)
    ])
    return { definition: snapshot.definition, runtime: snapshot.runtime, events, archived: archive.archived }
  }
}

import { createHash, randomUUID } from 'node:crypto'

import { normalizeWorkflowArtifactRef, type WorkflowArtifactRef } from './contracts.ts'
import type {
  AgentLifecycleSession,
  LifecycleAgentType,
  LifecycleCompletionState,
  LifecycleEventType,
  LifecycleImportance,
  LifecycleMemoryCommitInput,
  LifecycleTaskContext
} from './lifecycle-contracts.ts'
import { Zero3AgentLifecycleStore } from './lifecycle-store.ts'

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
const TERMINAL_TASKS = new Set(['completed', 'cancelled', 'failed'])
const ACTIVE_STEPS = new Set(['dispatching', 'running', 'waiting_report', 'verifying'])

type Snapshot = any
export type LifecycleExecutionPort = {
  listTasks(): Promise<Snapshot[]>
  getTask(taskId: string): Promise<Snapshot>
  refreshSkillPreflight?(taskId: string): Promise<Snapshot>
  createTask(input: Record<string, unknown>): Promise<Snapshot>
  createAssignment(taskId: string, stepId: string, executor: 'GPT_WEB', executorId?: string | null): Promise<any>
  bindSession(assignmentId: string, input: Record<string, unknown>): Promise<any>
  recordProgress(taskId: string, stepId: string, progress: number, currentActivity?: string | null, identity?: Record<string, unknown>): Promise<Snapshot>
  recordArtifact(taskId: string, stepId: string, artifact: Record<string, unknown>, identity?: Record<string, unknown>): Promise<Snapshot>
  requestCompletion(taskId: string, stepId: string, identity?: Record<string, unknown>): Promise<Snapshot>
  updateSessionState(taskId: string, bindingId: string, state: 'active' | 'suspended' | 'closed' | 'lost'): Promise<unknown>
  transitionStep(taskId: string, stepId: string, status: string, reason?: string): Promise<Snapshot>
}

export type LifecycleMemoryPort = {
  getProject(projectId: string): Promise<any>
  publish(event: Record<string, unknown>): Promise<any>
}
export type LifecycleArtifactPort = {
  register(input: Record<string, unknown>): Promise<any>
  list(taskId: string): Promise<any[]>
  get(taskId: string, artifactId: string): Promise<any | null>
}
export type LifecycleRuntimeOptions = {
  clock?: () => Date
  memoryForProject: (projectId: string) => Promise<LifecycleMemoryPort | null>
}

function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}
function text(value: unknown, label: string, max = 4096, required = true): string | null {
  if (value == null && !required) return null
  const normalized = typeof value === 'string' ? value.trim() : ''
  if ((required && !normalized) || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized || null
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function agentType(value: unknown): LifecycleAgentType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!['web_gpt', 'codex', 'claude', 'hermes', 'zero3', 'antigravity', 'other'].includes(normalized)) throw new Error('agentType is invalid')
  return normalized as LifecycleAgentType
}

function memoryAgentType(value: LifecycleAgentType): string {
  if (value === 'web_gpt') return 'gpt_web'
  if (value === 'hermes' || value === 'other') return 'zero3'
  return value
}
function deterministicAgentId(type: LifecycleAgentType, sessionId: string): string {
  const suffix = createHash('sha256').update(`${type}:${sessionId}`).digest('hex').slice(0, 20)
  return `agent-${type}-${suffix}`
}
function importance(value: unknown): LifecycleImportance {
  const normalized = value == null ? 'normal' : String(value).trim().toLowerCase()
  if (!['low', 'normal', 'high', 'critical'].includes(normalized)) throw new Error('importance is invalid')
  return normalized as LifecycleImportance
}
function eventType(value: unknown): LifecycleEventType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!['decision', 'progress', 'warning', 'error', 'discovery', 'user_instruction', 'dependency'].includes(normalized)) {
    throw new Error('eventType is invalid')
  }
  return normalized as LifecycleEventType
}
function array(value: unknown, label: string, max = 100): unknown[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must contain at most ${max} items`)
  return value
}
function nowIso(clock: () => Date): string { return clock().toISOString() }
function entityContent(value: string | Record<string, unknown>): Record<string, unknown> {
  return typeof value === 'string' ? { text: value } : { ...value }
}
function entityId(prefix: string, value: string | Record<string, unknown>): string {
  if (typeof value === 'object' && typeof value.entityId === 'string' && ID_RE.test(value.entityId.trim())) return value.entityId.trim()
  return `${prefix}-${randomUUID()}`
}

export class Zero3AgentLifecycleRuntime {
  private readonly clock: () => Date
  private readonly tails = new Map<string, Promise<void>>()

  constructor(
    readonly store: Zero3AgentLifecycleStore,
    readonly execution: LifecycleExecutionPort,
    readonly artifacts: LifecycleArtifactPort,
    readonly options: LifecycleRuntimeOptions
  ) {
    this.clock = options.clock ?? (() => new Date())
  }

  private mutate<T>(scope: string, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(scope) ?? Promise.resolve()
    let resolveResult!: (value: T | PromiseLike<T>) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const current = previous.then(async () => {
      try { resolveResult(await run()) } catch (error) { rejectResult(error) }
    })
    this.tails.set(scope, current)
    void current.finally(() => { if (this.tails.get(scope) === current) this.tails.delete(scope) })
    return result
  }

  private async idempotent<T>(scope: string, key: unknown, operation: string, request: unknown, run: () => Promise<T>): Promise<T> {
    const existing = this.store.getIdempotent(scope, key, operation, request)
    if (existing != null) return existing as T
    const response = await run()
    this.store.putIdempotent(scope, key, operation, request, response, nowIso(this.clock))
    return response
  }

  private requireSession(sessionId: unknown): AgentLifecycleSession {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('agent lifecycle session not found; call session.start first')
    return session
  }

  private async resolveTaskForSession(projectId: string, sessionId: string, requestedTaskId?: string | null): Promise<Snapshot> {
    if (requestedTaskId) {
      const snapshot = await this.execution.getTask(id(requestedTaskId, 'taskId'))
      if (snapshot.definition?.task?.projectId !== projectId) throw new Error('task does not belong to project')
      return snapshot
    }
    const candidates = (await this.execution.listTasks()).filter(snapshot =>
      snapshot?.definition?.task?.projectId === projectId && !TERMINAL_TASKS.has(snapshot?.runtime?.task?.status)
    )
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) throw new Error('multiple active project tasks exist; taskId is required')
    const taskId = `agent-task-${randomUUID()}`
    return this.execution.createTask({
      task: {
        taskId,
        projectId,
        title: 'Web GPT shared organizational task',
        goal: 'Execute the bound agent task and persist shared organizational state.',
        workflowId: 'agent-lifecycle',
        maxParallelSteps: 1,
        createdBySessionId: sessionId,
        metadata: { autoCreatedBy: 'agent_lifecycle', agentClaimMode: 'exclusive' }
      },
      steps: [{
        stepId: 'agent-work', title: 'Agent work',
        objective: 'Perform work and submit artifacts, shared memory and handoff through Zero3.',
        executor: 'GPT_WEB', dependsOn: [], inputArtifacts: [], expectedOutputs: [],
        completionGate: ['structured_handoff'], maxAttempts: 3, metadata: { agentLifecycle: true }
      }]
    })
  }

  async sessionStart(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = object(inputValue, 'session.start input')
    const sessionId = id(input.sessionId ?? input.session_id, 'sessionId')
    const projectId = id(input.projectId ?? input.project_id, 'projectId')
    const type = agentType(input.agentType ?? input.agent_type ?? 'web_gpt')
    const agentId = input.agentId == null && input.agent_id == null
      ? deterministicAgentId(type, sessionId)
      : id(input.agentId ?? input.agent_id, 'agentId')
    const requestedTaskId = (input.taskId ?? input.task_id) as string | null | undefined
    const key = input.idempotencyKey ?? input.idempotency_key
    return this.mutate(`session:${sessionId}`, async () => this.idempotent(`session:${sessionId}`, key, 'session.start', {
      sessionId, projectId, type, agentId, requestedTaskId: requestedTaskId ?? null
    }, async () => {
      const task = await this.resolveTaskForSession(projectId, sessionId, requestedTaskId)
      const taskId = id(task.definition.task.taskId, 'taskId')
      const at = nowIso(this.clock)
      const session = this.store.upsertSession({ sessionId, agentId, agentType: type, projectId, taskId, at })
      const contextVersion = this.store.bumpContext({
        taskId, projectId, type: 'session.start', refId: sessionId,
        summary: `${type} session ${sessionId} started`, at
      })
      this.store.recordWorklog({ session, eventType: 'session.start', importance: 'normal', content: { contextVersion }, at })
      return { sessionId, agentId, projectId, taskId, contextVersion }
    }))
  }

  async taskClaim(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = object(inputValue, 'task.claim input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const requestedTaskId = input.taskId ?? input.task_id ?? session.taskId
    const taskId = id(requestedTaskId, 'taskId')
    if (taskId !== session.taskId) throw new Error('session is bound to a different task')
    const key = input.idempotencyKey ?? input.idempotency_key
    return this.mutate(`task:${taskId}`, async () => this.idempotent(`task:${taskId}:session:${session.sessionId}`, key, 'task.claim', { taskId, sessionId: session.sessionId }, async () => {
      if (this.execution.refreshSkillPreflight) await this.execution.refreshSkillPreflight(taskId)
      const snapshot = await this.execution.getTask(taskId)
      if (TERMINAL_TASKS.has(snapshot.runtime.task.status)) throw new Error(`task is terminal: ${snapshot.runtime.task.status}`)
      const current = this.store.activeClaimForSession(session.sessionId)
      if (current) return { state: 'CLAIMED', resumed: true, claim: current, taskStatus: snapshot.runtime.task.status }

      const activeClaims = this.store.activeClaims(taskId)
      const claimMode = snapshot.definition.task.metadata?.agentClaimMode === 'shared' || snapshot.definition.task.maxParallelSteps > 1 ? 'shared' : 'exclusive'
      if (claimMode === 'exclusive' && activeClaims.some(claim => claim.sessionId !== session.sessionId)) {
        return { state: 'LOCKED', lock: 'exclusive', taskStatus: snapshot.runtime.task.status, activeAgents: activeClaims.map(claim => claim.agentId) }
      }
      const activeCount = snapshot.runtime.steps.filter((step: any) => ACTIVE_STEPS.has(step.status)).length
      const capacity = Math.max(0, Number(snapshot.definition.task.maxParallelSteps) - activeCount)
      const runtimeById = new Map(snapshot.runtime.steps.map((step: any) => [step.stepId, step]))
      const definition = capacity > 0 ? snapshot.definition.steps.find((step: any) => {
        const runtime = runtimeById.get(step.stepId) as any
        if (!runtime || !['ready', 'fix_required'].includes(runtime.status)) return false
        if (step.executor === 'GPT_WEB') return true
        if (step.executor !== 'AUTO') return false
        const requiredSkills = Array.isArray(step.requiredSkills) ? step.requiredSkills : []
        if (requiredSkills.length === 0) return true
        return runtime.skillPreflight?.state === 'ready' && runtime.skillPreflight?.executor === 'GPT_WEB' && !(runtime.skillPreflight?.missingRequiredSkills?.length ?? 0)
      }) : null
      const at = nowIso(this.clock)
      let stepId: string | null = null
      let assignmentId: string | null = null
      let bindingId: string | null = null
      if (definition) {
        const selectedStepId = id(definition.stepId, 'stepId')
        stepId = selectedStepId
        const assignment = await this.execution.createAssignment(taskId, selectedStepId, 'GPT_WEB', session.agentId)
        assignmentId = assignment.assignmentId
        const binding = await this.execution.bindSession(assignmentId!, {
          logicalSessionId: session.sessionId,
          runtimeConversationId: input.conversationId ?? input.conversation_id ?? null,
          conversationUrl: input.conversationUrl ?? input.conversation_url ?? null,
          state: 'active', metadata: { agentId: session.agentId, agentType: session.agentType }
        })
        bindingId = binding.bindingId
        await this.execution.recordProgress(taskId, selectedStepId, 0, 'Agent claimed task', { eventId: `lifecycle-claim-${assignmentId}` })
      }
      const claim = this.store.createClaim({ taskId, sessionId: session.sessionId, agentId: session.agentId, mode: claimMode, stepId, assignmentId, bindingId, at })
      this.store.updateSessionBinding(session.sessionId, { stepId, assignmentId, bindingId, state: definition ? 'ACTIVE' : 'WAITING', at })
      const contextVersion = this.store.bumpContext({ taskId, projectId: session.projectId, type: 'task.claim', refId: claim.claimId, summary: `${session.agentId} claimed ${taskId}`, at })
      this.store.recordWorklog({ session: this.requireSession(session.sessionId), eventType: 'task.claim', importance: 'normal', content: { claimId: claim.claimId, stepId, assignmentId, claimMode, contextVersion }, at })
      return {
        state: definition ? 'CLAIMED' : 'WAITING', claim, lock: claimMode,
        allowParallel: claimMode === 'shared', taskStatus: snapshot.runtime.task.status,
        activeAgents: [...activeClaims.map(item => item.agentId), session.agentId], contextVersion
      }
    }))
  }

  private async flushMemoryOutbox(projectId: string, taskId: string): Promise<{ acked: string[]; pending: number }> {
    let memory: LifecycleMemoryPort | null = null
    try { memory = await this.options.memoryForProject(projectId) } catch { return { acked: [], pending: this.store.memoryOutboxPending(taskId).length } }
    const pending = this.store.memoryOutboxPending(taskId)
    if (!memory || pending.length === 0) return { acked: [], pending: pending.length }
    const acked: string[] = []
    for (const item of pending) {
      try {
        await memory.publish(item.event)
        this.store.markMemory(item.eventId, 'acked', null, nowIso(this.clock))
        acked.push(item.eventId)
      } catch (error) {
        this.store.markMemory(item.eventId, 'pending', error instanceof Error ? error.message : String(error), nowIso(this.clock))
        break
      }
    }
    return { acked, pending: this.store.memoryOutboxPending(taskId).length }
  }

  private async memoryContext(projectId: string): Promise<{ memory: LifecycleMemoryPort | null; context: any | null; warning: string | null }> {
    let memory: LifecycleMemoryPort | null = null
    try { memory = await this.options.memoryForProject(projectId) } catch (error) {
      return { memory: null, context: null, warning: `shared_memory_open_failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!memory) return { memory: null, context: null, warning: 'shared_memory_unconfigured' }
    try { return { memory, context: await memory.getProject(projectId), warning: null } }
    catch (error) { return { memory, context: null, warning: `shared_memory_unavailable: ${error instanceof Error ? error.message : String(error)}` } }
  }

  async contextResolve(inputValue: unknown): Promise<LifecycleTaskContext> {
    const input = object(inputValue, 'context.resolve input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const snapshot = await this.execution.getTask(session.taskId)
    await this.flushMemoryOutbox(session.projectId, session.taskId)
    const memoryResult = await this.memoryContext(session.projectId)
    const artifacts = await this.artifacts.list(session.taskId)
    const entities: any[] = Array.isArray(memoryResult.context?.entities) ? memoryResult.context.entities : []
    const relevant = entities.filter(entity => entity?.memory_class === 'project' || entity?.task_id === session.taskId)
    const decisions = relevant.filter(entity => entity?.entity_type === 'decision')
    const policyEntities = relevant.filter(entity => entity?.entity_type === 'policy')
    const projectedPoliciesRaw = memoryResult.context?.payload?.policies
    const projectedPolicies = Array.isArray(projectedPoliciesRaw)
      ? projectedPoliciesRaw
      : projectedPoliciesRaw && typeof projectedPoliciesRaw === 'object'
        ? Object.entries(projectedPoliciesRaw).map(([key, value]) => ({ key, value }))
        : []
    const projectMemory = relevant.filter(entity => entity?.memory_class === 'project' && !['decision', 'policy'].includes(entity?.entity_type))
    const upstreamResults = relevant.filter(entity => entity?.entity_type === 'handoff')
    const memoryWarnings = relevant.filter(entity => ['warning', 'pitfall'].includes(entity?.entity_type))
    const taskWarnings = Array.isArray(snapshot.runtime?.task?.blockers) ? snapshot.runtime.task.blockers : []
    const readySteps = snapshot.runtime.steps.filter((step: any) => ['ready', 'fix_required'].includes(step.status)).map((step: any) => {
      const definition = snapshot.definition.steps.find((item: any) => item.stepId === step.stepId)
      return { stepId: step.stepId, title: definition?.title ?? step.stepId, status: step.status, blocker: step.blocker ?? null }
    })
    const memoryVersion = Number(memoryResult.context?.sync?.last_sequence ?? memoryResult.context?.version ?? 0)
    const executionSequence = Number(snapshot.runtime?.task?.lastEventSequence ?? 0)
    const contextVersion = this.store.reconcileExternalSources({
      taskId: session.taskId, projectId: session.projectId,
      memoryVersion: Number.isSafeInteger(memoryVersion) ? memoryVersion : 0,
      executionSequence: Number.isSafeInteger(executionSequence) ? executionSequence : 0,
      artifactCount: artifacts.length, at: nowIso(this.clock)
    })
    const handoffActions = upstreamResults.flatMap(entity => {
      const content = entity?.content ?? {}
      const actions = content.recommended_next_actions ?? content.next_actions ?? (content.next_action ? [content.next_action] : [])
      return Array.isArray(actions) ? actions : []
    })
    const warnings: unknown[] = [...taskWarnings, ...memoryWarnings]
    if (memoryResult.warning) warnings.push({ type: 'memory', message: memoryResult.warning })
    const worklog = this.store.listWorklog(session.taskId, 100)
    this.store.touchSession(session.sessionId, nowIso(this.clock))
    return {
      task: snapshot,
      projectMemory: projectMemory.slice(-50),
      policies: [...projectedPolicies.slice(-50), ...policyEntities.slice(-50)].slice(-50),
      decisions: decisions.slice(-50),
      upstreamResults: upstreamResults.slice(-20),
      artifacts: artifacts.slice(-200),
      worklog,
      warnings: warnings.slice(-100),
      nextActions: [...handoffActions.slice(-20), ...readySteps.slice(0, 20)],
      contextVersion
    }
  }

  contextCheck(inputValue: unknown): Record<string, unknown> {
    const input = object(inputValue, 'context.check input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const version = Number(input.contextVersion ?? input.context_version)
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('contextVersion is invalid')
    const current = this.store.currentContextVersion(session.taskId)
    return { stale: version < current, contextVersion: current, changes: this.store.changesSince(session.taskId, version) }
  }

  private buildMemoryEvent(session: AgentLifecycleSession, input: {
    eventType: string; memoryClass: 'project' | 'task'; entityType: string; entityId: string;
    payload: Record<string, unknown>; authority?: number; confidence?: number; expectedVersion: number; sourceType?: string
  }): Record<string, unknown> {
    const eventId = randomUUID()
    return {
      schema: 'zero3.memory.event.v1', event_id: eventId, created_at: nowIso(this.clock),
      scope: {
        project_id: session.projectId,
        ...(input.memoryClass === 'task' ? { task_id: session.taskId } : {}),
        session_id: session.sessionId
      },
      actor: { agent_id: session.agentId, agent_type: memoryAgentType(session.agentType) },
      event_type: input.eventType,
      memory: {
        class: input.memoryClass, entity_type: input.entityType, entity_id: input.entityId,
        authority: input.authority ?? 40, confidence: input.confidence ?? 0.8,
        expected_entity_version: input.expectedVersion
      },
      source: { type: input.sourceType ?? 'task', ref: session.taskId },
      supersedes: [], payload: input.payload
    }
  }

  private async publishMemorySpecs(session: AgentLifecycleSession, specs: Array<{
    eventType: string; memoryClass: 'project' | 'task'; entityType: string; entityId: string;
    payload: Record<string, unknown>; authority?: number; confidence?: number; sourceType?: string
  }>): Promise<{ acked: string[]; pending: Array<{ eventId: string; error: string }> }> {
    if (specs.length === 0) return { acked: [], pending: [] }
    await this.flushMemoryOutbox(session.projectId, session.taskId)
    const memoryResult = await this.memoryContext(session.projectId)
    const entities: any[] = Array.isArray(memoryResult.context?.entities) ? memoryResult.context.entities : []
    const versions = new Map<string, number>()
    for (const entity of entities) {
      const key = `${entity.memory_class}:${entity.task_id ?? ''}:${entity.entity_type}:${entity.entity_id}`
      versions.set(key, Number(entity.version ?? 0))
    }
    const acked: string[] = []
    const pending: Array<{ eventId: string; error: string }> = []
    for (const spec of specs) {
      const versionKey = `${spec.memoryClass}:${spec.memoryClass === 'task' ? session.taskId : ''}:${spec.entityType}:${spec.entityId}`
      const expectedVersion = versions.get(versionKey) ?? 0
      const event = this.buildMemoryEvent(session, { ...spec, expectedVersion })
      const eventId = String(event.event_id)
      const at = String(event.created_at)
      this.store.enqueueMemory(event, session.projectId, spec.memoryClass === 'task' ? session.taskId : null, at)
      if (!memoryResult.memory) {
        const error = memoryResult.warning ?? 'shared_memory_unconfigured'
        this.store.markMemory(eventId, 'pending', error, at)
        pending.push({ eventId, error })
        continue
      }
      try {
        await memoryResult.memory.publish(event)
        this.store.markMemory(eventId, 'acked', null, nowIso(this.clock))
        versions.set(versionKey, expectedVersion + 1)
        acked.push(eventId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.store.markMemory(eventId, 'pending', message, nowIso(this.clock))
        pending.push({ eventId, error: message })
      }
    }
    return { acked, pending }
  }

  async eventRecord(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = object(inputValue, 'event.record input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const type = eventType(input.eventType ?? input.event_type)
    const level = importance(input.importance)
    const content = typeof input.content === 'string' ? { text: input.content } : object(input.content, 'event content')
    const key = input.idempotencyKey ?? input.idempotency_key
    return this.mutate(`task:${session.taskId}`, async () => this.idempotent(`session:${session.sessionId}`, key, 'event.record', { type, level, content }, async () => {
      const at = nowIso(this.clock)
      const worklog = this.store.recordWorklog({ session, eventType: type, importance: level, content, at })
      let memory = { acked: [] as string[], pending: [] as Array<{ eventId: string; error: string }> }
      const scope = input.scope === 'project' ? 'project' : 'task'
      if (type === 'decision') {
        memory = await this.publishMemorySpecs(session, [{ eventType: 'decision.recorded', memoryClass: scope, entityType: 'decision', entityId: entityId('decision', content), payload: content, authority: 60, sourceType: 'chat' }])
      } else if (type === 'discovery') {
        memory = await this.publishMemorySpecs(session, [{ eventType: 'fact.verified', memoryClass: 'task', entityType: 'discovery', entityId: entityId('discovery', content), payload: content, authority: 40, sourceType: 'task' }])
      } else if (type === 'warning' || type === 'error') {
        memory = await this.publishMemorySpecs(session, [{ eventType: 'pitfall.recorded', memoryClass: 'task', entityType: type, entityId: entityId(type, content), payload: content, authority: 40, sourceType: 'task' }])
      } else if (type === 'user_instruction') {
        memory = await this.publishMemorySpecs(session, [{ eventType: 'constraint.recorded', memoryClass: scope, entityType: 'user_instruction', entityId: entityId('instruction', content), payload: content, authority: 60, sourceType: 'chat' }])
      } else if (type === 'dependency' && ['high', 'critical'].includes(level)) {
        memory = await this.publishMemorySpecs(session, [{ eventType: 'task.progress', memoryClass: 'task', entityType: 'dependency', entityId: entityId('dependency', content), payload: content, authority: 40, sourceType: 'task' }])
      }
      if (type === 'progress' && session.stepId && typeof input.progress === 'number') {
        await this.execution.recordProgress(session.taskId, session.stepId, input.progress, typeof content.text === 'string' ? content.text : null, {
          eventId: `lifecycle-${worklog.worklogId}`
        })
      }
      this.store.touchSession(session.sessionId, at)
      const contextVersion = this.store.bumpContext({ taskId: session.taskId, projectId: session.projectId, type: `event.${type}`, refId: worklog.worklogId, summary: `${type}: ${JSON.stringify(content).slice(0, 500)}`, at })
      return { recorded: true, worklog, memory, contextVersion }
    }))
  }

  private async registerArtifactCore(
    session: AgentLifecycleSession,
    input: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.execution.getTask(session.taskId)
    const rawStorage = object(input.storage, 'artifact storage')
    const providerRaw = String(rawStorage.provider ?? '').trim().toUpperCase().replace(/-/g, '_')
    const provider = providerRaw === 'GOOGLEDRIVE' ? 'GOOGLE_DRIVE' : providerRaw
    const logicalName = text(input.logicalName ?? input.logical_name ?? input.name, 'artifact logicalName', 1024)!
    const workItemId = id(input.workItemId ?? input.work_item_id ?? session.taskId, 'workItemId')
    const stageRunId = id(input.stageRunId ?? input.stage_run_id ?? session.stepId ?? `${session.taskId}:agent`, 'stageRunId')
    const artifact = normalizeWorkflowArtifactRef({
      artifactId: input.artifactId ?? input.artifact_id ?? `artifact-${randomUUID()}`,
      workflowRunId: input.workflowRunId ?? input.workflow_run_id ?? snapshot.definition.task.workflowId ?? session.taskId,
      workItemId, stageRunId, logicalName,
      kind: input.kind ?? input.type ?? 'file', mimeType: input.mimeType ?? input.mime_type,
      storage: {
        provider,
        fileId: rawStorage.fileId ?? rawStorage.file_id,
        path: rawStorage.path, uri: rawStorage.uri, webUrl: rawStorage.webUrl ?? rawStorage.web_url
      },
      sha256: input.sha256, sizeBytes: input.sizeBytes ?? input.size_bytes,
      producer: {
        workerDefinitionId: input.workerDefinitionId ?? input.worker_definition_id ?? session.agentType,
        workerSlotId: input.workerSlotId ?? input.worker_slot_id ?? session.agentId,
        workerSessionId: session.sessionId
      }
    })
    const record = await this.artifacts.register({
      artifact, projectId: session.projectId, taskId: session.taskId,
      agentId: session.agentId, agentType: session.agentType,
      description: input.description ?? null, version: input.version,
      status: input.status ?? 'produced', idempotencyKey
    })
    if (session.stepId) {
      await this.execution.recordArtifact(session.taskId, session.stepId, {
        artifactId: record.artifactId, logicalName: record.logicalName, kind: record.kind,
        storage: record.storage, sha256: record.sha256 ?? null, sizeBytes: record.sizeBytes ?? null,
        agentId: session.agentId, sessionId: session.sessionId
      }, { eventId: `artifact-${record.artifactId}` })
    }
    const memory = await this.publishMemorySpecs(session, [{
      eventType: 'artifact.recorded', memoryClass: 'task', entityType: 'artifact', entityId: record.artifactId,
      payload: {
        artifact_id: record.artifactId, name: record.logicalName, kind: record.kind,
        storage: record.storage, description: record.description, version: record.version, status: record.status,
        source_agent: session.agentId, source_session: session.sessionId, source_task: session.taskId
      }, authority: 40, sourceType: 'artifact'
    }])
    const at = nowIso(this.clock)
    const worklog = this.store.recordWorklog({ session, eventType: 'artifact.register', importance: 'normal', content: { artifactId: record.artifactId, logicalName: record.logicalName, storage: record.storage }, at })
    const contextVersion = this.store.bumpContext({ taskId: session.taskId, projectId: session.projectId, type: 'artifact.register', refId: record.artifactId, summary: `Artifact registered: ${record.logicalName}`, at })
    this.store.touchSession(session.sessionId, at)
    return { artifact: record, worklog, memory, contextVersion }
  }

  async artifactRegister(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = object(inputValue, 'artifact.register input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const key = id(input.idempotencyKey ?? input.idempotency_key, 'idempotencyKey')
    return this.mutate(`task:${session.taskId}`, async () => this.idempotent(`session:${session.sessionId}`, key, 'artifact.register', input, async () =>
      this.registerArtifactCore(session, input, key)
    ))
  }

  async memoryCommit(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = object(inputValue, 'memory.commit input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const semantic: LifecycleMemoryCommitInput = {
      ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
      projectMemory: array(input.projectMemory ?? input.project_memory, 'projectMemory') as any,
      decisions: array(input.decisions, 'decisions') as any,
      discoveries: array(input.discoveries, 'discoveries') as any,
      warnings: array(input.warnings, 'warnings') as any,
      recommendedNextActions: array(input.recommendedNextActions ?? input.recommended_next_actions, 'recommendedNextActions') as any
    }
    const key = input.idempotencyKey ?? input.idempotency_key
    return this.mutate(`task:${session.taskId}`, async () => this.idempotent(`session:${session.sessionId}`, key, 'memory.commit', semantic, async () => {
      const specs: Array<any> = []
      const provenance = { source_agent: session.agentId, source_session: session.sessionId, source_task: session.taskId }
      if (semantic.summary?.trim()) specs.push({
        eventType: 'task.progress', memoryClass: 'task', entityType: 'agent_summary',
        entityId: `summary-${session.sessionId}`, payload: { summary: semantic.summary.trim(), ...provenance }, authority: 40
      })
      for (const item of semantic.projectMemory ?? []) specs.push({
        eventType: 'fact.verified', memoryClass: 'project', entityType: 'project_memory',
        entityId: entityId('project-memory', item), payload: { ...entityContent(item), ...provenance }, authority: 40
      })
      for (const item of semantic.decisions ?? []) {
        const content = entityContent(item)
        const scope = content.scope === 'project' ? 'project' : 'task'
        specs.push({ eventType: 'decision.recorded', memoryClass: scope, entityType: 'decision', entityId: entityId('decision', item), payload: { ...content, ...provenance }, authority: 60 })
      }
      for (const item of semantic.discoveries ?? []) specs.push({
        eventType: 'fact.verified', memoryClass: 'task', entityType: 'discovery',
        entityId: entityId('discovery', item), payload: { ...entityContent(item), ...provenance }, authority: 40
      })
      for (const item of semantic.warnings ?? []) specs.push({
        eventType: 'pitfall.recorded', memoryClass: 'task', entityType: 'warning',
        entityId: entityId('warning', item), payload: { ...entityContent(item), ...provenance }, authority: 40
      })
      if ((semantic.recommendedNextActions ?? []).length > 0) specs.push({
        eventType: 'task.progress', memoryClass: 'task', entityType: 'next_actions',
        entityId: `next-actions-${session.sessionId}`,
        payload: { actions: semantic.recommendedNextActions, ...provenance }, authority: 40
      })
      const result = await this.publishMemorySpecs(session, specs)
      const at = nowIso(this.clock)
      const worklog = this.store.recordWorklog({
        session, eventType: 'memory.commit', importance: result.pending.length ? 'high' : 'normal',
        content: { summary: semantic.summary ?? null, published: result.acked.length, pending: result.pending }, at
      })
      const contextVersion = this.store.bumpContext({
        taskId: session.taskId, projectId: session.projectId, type: 'memory.commit', refId: worklog.worklogId,
        summary: `Memory commit: ${result.acked.length} acked, ${result.pending.length} pending`, at
      })
      return { ...result, worklog, contextVersion }
    }))
  }

  async handoffCreate(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = object(inputValue, 'handoff.create input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const key = input.idempotencyKey ?? input.idempotency_key
    return this.mutate(`task:${session.taskId}`, async () => this.idempotent(`session:${session.sessionId}`, key, 'handoff.create', input, async () => {
      const snapshot = await this.execution.getTask(session.taskId)
      const artifacts = await this.artifacts.list(session.taskId)
      const completedItems = snapshot.runtime.steps.filter((step: any) => step.status === 'completed').map((step: any) => step.stepId)
      const remainingItems = snapshot.runtime.steps.filter((step: any) => !['completed', 'cancelled'].includes(step.status)).map((step: any) => step.stepId)
      const ready = snapshot.runtime.steps.find((step: any) => ['ready', 'fix_required'].includes(step.status))
      const nextDefinition = ready ? snapshot.definition.steps.find((step: any) => step.stepId === ready.stepId) : null
      const worklog = this.store.listWorklog(session.taskId, 100)
      const summary = typeof input.summary === 'string' && input.summary.trim()
        ? input.summary.trim()
        : `${session.agentId} handled ${session.taskId}; ${artifacts.length} artifacts registered and ${worklog.length} worklog events recorded.`
      const handoff = {
        task_id: session.taskId,
        completed_by: session.agentId,
        source_session: session.sessionId,
        summary,
        completed_items: array(input.completedItems ?? input.completed_items, 'completedItems').length ? input.completedItems ?? input.completed_items : completedItems,
        remaining_items: array(input.remainingItems ?? input.remaining_items, 'remainingItems').length ? input.remainingItems ?? input.remaining_items : remainingItems,
        decisions: array(input.decisions, 'decisions'),
        artifacts: artifacts.map(artifact => ({ artifact_id: artifact.artifactId, logical_name: artifact.logicalName, storage: artifact.storage, version: artifact.version })),
        warnings: array(input.warnings, 'warnings'),
        next_action: input.nextAction ?? input.next_action ?? (nextDefinition ? `Continue step ${nextDefinition.stepId}: ${nextDefinition.title}` : null),
        created_at: nowIso(this.clock)
      }
      const memory = await this.publishMemorySpecs(session, [{
        eventType: 'handoff.published', memoryClass: 'task', entityType: 'handoff',
        entityId: `handoff-${session.sessionId}`, payload: handoff, authority: 60, sourceType: 'task'
      }])
      const at = nowIso(this.clock)
      const entry = this.store.recordWorklog({
        session, eventType: 'handoff.create', importance: memory.pending.length ? 'high' : 'normal',
        content: { summary, artifactCount: artifacts.length, memory }, at
      })
      const contextVersion = this.store.bumpContext({
        taskId: session.taskId, projectId: session.projectId, type: 'handoff.create', refId: entry.worklogId,
        summary: `Handoff created by ${session.agentId}`, at
      })
      return { handoff, memory, contextVersion }
    }))
  }

  async taskComplete(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = object(inputValue, 'task.complete input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const key = id(input.idempotencyKey ?? input.idempotency_key, 'idempotencyKey')
    return this.mutate(`task:${session.taskId}`, async () => this.idempotent(`session:${session.sessionId}`, key, 'task.complete', input, async () => {
      const before = await this.execution.getTask(session.taskId)
      const suppliedArtifacts = array(input.artifacts, 'artifacts', 100)
      for (let index = 0; index < suppliedArtifacts.length; index += 1) {
        const raw = object(suppliedArtifacts[index], `artifacts[${index}]`)
        const childKey = `tc-art-${createHash('sha256').update(`${key}:${index}`).digest('hex').slice(0, 32)}`
        await this.registerArtifactCore(session, { ...raw, artifactId: raw.artifactId ?? raw.artifact_id ?? `artifact-${childKey}` }, childKey)
      }
      const artifacts = await this.artifacts.list(session.taskId)
      const warnings: string[] = []
      const currentStep = session.stepId ? before.definition.steps.find((step: any) => step.stepId === session.stepId) : null
      if (currentStep) {
        const required = (currentStep.expectedOutputs ?? []).filter((output: any) => output.required !== false)
        for (const output of required) {
          if (!artifacts.some(artifact => artifact.logicalName === output.logicalName && !['rejected', 'superseded'].includes(artifact.status))) {
            warnings.push(`required artifact is not registered: ${output.logicalName}`)
          }
        }
      }
      const at = nowIso(this.clock)
      const summary = typeof input.summary === 'string' && input.summary.trim()
        ? input.summary.trim()
        : `${session.agentId} completed its current work on ${session.taskId}; ${artifacts.length} artifacts are registered.`
      const completionWorklog = this.store.recordWorklog({
        session, eventType: 'task.complete', importance: warnings.length ? 'high' : 'normal',
        content: { summary, artifactIds: artifacts.map(item => item.artifactId), validationWarnings: warnings }, at
      })

      const memorySpecs: Array<any> = [{
        eventType: 'task.progress', memoryClass: 'task', entityType: 'agent_summary',
        entityId: `summary-${session.sessionId}`, payload: { summary, source_agent: session.agentId, source_session: session.sessionId, source_task: session.taskId }, authority: 40
      }]
      for (const item of array(input.decisions, 'decisions')) {
        const content = entityContent(item as any)
        memorySpecs.push({ eventType: 'decision.recorded', memoryClass: content.scope === 'project' ? 'project' : 'task', entityType: 'decision', entityId: entityId('decision', item as any), payload: { ...content, source_agent: session.agentId, source_session: session.sessionId, source_task: session.taskId }, authority: 60 })
      }
      for (const item of array(input.warnings, 'warnings')) {
        memorySpecs.push({ eventType: 'pitfall.recorded', memoryClass: 'task', entityType: 'warning', entityId: entityId('warning', item as any), payload: { ...entityContent(item as any), source_agent: session.agentId, source_session: session.sessionId, source_task: session.taskId }, authority: 40 })
      }
      const nextActions = array(input.recommendedNextActions ?? input.recommended_next_actions, 'recommendedNextActions')
      if (nextActions.length) memorySpecs.push({
        eventType: 'task.progress', memoryClass: 'task', entityType: 'next_actions', entityId: `next-actions-${session.sessionId}`,
        payload: { actions: nextActions, source_agent: session.agentId, source_session: session.sessionId, source_task: session.taskId }, authority: 40
      })
      const memory = await this.publishMemorySpecs(session, memorySpecs)
      if (memory.pending.length) warnings.push(`memory commit pending: ${memory.pending.length} event(s)`)
      const completedItems = before.runtime.steps.filter((step: any) => step.status === 'completed').map((step: any) => step.stepId)
      const remainingItems = before.runtime.steps.filter((step: any) => !['completed', 'cancelled'].includes(step.status)).map((step: any) => step.stepId)
      const handoff = {
        task_id: session.taskId, completed_by: session.agentId, source_session: session.sessionId,
        summary, completed_items: completedItems, remaining_items: remainingItems,
        decisions: array(input.decisions, 'decisions'),
        artifacts: artifacts.map(item => ({ artifact_id: item.artifactId, logical_name: item.logicalName, storage: item.storage, version: item.version })),
        warnings: [...warnings],
        next_action: nextActions[0] ?? null,
        created_at: nowIso(this.clock)
      }
      const handoffMemory = await this.publishMemorySpecs(session, [{
        eventType: 'handoff.published', memoryClass: 'task', entityType: 'handoff',
        entityId: `handoff-${session.sessionId}`, payload: handoff, authority: 60, sourceType: 'task'
      }])
      if (handoffMemory.pending.length) warnings.push(`handoff memory pending: ${handoffMemory.pending.length} event(s)`)

      let after = before
      if (session.stepId) {
        const stepRuntime = before.runtime.steps.find((step: any) => step.stepId === session.stepId)
        if (stepRuntime && ['dispatching', 'running', 'waiting_report', 'fix_required'].includes(stepRuntime.status)) {
          after = await this.execution.requestCompletion(session.taskId, session.stepId, {
            eventId: `lifecycle-complete-${completionWorklog.worklogId}`,
            payload: { agentId: session.agentId, sessionId: session.sessionId, lifecycleWarnings: warnings }
          })
        }
      }
      this.store.releaseClaim(session.sessionId, 'RELEASED', nowIso(this.clock))
      this.store.touchSession(session.sessionId, nowIso(this.clock), 'WAITING')
      const contextVersion = this.store.bumpContext({
        taskId: session.taskId, projectId: session.projectId, type: 'task.complete', refId: completionWorklog.worklogId,
        summary: warnings.length ? `Completion submitted with ${warnings.length} warning(s)` : 'Completion submitted with structured memory and handoff', at: nowIso(this.clock)
      })
      const state: LifecycleCompletionState = warnings.length ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETION_REQUESTED'
      return { state, taskId: session.taskId, executionTaskStatus: after.runtime.task.status, executionStepStatus: session.stepId ? after.runtime.steps.find((step: any) => step.stepId === session.stepId)?.status ?? null : null, warnings, memory, handoff: { payload: handoff, memory: handoffMemory }, contextVersion }
    }))
  }

  async sessionInterrupt(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = object(inputValue, 'session.interrupt input')
    const session = this.requireSession(input.sessionId ?? input.session_id)
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 4096) : 'agent session interrupted'
    return this.mutate(`task:${session.taskId}`, async () => {
      const before = await this.execution.getTask(session.taskId)
      if (session.bindingId) {
        try { await this.execution.updateSessionState(session.taskId, session.bindingId, 'lost') } catch {}
      }
      if (session.stepId) {
        const current = before.runtime.steps.find((step: any) => step.stepId === session.stepId)
        if (current && ['dispatching', 'running', 'waiting_report', 'fix_required', 'blocked'].includes(current.status)) {
          try { await this.execution.transitionStep(session.taskId, session.stepId, 'failed', reason) } catch {}
          const failed = await this.execution.getTask(session.taskId)
          const latest = failed.runtime.steps.find((step: any) => step.stepId === session.stepId)
          if (latest?.status === 'failed') await this.execution.transitionStep(session.taskId, session.stepId, 'ready', 'session_recovery')
        }
      }
      const at = nowIso(this.clock)
      this.store.releaseClaim(session.sessionId, 'INTERRUPTED', at)
      this.store.touchSession(session.sessionId, at, 'INTERRUPTED')
      const worklog = this.store.recordWorklog({ session: { ...session, state: 'INTERRUPTED', lastActivityAt: at }, eventType: 'session.interrupted', importance: 'high', content: { reason }, at })
      const contextVersion = this.store.bumpContext({ taskId: session.taskId, projectId: session.projectId, type: 'session.interrupted', refId: session.sessionId, summary: reason, at })
      return { interrupted: true, sessionId: session.sessionId, taskId: session.taskId, reason, worklog, contextVersion }
    })
  }

}

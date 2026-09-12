import { createHash } from 'node:crypto'

import type { ExecutionExecutorTarget, ExecutionTaskSnapshot } from '../../execution-runtime/contracts.ts'
import { Zero3AgentLifecycleStore } from './lifecycle-store.ts'
import {
  DEFAULT_AUTONOMOUS_ATTENTION_BUDGET,
  decideAutonomousCandidate,
  evaluateAttentionBudget,
  evaluatePluginCapabilityBaseline,
  guardEventToCandidate,
  routeAutonomousCapabilities,
  type AutonomousAttentionBudget,
  type AutonomousCapabilityProvider,
  type AutonomousGuardEvent
} from './autonomous-orchestrator.ts'

export const ZERO3_AUTONOMOUS_TASK_LOOP = 'zero3.pilot.autonomous-task-loop.v1' as const

const TASK_WORTHY_ENTITY_TYPES = new Set([
  'bug', 'problem', 'blocker', 'dependency', 'error', 'warning',
  'follow_up', 'follow-up', 'work_item', 'work-item', 'task_candidate', 'next_actions'
])
const SEMANTIC_DEDUPE_TYPES = new Set(['problem', 'blocker', 'dependency', 'error', 'warning', 'next_actions'])
const MIN_SEMANTIC_KEY_LENGTH = 6
const SEMANTIC_FINGERPRINT_VERSION = 'zero3.autonomous-task-loop.fingerprint.v1'
const TERMINAL_OR_BLOCKING_TASKS = new Set(['waiting_human', 'blocked', 'outcome_unknown', 'completed', 'cancelled', 'failed'])
const MEANINGFUL_STEP_STATES = new Set(['verifying', 'waiting_human', 'blocked', 'outcome_unknown', 'failed'])
const EXECUTORS = new Set<ExecutionExecutorTarget>([
  'GPT_WEB', 'GEMINI_WEB', 'CODEX', 'CLAUDE', 'ANTIGRAVITY', 'ZERO3', 'REMOTE_COMPUTE', 'HUMAN', 'AUTO'
])

type JsonObject = Record<string, unknown>
type ProjectRecord = { id: string; rootPath?: string | null }

export type AutonomousTaskMemoryPort = {
  getProject(projectId: string): Promise<any>
  publish(event: Record<string, unknown>): Promise<any>
}

export type AutonomousTaskExecutionPort = {
  listTasks(): Promise<ExecutionTaskSnapshot[]>
  getTask(taskId: string): Promise<ExecutionTaskSnapshot>
  createTask(input: Record<string, unknown>): Promise<ExecutionTaskSnapshot>
  refreshSkillPreflight(taskId: string): Promise<unknown>
  reconcileReadiness(taskId: string): Promise<{
    dispatchableStepIds: readonly string[]
    capabilityBlockedStepIds: readonly string[]
    recommendedExecutorByStep: Readonly<Record<string, string>>
  }>
  transitionStep(taskId: string, stepId: string, status: string, reason?: string): Promise<ExecutionTaskSnapshot>
  transitionTask?(taskId: string, status: string, reason?: string): Promise<ExecutionTaskSnapshot>
}

export type AutonomousTaskLifecyclePort = {
  sessionStart(input: Record<string, unknown>): Promise<Record<string, unknown>>
  taskClaim(input: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type AutonomousTaskGptPort = {
  create(projectId?: string | null): Promise<{ id: string; conversationUrl?: string | null }>
  sendWakeup(entryId: string, message: string): Promise<{ sent: true }>
}

export type AutonomousTaskLoopOptions = {
  enabled?: boolean
  autoDispatch?: boolean
  intervalMs?: number
  maxCreatesPerProjectTick?: number
  attentionBudget?: Partial<AutonomousAttentionBudget>
  advertisedPluginCapabilities?: readonly string[]
  clock?: () => Date
}

export type AutonomousAgentDispatchPort = {
  listProviders(): Promise<AutonomousCapabilityProvider[]>
  dispatch(input: { task: ExecutionTaskSnapshot; stepId: string; provider: AutonomousCapabilityProvider }): Promise<{ dispatched: boolean; reason?: string | null }>
}

type Candidate = {
  sourceKey: string
  fingerprint: string
  entityType: string
  entityId: string
  sourceTaskId: string | null
  sourceVersion: number
  detail: JsonObject
  title: string
  goal: string
  executor: ExecutionExecutorTarget
  requiredSkills: string[]
  optionalSkills: string[]
  semanticDedupe: boolean
}

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as JsonObject).sort().map(key => [key, stable((value as JsonObject)[key])]))
  }
  return value
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function stableUuid(seed: string): string {
  const raw = hash(seed).slice(0, 32).split('')
  raw[12] = '4'
  raw[16] = ['8', '9', 'a', 'b'][parseInt(raw[16]!, 16) % 4]!
  const hex = raw.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function nowIso(clock: () => Date): string { return clock().toISOString() }

function compactText(value: unknown, fallback: string, max = 4000): string {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, max)
  return fallback.slice(0, max)
}

function listOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 32)
}

// Semantic identity must ignore volatile agent/session bookkeeping and only keep the
// human-readable problem statement, so different Agents reporting the same issue collapse
// into one Task instead of one Task per reporting Agent.
function semanticText(detail: JsonObject): string {
  const raw = detail.problem ?? detail.title ?? detail.summary ?? detail.message ?? detail.text
    ?? detail.description ?? detail.action ?? detail.objective ?? detail.goal
  return typeof raw === 'string' ? raw : ''
}

function normalizeSemanticText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

// Short or empty statements are never used for cross-source merging: they are too likely to
// collide with an unrelated problem.
function semanticKey(detail: JsonObject): string | null {
  const normalized = normalizeSemanticText(semanticText(detail))
  return normalized.length >= MIN_SEMANTIC_KEY_LENGTH ? normalized : null
}

function executor(value: unknown): ExecutionExecutorTarget {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return EXECUTORS.has(normalized as ExecutionExecutorTarget) ? normalized as ExecutionExecutorTarget : 'AUTO'
}

function candidatePayload(value: unknown): JsonObject {
  if (typeof value === 'string') return { text: value.trim() }
  return record(value)
}

function isLoopOrigin(entity: JsonObject, content: JsonObject): boolean {
  const source = record(entity.source)
  return entity.entity_type === 'task_outcome'
    || content.origin === ZERO3_AUTONOMOUS_TASK_LOOP
    || content.source_origin === ZERO3_AUTONOMOUS_TASK_LOOP
    || source.type === 'system' && content.origin === ZERO3_AUTONOMOUS_TASK_LOOP
    || source.type === 'system' && typeof source.ref === 'string' && source.ref.startsWith('auto-task-')
}

function candidateTitle(entityType: string, detail: JsonObject): string {
  const raw = detail.title ?? detail.message ?? detail.problem ?? detail.summary ?? detail.text
  const text = compactText(raw, `处理 ${entityType}`, 120)
  return text.length > 4 ? text : `处理 ${entityType}: ${text}`
}

function candidateGoal(entityType: string, detail: JsonObject): string {
  const raw = detail.goal ?? detail.objective ?? detail.description ?? detail.message ?? detail.problem ?? detail.summary ?? detail.text
  const fallback = `处理共享记忆中记录的 ${entityType}：${JSON.stringify(detail)}`
  return compactText(raw, fallback, 4000)
}

function classifyEntity(projectId: string, value: unknown): Candidate[] {
  const entity = record(value)
  const entityType = typeof entity.entity_type === 'string' ? entity.entity_type.trim().toLowerCase() : ''
  if (!TASK_WORTHY_ENTITY_TYPES.has(entityType)) return []
  const content = record(entity.content)
  if (isLoopOrigin(entity, content)) return []
  const sourceTaskId = typeof entity.task_id === 'string' && entity.task_id.trim() ? entity.task_id.trim() : null
  const sourceVersion = Number.isSafeInteger(Number(entity.version)) && Number(entity.version) >= 0
    ? Number(entity.version)
    : Number.isSafeInteger(Number(entity.updated_sequence)) && Number(entity.updated_sequence) >= 0 ? Number(entity.updated_sequence) : 0
  // A missing entity id must not fall back to a content-sensitive identity, otherwise an
  // ordinary detail update would look like a brand new problem and create a second Task.
  const fallbackEntityId = hash({ entityType, semantic: normalizeSemanticText(semanticText(content)) || stable(content) }).slice(0, 32)
  const entityId = compactText(entity.entity_id, fallbackEntityId, 512)
  const rawItems = entityType === 'next_actions'
    ? (Array.isArray(content.actions) ? content.actions : Array.isArray(content.recommended_next_actions) ? content.recommended_next_actions : [])
    : [content]
  return rawItems.map(item => {
    const detail = candidatePayload(item)
    if (Object.keys(detail).length === 0) return null
    const semantic = semanticKey(detail)
    const semanticDedupe = semantic !== null && SEMANTIC_DEDUPE_TYPES.has(entityType)
    const fingerprint = semanticDedupe
      ? hash({ version: SEMANTIC_FINGERPRINT_VERSION, kind: 'semantic', entityType, semantic })
      : hash({ version: SEMANTIC_FINGERPRINT_VERSION, kind: 'detail', entityType, detail })
    const identity = `${projectId}|entity|${entityType}|${entityId}|${entityType === 'next_actions' ? `item:${fingerprint}` : ''}`
    return {
      sourceKey: `ati-${hash(identity).slice(0, 48)}`,
      fingerprint,
      entityType,
      entityId,
      sourceTaskId,
      sourceVersion,
      detail,
      title: candidateTitle(entityType, detail),
      goal: candidateGoal(entityType, detail),
      executor: executor(detail.executor ?? detail.target),
      requiredSkills: listOfStrings(detail.requiredSkills ?? detail.required_skills ?? detail.skillSelectors ?? detail.skill_selectors),
      optionalSkills: listOfStrings(detail.optionalSkills ?? detail.optional_skills),
      semanticDedupe
    } satisfies Candidate
  }).filter((item): item is Candidate => Boolean(item))
}

function outcomeState(snapshot: ExecutionTaskSnapshot): { state: string; stepId: string | null } | null {
  if (TERMINAL_OR_BLOCKING_TASKS.has(snapshot.runtime.task.status)) return { state: snapshot.runtime.task.status, stepId: null }
  const step = snapshot.runtime.steps.find(item => MEANINGFUL_STEP_STATES.has(item.status))
  return step ? { state: step.status, stepId: step.stepId } : null
}

function taskIdFor(sourceKey: string): string { return `auto-task-${hash(sourceKey).slice(0, 32)}` }
function dispatchKeyFor(taskId: string, stepId: string, attempt: number): string {
  return `adi-${hash(`${taskId}:${stepId}:${attempt}`).slice(0, 48)}`
}

function bootstrapPrompt(snapshot: ExecutionTaskSnapshot, stepId: string): string {
  const task = snapshot.definition.task
  const step = snapshot.definition.steps.find(item => item.stepId === stepId)
  return [
    '[Zero3 Autonomous Task]',
    `Task ID: ${task.taskId}`,
    `Goal: ${task.goal}`,
    `Current step: ${step?.title ?? stepId}`,
    `Objective: ${step?.objective ?? task.goal}`,
    'This task already exists in Zero3. Do not create a duplicate task.',
    'Use the Zero3 Agent Lifecycle calls for context.resolve, progress/events, artifact registration, memory.commit and task.complete.',
    'Record any newly discovered blocker/follow-up as structured lifecycle memory so Zero3 can schedule it separately.'
  ].join('\n')
}

export class Zero3AutonomousTaskLoop {
  private readonly clock: () => Date
  private readonly intervalMs: number
  private readonly maxCreates: number
  private readonly attentionBudget: AutonomousAttentionBudget
  private readonly projectTails = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private lastError: string | null = null

  constructor(
    readonly store: Zero3AgentLifecycleStore,
    readonly ports: {
      projects: { list(): Promise<ProjectRecord[]> }
      memoryForProject(projectId: string): Promise<AutonomousTaskMemoryPort | null>
      execution: AutonomousTaskExecutionPort
      lifecycle: AutonomousTaskLifecyclePort
      gpt: AutonomousTaskGptPort
      agentDispatch?: AutonomousAgentDispatchPort
    },
    readonly options: AutonomousTaskLoopOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.intervalMs = Math.max(5_000, Math.min(options.intervalMs ?? 30_000, 300_000))
    this.maxCreates = Math.max(1, Math.min(options.maxCreatesPerProjectTick ?? 20, 100))
    this.attentionBudget = { ...DEFAULT_AUTONOMOUS_ATTENTION_BUDGET, ...(options.attentionBudget ?? {}) }
  }

  start(): void {
    if (this.timer || this.options.enabled !== true) return
    this.timer = setInterval(() => void this.tick().catch(error => this.noteError(error)), this.intervalMs)
    this.timer.unref?.()
    void this.tick().catch(error => this.noteError(error))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status(): { enabled: boolean; autoDispatch: boolean; ticking: boolean; intervalMs: number; lastError: string | null; pluginBaseline: ReturnType<typeof evaluatePluginCapabilityBaseline> } {
    return {
      enabled: this.options.enabled === true,
      autoDispatch: this.options.autoDispatch === true,
      ticking: this.ticking,
      intervalMs: this.intervalMs,
      lastError: this.lastError,
      pluginBaseline: evaluatePluginCapabilityBaseline(this.options.advertisedPluginCapabilities ?? [])
    }
  }

  // An unattended loop must never reject: an unhandled rejection in the Electron main process
  // would take the whole desktop app down. Failures are remembered and retried on the next tick.
  private noteError(error: unknown): void {
    this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 512)
  }

  async tick(): Promise<void> {
    if (this.options.enabled !== true || this.ticking) return
    this.ticking = true
    try {
      let projects: ProjectRecord[]
      try { projects = await this.ports.projects.list() } catch (error) { this.noteError(error); return }
      for (const project of projects) {
        try { await this.enqueueProject(project) } catch (error) { this.noteError(error) }
      }
    } finally {
      this.ticking = false
    }
  }

  async reconcileProjectNow(projectId: string): Promise<void> {
    const project = (await this.ports.projects.list()).find(item => item.id === projectId)
    if (!project) throw new Error(`autonomous project not found: ${projectId}`)
    await this.enqueueProject(project)
  }

  async ingestGuardEvent(event: AutonomousGuardEvent): Promise<void> {
    const project = (await this.ports.projects.list()).find(item => item.id === event.projectId)
    if (!project) throw new Error(`autonomous project not found: ${event.projectId}`)
    const guard = guardEventToCandidate(event)
    const detail: JsonObject = { ...guard.detail, source_refs: guard.sourceRefs }
    const semantic = semanticKey(detail)
    const semanticDedupe = semantic !== null && SEMANTIC_DEDUPE_TYPES.has(guard.entityType)
    const fingerprint = semanticDedupe
      ? hash({ version: SEMANTIC_FINGERPRINT_VERSION, kind: 'semantic', entityType: guard.entityType, semantic })
      : hash({ version: SEMANTIC_FINGERPRINT_VERSION, kind: 'guard', entityType: guard.entityType, eventRef: event.eventRef, detail })
    const candidate: Candidate = {
      sourceKey: `ati-guard-${hash(`${event.projectId}|${event.eventRef}`).slice(0, 42)}`,
      fingerprint,
      entityType: guard.entityType,
      entityId: event.eventRef.slice(0, 512),
      sourceTaskId: guard.sourceTaskId,
      sourceVersion: 1,
      detail,
      title: candidateTitle(guard.entityType, detail),
      goal: candidateGoal(guard.entityType, detail),
      executor: executor(detail.executor ?? detail.target),
      requiredSkills: listOfStrings(detail.requiredSkills ?? detail.required_skills),
      optionalSkills: listOfStrings(detail.optionalSkills ?? detail.optional_skills),
      semanticDedupe
    }
    await this.ingest(project, candidate)
    await this.enqueueProject(project)
  }

  private enqueueProject(project: ProjectRecord): Promise<void> {
    const previous = this.projectTails.get(project.id) ?? Promise.resolve()
    const current = previous.then(() => this.reconcileProject(project)).catch(error => { this.noteError(error) })
    this.projectTails.set(project.id, current)
    void current.finally(() => { if (this.projectTails.get(project.id) === current) this.projectTails.delete(project.id) })
    return current
  }

  private async reconcileProject(project: ProjectRecord): Promise<void> {
    let memory: AutonomousTaskMemoryPort | null = null
    try { memory = await this.ports.memoryForProject(project.id) } catch { return }
    if (!memory) return
    await this.flushPendingMemory(project.id, memory)
    let context: any
    try { context = await memory.getProject(project.id) } catch { return }
    const entities = Array.isArray(context?.entities) ? context.entities : []
    let created = 0
    for (const entity of entities) {
      for (const candidate of classifyEntity(project.id, entity)) {
        if (created >= this.maxCreates) break
        try {
          if (await this.ingest(project, candidate)) created += 1
        } catch (error) {
          this.noteError(error)
        }
      }
      if (created >= this.maxCreates) break
    }
    // Archived tasks are deliberately excluded: archiving is the operator's signal that this
    // work should stop being scheduled, without destroying its audit trail.
    const tasks = (await this.ports.execution.listTasks()).filter(snapshot =>
      snapshot.archived !== true
      && snapshot.definition.task.projectId === project.id
      && snapshot.definition.task.metadata?.autonomousTaskLoop === ZERO3_AUTONOMOUS_TASK_LOOP
    )
    for (const snapshot of tasks) {
      const taskId = snapshot.definition.task.taskId
      try {
        await this.reconcileTask(snapshot)
        const latest = await this.ports.execution.getTask(taskId)
        await this.reconcileParentResume(latest)
        await this.publishOutcome(memory, context, latest)
      } catch (error) {
        this.noteError(error)
      }
    }
  }

  private async ingest(project: ProjectRecord, candidate: Candidate): Promise<boolean> {
    const at = nowIso(this.clock)
    const existing = this.store.getAutonomousIntake(candidate.sourceKey)
    if (existing && candidate.sourceVersion < existing.sourceVersion) return false

    const decision = decideAutonomousCandidate({ entityType: candidate.entityType, detail: candidate.detail, sourceTaskId: candidate.sourceTaskId })
    const tasks = await this.ports.execution.listTasks()
    let parent: ExecutionTaskSnapshot | null = null
    if (candidate.sourceTaskId) {
      try { parent = await this.ports.execution.getTask(candidate.sourceTaskId) } catch {}
    }
    const parentMeta = record(parent?.definition.task.metadata)
    const parentAuto = record(parentMeta.autonomousLineage)
    const detailRoot = typeof candidate.detail.rootTaskId === 'string' ? candidate.detail.rootTaskId
      : typeof candidate.detail.root_task_id === 'string' ? candidate.detail.root_task_id : null
    const detailParent = typeof candidate.detail.parentTaskId === 'string' ? candidate.detail.parentTaskId
      : typeof candidate.detail.parent_task_id === 'string' ? candidate.detail.parent_task_id : null
    const rootTaskId = detailRoot ?? (typeof parentAuto.rootTaskId === 'string' ? parentAuto.rootTaskId : candidate.sourceTaskId)
    const parentTaskId = detailParent ?? candidate.sourceTaskId
    const requestedParentStep = typeof candidate.detail.parentStepId === 'string' ? candidate.detail.parentStepId
      : typeof candidate.detail.parent_step_id === 'string' ? candidate.detail.parent_step_id : null
    const parentStep = parent?.runtime.steps.find(step => step.stepId === requestedParentStep)
      ?? parent?.runtime.steps.find(step => ['running','dispatching','waiting_report','verifying','fix_required','ready','blocked','waiting_human'].includes(step.status))
      ?? null
    const parentDepth = Number.isSafeInteger(Number(parentAuto.childDepth)) ? Number(parentAuto.childDepth) : 0
    const childDepth = parentTaskId ? parentDepth + 1 : 0
    const sourceRefs = [...new Set([
      ...listOfStrings(candidate.detail.sourceRefs ?? candidate.detail.source_refs),
      `memory://${candidate.entityType}/${candidate.entityId}`
    ])]
    const governedFingerprint = candidate.semanticDedupe
      ? hash({ base: candidate.fingerprint, category: decision.category, resources: [...decision.affectedResources].sort(), rootTaskId })
      : candidate.fingerprint
    const linked = existing?.taskId ? null : candidate.semanticDedupe
      ? this.store.findAutonomousIntakeByFingerprint(project.id, candidate.entityType, governedFingerprint)
        ?? this.store.findAutonomousIntakeByFingerprint(project.id, candidate.entityType, candidate.fingerprint)
      : null
    const semanticTaskId = linked ? linked.taskId ?? taskIdFor(linked.sourceKey) : null
    let disposition = decision.disposition
    let humanAttentionReason: string | null = null
    const activeAutoTasks = tasks.filter(snapshot => snapshot.definition.task.metadata?.autonomousTaskLoop === ZERO3_AUTONOMOUS_TASK_LOOP
      && !['completed','cancelled','failed'].includes(snapshot.runtime.task.status))
    const spawnedForRoot = tasks.filter(snapshot => snapshot.definition.task.metadata?.autonomousTaskLoop === ZERO3_AUTONOMOUS_TASK_LOOP
      && record(snapshot.definition.task.metadata?.autonomousLineage).rootTaskId === rootTaskId).length
    const autonomousSessions = activeAutoTasks.reduce((count, snapshot) => count + snapshot.runtime.sessionBindings.filter(binding => !['closed','lost'].includes(binding.state)).length, 0)
    const budget = evaluateAttentionBudget({ childDepth, parallelAutoTasks: activeAutoTasks.length, spawnedForRoot, retries: 0, autonomousSessions }, this.attentionBudget)
    if ((disposition === 'PARALLEL' || disposition === 'INTERRUPT') && !budget.allowed) {
      disposition = 'DEFER'
      humanAttentionReason = `Autonomous attention budget prevented task creation: ${budget.reason}`
    }
    const taskId = existing?.taskId ?? semanticTaskId ?? null
    this.store.upsertAutonomousIntake({
      sourceKey: candidate.sourceKey, projectId: project.id, entityType: candidate.entityType, entityId: candidate.entityId,
      sourceTaskId: candidate.sourceTaskId, sourceVersion: candidate.sourceVersion, fingerprint: governedFingerprint, taskId,
      detail: candidate.detail, category: decision.category, severity: decision.severity, confidence: decision.confidence,
      affectedResources: decision.affectedResources, mainlineImpact: decision.mainlineImpact, disposition,
      decisionReason: decision.decisionReason, rootTaskId, parentTaskId, attentionCost: decision.attentionCost, sourceRefs,
      humanAttentionReason, at
    })
    if (disposition !== 'PARALLEL' && disposition !== 'INTERRUPT') return false
    const resolvedTaskId = taskId ?? taskIdFor(linked?.sourceKey ?? candidate.sourceKey)
    let snapshot: ExecutionTaskSnapshot | null = null
    try { snapshot = await this.ports.execution.getTask(resolvedTaskId) } catch {}
    if (snapshot) {
      if (!existing?.taskId) this.store.bindAutonomousTask(candidate.sourceKey, resolvedTaskId, at)
      return false
    }
    const completionGate = listOfStrings(candidate.detail.completionGate ?? candidate.detail.completion_gate)
    snapshot = await this.ports.execution.createTask({
      task: {
        taskId: resolvedTaskId, projectId: project.id, workspace: project.rootPath?.trim() || null,
        title: candidate.title, goal: candidate.goal, workflowId: 'autonomous-task-loop', maxParallelSteps: 1,
        createdBySessionId: null,
        metadata: {
          autonomous: true, autonomousTaskLoop: ZERO3_AUTONOMOUS_TASK_LOOP, sourceKey: candidate.sourceKey,
          sourceEntityType: candidate.entityType, sourceEntityId: candidate.entityId, sourceTaskId: candidate.sourceTaskId,
          sourceVersion: candidate.sourceVersion, sourceFingerprint: governedFingerprint,
          autonomousLineage: {
            rootTaskId, parentTaskId, parentStepId: parentStep?.stepId ?? requestedParentStep,
            sourceCandidateId: candidate.sourceKey, sourceEventRefs: sourceRefs,
            creationReason: disposition, resumeParentOnComplete: Boolean(parentTaskId), childDepth
          }
        }
      },
      steps: [{
        stepId: 'auto-work', title: candidate.title, objective: candidate.goal, executor: candidate.executor, dependsOn: [],
        requiredSkills: candidate.requiredSkills, optionalSkills: candidate.optionalSkills, inputArtifacts: [], expectedOutputs: [],
        completionGate: completionGate.length ? completionGate : ['human_review'], maxAttempts: Math.min(this.attentionBudget.maxRetries, 3),
        metadata: { autonomousTaskLoop: ZERO3_AUTONOMOUS_TASK_LOOP, sourceKey: candidate.sourceKey, rootTaskId, parentTaskId }
      }]
    })
    this.store.bindAutonomousTask(candidate.sourceKey, resolvedTaskId, at)
    if (disposition === 'INTERRUPT' && parent && parentStep) {
      if (parentStep.status !== 'blocked') await this.ports.execution.transitionStep(parent.definition.task.taskId, parentStep.stepId, 'blocked', `Autonomous blocking issue: ${candidate.title}`)
      const parentStatus = parent.runtime.task.status
      if (this.ports.execution.transitionTask && ['ready','running','waiting_human'].includes(parentStatus)) {
        await this.ports.execution.transitionTask(parent.definition.task.taskId, 'blocked', `Autonomous blocking issue: ${candidate.title}`)
      }
    }
    return true
  }

  private markTaskHumanAttention(taskId: string, reason: string): void {
    for (const intake of this.store.listAutonomousIntakes().filter(item => item.taskId === taskId && !item.resolvedAt)) {
      this.store.setAutonomousHumanAttention(intake.sourceKey, reason, nowIso(this.clock))
    }
  }

  private async reconcileTask(initial: ExecutionTaskSnapshot): Promise<void> {
    const taskId = initial.definition.task.taskId
    await this.resumeWakeup(initial)
    if (['completed', 'cancelled', 'failed'].includes(initial.runtime.task.status)) return
    try { await this.ports.execution.refreshSkillPreflight(taskId) } catch {}
    const plan = await this.ports.execution.reconcileReadiness(taskId)
    if (this.options.autoDispatch !== true) return
    let snapshot = await this.ports.execution.getTask(taskId)
    for (const stepId of plan.dispatchableStepIds) {
      const step = snapshot.definition.steps.find(item => item.stepId === stepId)
      const runtime = snapshot.runtime.steps.find(item => item.stepId === stepId)
      if (!step || !runtime || runtime.assignmentId) continue
      const target = step.executor === 'AUTO'
        ? runtime.skillPreflight?.executor ?? (plan.recommendedExecutorByStep[stepId] as ExecutionExecutorTarget | undefined) ?? null
        : step.executor
      if (!target) {
        this.markTaskHumanAttention(taskId, 'Autonomous routing produced no safe executor; manual assignment required.')
        await this.ports.execution.transitionStep(taskId, stepId, 'waiting_human', 'Autonomous routing produced no safe executor; manual assignment required.')
        continue
      }
      if (target !== 'GPT_WEB') {
        const baseline = evaluatePluginCapabilityBaseline(this.options.advertisedPluginCapabilities ?? [])
        if (!baseline.ready || !this.ports.agentDispatch) {
          const reason = `Post-plugin capability gate is not ready for ${target}; missing: ${baseline.missing.join(', ') || 'agent dispatch adapter'}.`
          this.markTaskHumanAttention(taskId, reason)
          await this.ports.execution.transitionStep(taskId, stepId, 'waiting_human', reason)
          continue
        }
        const stepMetadata = record(step.metadata)
        const requiredCapabilities = listOfStrings(stepMetadata.requiredCapabilities ?? stepMetadata.required_capabilities)
        const providers = (await this.ports.agentDispatch.listProviders()).filter(provider => provider.executor === target)
        const route = routeAutonomousCapabilities(requiredCapabilities, providers)
        if (route.state !== 'READY' || !route.provider) {
          this.markTaskHumanAttention(taskId, route.reason)
          await this.ports.execution.transitionStep(taskId, stepId, 'waiting_human', route.reason)
          continue
        }
        const dispatched = await this.ports.agentDispatch.dispatch({ task: snapshot, stepId, provider: route.provider })
        if (!dispatched.dispatched) {
          const reason = dispatched.reason ?? 'Autonomous agent dispatch failed closed.'
          this.markTaskHumanAttention(taskId, reason)
          await this.ports.execution.transitionStep(taskId, stepId, 'waiting_human', reason)
          continue
        }
        const observed = await this.ports.execution.getTask(taskId)
        if (!observed.runtime.steps.find(item => item.stepId === stepId)?.assignmentId) {
          this.markTaskHumanAttention(taskId, 'Agent dispatch returned without an authoritative Execution Assignment.')
          await this.ports.execution.transitionStep(taskId, stepId, 'waiting_human', 'Agent dispatch returned without an authoritative Execution Assignment.')
        }
        snapshot = await this.ports.execution.getTask(taskId)
        continue
      }
      await this.launchGpt(snapshot, stepId, runtime.attempt + 1)
      snapshot = await this.ports.execution.getTask(taskId)
    }
  }

  private async reconcileParentResume(snapshot: ExecutionTaskSnapshot): Promise<void> {
    if (snapshot.runtime.task.status !== 'completed') return
    const lineage = record(snapshot.definition.task.metadata?.autonomousLineage)
    if (lineage.resumeParentOnComplete !== true || typeof lineage.parentTaskId !== 'string') return
    const childTaskId = snapshot.definition.task.taskId
    const parentTaskId = lineage.parentTaskId
    const parentStepId = typeof lineage.parentStepId === 'string' ? lineage.parentStepId : null
    const receipt = this.store.putParentResumeReceipt({ childTaskId, parentTaskId, parentStepId, at: nowIso(this.clock) })
    if (receipt.state === 'RESUMED') return
    const sourceIntakes = this.store.listAutonomousIntakes(snapshot.definition.task.projectId ?? undefined).filter(item => item.taskId === childTaskId)
    const requireHuman = (reason: string) => {
      for (const intake of sourceIntakes) this.store.setAutonomousHumanAttention(intake.sourceKey, reason, nowIso(this.clock))
      this.store.updateParentResumeReceipt(childTaskId, 'WAITING_HUMAN', reason, nowIso(this.clock))
    }
    let parent: ExecutionTaskSnapshot
    try { parent = await this.ports.execution.getTask(parentTaskId) }
    catch {
      requireHuman('Parent task is not available for autonomous resume.')
      return
    }
    if (['completed','cancelled','outcome_unknown'].includes(parent.runtime.task.status)) {
      requireHuman(`Parent task is ${parent.runtime.task.status}; automatic resume is unsafe.`)
      return
    }
    const parentStep = parentStepId ? parent.runtime.steps.find(step => step.stepId === parentStepId) : null
    if (parentStep && parentStep.status === 'outcome_unknown') {
      requireHuman('Parent step outcome is unknown; automatic resume is unsafe.')
      return
    }
    if (parentStep && ['blocked','waiting_human','failed'].includes(parentStep.status)) {
      await this.ports.execution.transitionStep(parentTaskId, parentStep.stepId, 'ready', `Autonomous repair ${childTaskId} completed.`)
    }
    const refreshedParent = await this.ports.execution.getTask(parentTaskId)
    if (['blocked','waiting_human','failed'].includes(refreshedParent.runtime.task.status)) {
      if (!this.ports.execution.transitionTask) {
        requireHuman('Execution Task transition API is unavailable for parent resume.')
        return
      }
      await this.ports.execution.transitionTask(parentTaskId, 'ready', `Autonomous repair ${childTaskId} completed.`)
    }
    await this.ports.execution.reconcileReadiness(parentTaskId)
    for (const intake of sourceIntakes) {
      if (!intake.resolvedAt) this.store.markAutonomousIntakeResolved(intake.sourceKey, nowIso(this.clock))
      this.store.setAutonomousHumanAttention(intake.sourceKey, null, nowIso(this.clock))
    }
    this.store.updateParentResumeReceipt(childTaskId, 'RESUMED', null, nowIso(this.clock))
  }

  private async resumeWakeup(snapshot: ExecutionTaskSnapshot): Promise<void> {
    if (this.options.autoDispatch !== true) return
    for (const runtime of snapshot.runtime.steps) {
      if (!runtime.assignmentId || runtime.attempt < 1) continue
      const key = dispatchKeyFor(snapshot.definition.task.taskId, runtime.stepId, runtime.attempt)
      const dispatch = this.store.getAutonomousDispatch(key)
      if (!dispatch?.sessionId || !['SESSION_CREATED', 'CLAIMED'].includes(dispatch.state)) continue
      if (dispatch.state === 'SESSION_CREATED') {
        await this.resumeClaim(snapshot, runtime.stepId, dispatch.dispatchKey, dispatch.sessionId)
      }
      const latest = this.store.getAutonomousDispatch(key)
      if (latest?.state === 'CLAIMED' && latest.sessionId) await this.sendWakeup(snapshot, runtime.stepId, latest.dispatchKey, latest.sessionId)
    }
  }

  private async launchGpt(snapshot: ExecutionTaskSnapshot, stepId: string, attempt: number): Promise<void> {
    const task = snapshot.definition.task
    if (!task.projectId) {
      await this.ports.execution.transitionStep(task.taskId, stepId, 'waiting_human', 'Autonomous GPT launch requires a project-scoped task.')
      return
    }
    const key = dispatchKeyFor(task.taskId, stepId, attempt)
    const prior = this.store.getAutonomousDispatch(key)
    if (prior?.state === 'WAKEUP_SENT') return
    if (prior?.state === 'RESERVED' && !prior.sessionId) {
      this.store.updateAutonomousDispatch(key, { state: 'ABORTED', lastError: 'launch outcome unknown before session id was persisted', at: nowIso(this.clock) })
      await this.ports.execution.transitionStep(task.taskId, stepId, 'waiting_human', 'Autonomous GPT launch outcome is unknown; refusing a duplicate session launch.')
      return
    }
    let dispatch = prior ?? this.store.reserveAutonomousDispatch({ dispatchKey: key, projectId: task.projectId, taskId: task.taskId, stepId, attempt, at: nowIso(this.clock) })
    if (!dispatch.sessionId) {
      try {
        const created = await this.ports.gpt.create(task.projectId)
        dispatch = this.store.updateAutonomousDispatch(key, { state: 'SESSION_CREATED', sessionId: created.id, at: nowIso(this.clock) })
      } catch (error) {
        this.store.updateAutonomousDispatch(key, { state: 'ABORTED', lastError: error instanceof Error ? error.message : String(error), at: nowIso(this.clock) })
        await this.ports.execution.transitionStep(task.taskId, stepId, 'waiting_human', 'Autonomous GPT session creation failed; manual retry required.')
        return
      }
    }
    await this.resumeClaim(snapshot, stepId, key, dispatch.sessionId!)
    const claimed = this.store.getAutonomousDispatch(key)
    if (claimed?.state === 'CLAIMED' && claimed.sessionId) await this.sendWakeup(snapshot, stepId, key, claimed.sessionId)
  }

  private async resumeClaim(snapshot: ExecutionTaskSnapshot, stepId: string, key: string, sessionId: string): Promise<void> {
    const projectId = snapshot.definition.task.projectId!
    const suffix = hash(key).slice(0, 32)
    try {
      await this.ports.lifecycle.sessionStart({
        sessionId, projectId, taskId: snapshot.definition.task.taskId, agentType: 'web_gpt',
        idempotencyKey: `auto-start-${suffix}`
      })
      const claim = await this.ports.lifecycle.taskClaim({
        sessionId, taskId: snapshot.definition.task.taskId,
        idempotencyKey: `auto-claim-${suffix}`
      })
      if (claim.state !== 'CLAIMED') throw new Error(`agent lifecycle claim returned ${String(claim.state ?? 'unknown')}`)
      this.store.updateAutonomousDispatch(key, { state: 'CLAIMED', sessionId, at: nowIso(this.clock) })
    } catch (error) {
      this.store.updateAutonomousDispatch(key, { state: 'ABORTED', sessionId, lastError: error instanceof Error ? error.message : String(error), at: nowIso(this.clock) })
      const latest = await this.ports.execution.getTask(snapshot.definition.task.taskId)
      const runtime = latest.runtime.steps.find(item => item.stepId === stepId)
      if (runtime?.status === 'ready') {
        await this.ports.execution.transitionStep(snapshot.definition.task.taskId, stepId, 'waiting_human', 'Autonomous GPT claim failed; manual recovery required.')
      }
    }
  }

  private async sendWakeup(snapshot: ExecutionTaskSnapshot, stepId: string, key: string, sessionId: string): Promise<void> {
    try {
      await this.ports.gpt.sendWakeup(sessionId, bootstrapPrompt(snapshot, stepId))
      this.store.updateAutonomousDispatch(key, { state: 'WAKEUP_SENT', sessionId, at: nowIso(this.clock) })
    } catch (error) {
      this.store.updateAutonomousDispatch(key, { state: 'CLAIMED', sessionId, lastError: error instanceof Error ? error.message : String(error), at: nowIso(this.clock) })
    }
  }

  private async flushPendingMemory(projectId: string, memory: AutonomousTaskMemoryPort): Promise<void> {
    for (const pending of this.store.memoryOutboxPending()) {
      if (record(pending.event.scope).project_id !== projectId) continue
      try {
        await memory.publish(pending.event)
        this.store.markMemory(pending.eventId, 'acked', null, nowIso(this.clock))
      } catch (error) {
        this.store.markMemory(pending.eventId, 'pending', error instanceof Error ? error.message : String(error), nowIso(this.clock))
        break
      }
    }
  }

  private async publishOutcome(memory: AutonomousTaskMemoryPort, context: any, snapshot: ExecutionTaskSnapshot): Promise<void> {
    const outcome = outcomeState(snapshot)
    const projectId = snapshot.definition.task.projectId
    if (!outcome || !projectId) return
    const taskId = snapshot.definition.task.taskId
    const semanticOutcome = {
      state: outcome.state,
      stepId: outcome.stepId,
      taskStatus: snapshot.runtime.task.status,
      progress: snapshot.runtime.task.progress,
      blockers: snapshot.runtime.task.blockers,
      steps: snapshot.runtime.steps.map(step => ({ stepId: step.stepId, status: step.status, blocker: step.blocker }))
    }
    const publicationKey = `${taskId}:${hash(semanticOutcome)}`
    const eventId = stableUuid(`outcome:${publicationKey}`)
    const existing = this.store.memoryOutboxEntry(eventId)
    if (existing?.state === 'acked') return
    if (existing?.state === 'pending') {
      try {
        await memory.publish(existing.event)
        this.store.markMemory(eventId, 'acked', null, nowIso(this.clock))
      } catch (error) {
        this.store.markMemory(eventId, 'pending', error instanceof Error ? error.message : String(error), nowIso(this.clock))
      }
      return
    }
    const entityId = `auto-outcome-${hash(taskId).slice(0, 32)}`
    const entities = Array.isArray(context?.entities) ? context.entities : []
    const current = entities.find((entity: any) =>
      entity?.memory_class === 'task' && entity?.task_id === taskId
      && entity?.entity_type === 'task_outcome' && entity?.entity_id === entityId
    )
    const expectedVersion = Number.isSafeInteger(Number(current?.version)) ? Number(current.version) : 0
    const eventType = outcome.state === 'completed' ? 'task.completed'
      : outcome.state === 'failed' ? 'task.failed'
        : ['blocked', 'waiting_human', 'outcome_unknown'].includes(outcome.state) ? 'task.blocked' : 'task.progress'
    const event = {
      schema: 'zero3.memory.event.v1',
      event_id: eventId,
      created_at: nowIso(this.clock),
      scope: { project_id: projectId, task_id: taskId },
      actor: { agent_id: 'zero3-autonomous-task-loop', agent_type: 'zero3' },
      event_type: eventType,
      memory: {
        class: 'task', entity_type: 'task_outcome', entity_id: entityId,
        authority: 40, confidence: 0.95, expected_entity_version: expectedVersion
      },
      source: { type: 'system', ref: taskId },
      supersedes: [],
      payload: {
        origin: ZERO3_AUTONOMOUS_TASK_LOOP,
        task_id: taskId,
        state: outcome.state,
        step_id: outcome.stepId,
        progress: snapshot.runtime.task.progress,
        blockers: snapshot.runtime.task.blockers,
        steps: snapshot.runtime.steps.map(step => ({ step_id: step.stepId, status: step.status, blocker: step.blocker })),
        source_key: snapshot.definition.task.metadata?.sourceKey ?? null,
        event_sequence: snapshot.runtime.task.lastEventSequence
      }
    }
    this.store.enqueueMemory(event, projectId, taskId, String(event.created_at))
    try {
      await memory.publish(event)
      this.store.markMemory(eventId, 'acked', null, nowIso(this.clock))
    } catch (error) {
      this.store.markMemory(eventId, 'pending', error instanceof Error ? error.message : String(error), nowIso(this.clock))
    }
  }
}

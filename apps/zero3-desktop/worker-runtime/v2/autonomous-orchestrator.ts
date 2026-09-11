import type { ExecutionExecutorTarget, ExecutionTaskSnapshot } from '../../execution-runtime/contracts.ts'
import type {
  AutonomousAttentionCost,
  AutonomousDisposition,
  AutonomousMainlineImpact,
  AutonomousSeverity,
  AutonomousTaskIntakeRecord
} from './lifecycle-contracts.ts'

export const ZERO3_AUTONOMOUS_ORCHESTRATOR = 'zero3.pilot.autonomous-orchestrator.v1' as const
export const ZERO3_PLAN_PROPOSAL = 'zero3.pilot.autonomous-plan-proposal.v1' as const
export const ZERO3_PLUGIN_CAPABILITY_BASELINE = 'zero3.pilot.plugin-capability-baseline.v1' as const

export type AutonomousPluginCapability =
  | 'zero3.full-capability.web-gpt'
  | 'agent.dispatch.unified'
  | 'agent.dispatch.codex.full'
  | 'session.bootstrap.project'
  | 'memory.shared.lifecycle'

export type AutonomousCapabilityRequirement = {
  capability: AutonomousPluginCapability
  ownerRuntime: 'plugin-vnext' | 'execution-runtime' | 'worker-runtime' | 'memory-authority' | 'gpt-web-runtime'
  requiredFor: readonly string[]
}

export const REQUIRED_POST_PLUGIN_CAPABILITIES: readonly AutonomousCapabilityRequirement[] = [
  { capability: 'zero3.full-capability.web-gpt', ownerRuntime: 'plugin-vnext', requiredFor: ['web-gpt-control'] },
  { capability: 'agent.dispatch.unified', ownerRuntime: 'plugin-vnext', requiredFor: ['cross-agent-dispatch'] },
  { capability: 'agent.dispatch.codex.full', ownerRuntime: 'plugin-vnext', requiredFor: ['codex-full-authority'] },
  { capability: 'session.bootstrap.project', ownerRuntime: 'gpt-web-runtime', requiredFor: ['autonomous-session-bootstrap'] },
  { capability: 'memory.shared.lifecycle', ownerRuntime: 'memory-authority', requiredFor: ['organizational-memory'] }
]
export type PluginCapabilityBaselineStatus = {
  contract: typeof ZERO3_PLUGIN_CAPABILITY_BASELINE
  advertised: readonly string[]
  missing: readonly AutonomousPluginCapability[]
  ready: boolean
}

export function evaluatePluginCapabilityBaseline(advertised: readonly string[]): PluginCapabilityBaselineStatus {
  const available = new Set(advertised)
  const missing = REQUIRED_POST_PLUGIN_CAPABILITIES
    .map(item => item.capability)
    .filter(capability => !available.has(capability))
  return { contract: ZERO3_PLUGIN_CAPABILITY_BASELINE, advertised: [...available].sort(), missing, ready: missing.length === 0 }
}

export type AutonomousGovernanceInput = {
  entityType: string
  detail: Record<string, unknown>
  sourceTaskId: string | null
}

export type AutonomousGovernanceDecision = {
  category: string
  severity: AutonomousSeverity
  confidence: number
  affectedResources: readonly string[]
  mainlineImpact: AutonomousMainlineImpact
  disposition: AutonomousDisposition
  decisionReason: string
  attentionCost: AutonomousAttentionCost
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 64) : []
}

function boundedConfidence(value: unknown, fallback = 0.8): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}
export function decideAutonomousCandidate(input: AutonomousGovernanceInput): AutonomousGovernanceDecision {
  const type = input.entityType.trim().toLowerCase()
  const detail = input.detail
  const explicitDisposition = typeof detail.disposition === 'string' ? detail.disposition.trim().toUpperCase() : ''
  const allowed = new Set<AutonomousDisposition>(['IGNORE', 'OBSERVE', 'DEFER', 'PARALLEL', 'INTERRUPT'])
  const blocking = detail.blocking === true || detail.blocks_mainline === true || detail.requires_immediate_action === true
  const severityRaw = typeof detail.severity === 'string' ? detail.severity.trim().toLowerCase() : ''
  const severity: AutonomousSeverity = severityRaw === 'critical' || severityRaw === 'blocking' ? 'blocking'
    : severityRaw === 'high' ? 'high' : severityRaw === 'low' ? 'low' : 'normal'
  const mainlineImpact: AutonomousMainlineImpact = blocking || type === 'blocker' ? 'interrupt'
    : detail.mainlineImpact === 'parallel' || detail.mainline_impact === 'parallel' ? 'parallel'
      : detail.mainlineImpact === 'defer' || detail.mainline_impact === 'defer' ? 'defer' : 'none'
  let disposition: AutonomousDisposition
  if (allowed.has(explicitDisposition as AutonomousDisposition)) disposition = explicitDisposition as AutonomousDisposition
  else if (blocking || type === 'blocker') disposition = 'INTERRUPT'
  else if (type === 'warning') disposition = 'DEFER'
  else if (type === 'dependency' && input.sourceTaskId) disposition = 'INTERRUPT'
  else if (type === 'work_item' || type === 'work-item' || type === 'task_candidate') disposition = 'PARALLEL'
  else if (type === 'next_actions' || type === 'follow_up' || type === 'follow-up') disposition = detail.auto_execute === true ? 'PARALLEL' : 'DEFER'
  else if (type === 'bug' || type === 'problem' || type === 'error') disposition = detail.requires_action === false ? 'OBSERVE' : 'PARALLEL'
  else disposition = 'OBSERVE'
  const category = typeof detail.category === 'string' && detail.category.trim() ? detail.category.trim().slice(0, 128) : type
  const resources = strings(detail.affectedResources ?? detail.affected_resources ?? detail.resources)
  const costRaw = typeof detail.attentionCost === 'string' ? detail.attentionCost.trim().toLowerCase() : typeof detail.attention_cost === 'string' ? detail.attention_cost.trim().toLowerCase() : ''
  const attentionCost: AutonomousAttentionCost = costRaw === 'high' ? 'high' : costRaw === 'low' ? 'low' : 'medium'
  return {
    category,
    severity,
    confidence: boundedConfidence(detail.confidence, blocking ? 0.95 : 0.8),
    affectedResources: resources,
    mainlineImpact,
    disposition,
    decisionReason: typeof detail.decisionReason === 'string' ? detail.decisionReason.slice(0, 4096)
      : typeof detail.decision_reason === 'string' ? detail.decision_reason.slice(0, 4096)
        : `deterministic governance: ${type} -> ${disposition}`,
    attentionCost
  }
}
export type AutonomousAttentionBudget = {
  maxChildDepth: number
  maxParallelAutoTasks: number
  maxAutoSpawnPerRoot: number
  maxRetries: number
  maxAutonomousSessions: number
}

export const DEFAULT_AUTONOMOUS_ATTENTION_BUDGET: AutonomousAttentionBudget = {
  maxChildDepth: 4,
  maxParallelAutoTasks: 5,
  maxAutoSpawnPerRoot: 20,
  maxRetries: 3,
  maxAutonomousSessions: 12
}

export type AutonomousBudgetUsage = {
  childDepth: number
  parallelAutoTasks: number
  spawnedForRoot: number
  retries: number
  autonomousSessions: number
}

export function evaluateAttentionBudget(
  usage: AutonomousBudgetUsage,
  budget: AutonomousAttentionBudget = DEFAULT_AUTONOMOUS_ATTENTION_BUDGET
): { allowed: boolean; reason: string | null } {
  const checks: Array<[boolean, string]> = [
    [usage.childDepth > budget.maxChildDepth, 'maxChildDepth exceeded'],
    [usage.parallelAutoTasks >= budget.maxParallelAutoTasks, 'maxParallelAutoTasks exhausted'],
    [usage.spawnedForRoot >= budget.maxAutoSpawnPerRoot, 'maxAutoSpawnPerRoot exhausted'],
    [usage.retries > budget.maxRetries, 'maxRetries exceeded'],
    [usage.autonomousSessions >= budget.maxAutonomousSessions, 'maxAutonomousSessions exhausted']
  ]
  const failed = checks.find(([condition]) => condition)
  return failed ? { allowed: false, reason: failed[1] } : { allowed: true, reason: null }
}
export type AutonomousCapabilityProvider = {
  providerId: string
  executor: Exclude<ExecutionExecutorTarget, 'AUTO'>
  capabilities: readonly string[]
  available: boolean
  currentLoad?: number
  riskLevel?: 'low' | 'standard' | 'high'
}

export type AutonomousCapabilityRoute = {
  state: 'READY' | 'WAITING_HUMAN'
  requiredCapabilities: readonly string[]
  provider: AutonomousCapabilityProvider | null
  reason: string
}

export function routeAutonomousCapabilities(
  requiredCapabilities: readonly string[],
  providers: readonly AutonomousCapabilityProvider[]
): AutonomousCapabilityRoute {
  const required = [...new Set(requiredCapabilities.filter(Boolean))]
  const candidates = providers.filter(provider =>
    provider.available && required.every(capability => provider.capabilities.includes(capability))
  ).sort((a, b) => (a.currentLoad ?? 0) - (b.currentLoad ?? 0) || a.providerId.localeCompare(b.providerId))
  if (!candidates.length) {
    return { state: 'WAITING_HUMAN', requiredCapabilities: required, provider: null, reason: 'No safe provider advertises every required capability.' }
  }
  return { state: 'READY', requiredCapabilities: required, provider: candidates[0], reason: `Selected ${candidates[0].providerId} by capability match and load.` }
}

export type AutonomousGuardSource = 'gpt_web' | 'execution' | 'worker' | 'git' | 'compute' | 'tool_mcp' | 'artifact_completion'
export type AutonomousGuardEvent = {
  source: AutonomousGuardSource
  projectId: string
  sourceTaskId?: string | null
  eventRef: string
  kind: string
  message: string
  severity?: AutonomousSeverity
  blocking?: boolean
  affectedResources?: readonly string[]
  metadata?: Readonly<Record<string, unknown>>
}
export function guardEventToCandidate(event: AutonomousGuardEvent): {
  entityType: string
  detail: Record<string, unknown>
  sourceTaskId: string | null
  sourceRefs: readonly string[]
} {
  const severity = event.severity ?? (event.blocking ? 'blocking' : 'normal')
  return {
    entityType: event.blocking ? 'blocker' : event.kind.includes('error') || event.kind.includes('failed') ? 'error' : 'warning',
    sourceTaskId: event.sourceTaskId ?? null,
    sourceRefs: [event.eventRef],
    detail: {
      title: event.message.slice(0, 120),
      message: event.message.slice(0, 4096),
      category: `${event.source}.${event.kind}`.slice(0, 128),
      severity,
      blocking: event.blocking === true,
      affectedResources: [...(event.affectedResources ?? [])],
      source_guard: event.source,
      source_event_ref: event.eventRef,
      ...(event.metadata ?? {})
    }
  }
}

export type AutonomousPlanAction = {
  actionId: string
  type: 'EXECUTE' | 'DEFER' | 'OBSERVE' | 'ESCALATE'
  sourceKey?: string
  taskId?: string
  title: string
  requiredCapabilities: readonly string[]
  reason: string
}

export type AutonomousPlanProposal = {
  contract: typeof ZERO3_PLAN_PROPOSAL
  proposalId: string
  projectId: string
  rootTaskId: string | null
  createdAt: string
  actions: readonly AutonomousPlanAction[]
  materialized: false
}
function proposalActionType(disposition: AutonomousDisposition): AutonomousPlanAction['type'] {
  return disposition === 'PARALLEL' || disposition === 'INTERRUPT' ? 'EXECUTE'
    : disposition === 'DEFER' ? 'DEFER' : disposition === 'OBSERVE' || disposition === 'IGNORE' ? 'OBSERVE' : 'ESCALATE'
}

export function createBasicPlanProposal(input: {
  proposalId: string
  projectId: string
  rootTaskId?: string | null
  createdAt: string
  intakes: readonly AutonomousTaskIntakeRecord[]
}): AutonomousPlanProposal {
  const actions = input.intakes
    .filter(intake => intake.projectId === input.projectId && !intake.resolvedAt)
    .map((intake, index) => ({
      actionId: `${input.proposalId}-a${index + 1}`,
      type: proposalActionType(intake.disposition ?? 'OBSERVE'),
      sourceKey: intake.sourceKey,
      ...(intake.taskId ? { taskId: intake.taskId } : {}),
      title: String(intake.detail.title ?? intake.detail.message ?? intake.entityType).slice(0, 160),
      requiredCapabilities: strings(intake.detail.requiredCapabilities ?? intake.detail.required_capabilities),
      reason: intake.decisionReason ?? 'No governance reason recorded.'
    } satisfies AutonomousPlanAction))
  return {
    contract: ZERO3_PLAN_PROPOSAL,
    proposalId: input.proposalId,
    projectId: input.projectId,
    rootTaskId: input.rootTaskId ?? null,
    createdAt: input.createdAt,
    actions,
    materialized: false
  }
}

export type HumanAttentionItem = {
  sourceKey: string
  projectId: string
  taskId: string | null
  reason: string
  severity: AutonomousSeverity
}

export function projectHumanAttention(intakes: readonly AutonomousTaskIntakeRecord[]): HumanAttentionItem[] {
  return intakes.filter(item => Boolean(item.humanAttentionReason) && !item.resolvedAt).map(item => ({
    sourceKey: item.sourceKey,
    projectId: item.projectId,
    taskId: item.taskId,
    reason: item.humanAttentionReason!,
    severity: item.severity ?? 'normal'
  }))
}

export type ExecutionGraphNode = {
  id: string
  kind: 'task' | 'candidate' | 'session'
  label: string
  status: string | null
  authoritativeRef: string
}

export type ExecutionGraphEdge = {
  from: string
  to: string
  relation: 'parent' | 'source' | 'executes'
}

export type ExecutionGraphProjection = {
  projectId: string
  nodes: readonly ExecutionGraphNode[]
  edges: readonly ExecutionGraphEdge[]
}

export function projectExecutionGraph(input: {
  projectId: string
  tasks: readonly ExecutionTaskSnapshot[]
  intakes: readonly AutonomousTaskIntakeRecord[]
}): ExecutionGraphProjection {
  const nodes: ExecutionGraphNode[] = []
  const edges: ExecutionGraphEdge[] = []
  for (const task of input.tasks.filter(item => item.definition.task.projectId === input.projectId)) {
    const taskId = task.definition.task.taskId
    nodes.push({ id: `task:${taskId}`, kind: 'task', label: task.definition.task.title, status: task.runtime.task.status, authoritativeRef: taskId })
    for (const binding of task.runtime.sessionBindings) {
      nodes.push({ id: `session:${binding.bindingId}`, kind: 'session', label: binding.executor, status: binding.state, authoritativeRef: binding.bindingId })
      edges.push({ from: `task:${taskId}`, to: `session:${binding.bindingId}`, relation: 'executes' })
    }
  }
  for (const intake of input.intakes.filter(item => item.projectId === input.projectId)) {
    nodes.push({ id: `candidate:${intake.sourceKey}`, kind: 'candidate', label: String(intake.detail.title ?? intake.entityType), status: intake.disposition ?? null, authoritativeRef: intake.sourceKey })
    if (intake.parentTaskId) edges.push({ from: `task:${intake.parentTaskId}`, to: `candidate:${intake.sourceKey}`, relation: 'source' })
    if (intake.taskId) edges.push({ from: `candidate:${intake.sourceKey}`, to: `task:${intake.taskId}`, relation: 'source' })
  }
  return { projectId: input.projectId, nodes, edges }
}

export type DailyReviewProjection = {
  projectId: string
  generatedAt: string
  userRootTasks: number
  autonomousTasks: number
  discoveredCandidates: number
  dispositions: Readonly<Record<AutonomousDisposition, number>>
  resolvedCandidates: number
  openCandidates: number
  humanAttention: number
}

export function projectDailyReview(input: {
  projectId: string
  generatedAt: string
  tasks: readonly ExecutionTaskSnapshot[]
  intakes: readonly AutonomousTaskIntakeRecord[]
}): DailyReviewProjection {
  const tasks = input.tasks.filter(task => task.definition.task.projectId === input.projectId)
  const intakes = input.intakes.filter(item => item.projectId === input.projectId)
  const dispositions: Record<AutonomousDisposition, number> = { IGNORE: 0, OBSERVE: 0, DEFER: 0, PARALLEL: 0, INTERRUPT: 0 }
  for (const intake of intakes) if (intake.disposition) dispositions[intake.disposition] += 1
  return {
    projectId: input.projectId,
    generatedAt: input.generatedAt,
    userRootTasks: tasks.filter(task => task.definition.task.metadata?.autonomousTaskLoop !== 'zero3.pilot.autonomous-task-loop.v1').length,
    autonomousTasks: tasks.filter(task => task.definition.task.metadata?.autonomousTaskLoop === 'zero3.pilot.autonomous-task-loop.v1').length,
    discoveredCandidates: intakes.length,
    dispositions,
    resolvedCandidates: intakes.filter(item => Boolean(item.resolvedAt)).length,
    openCandidates: intakes.filter(item => !item.resolvedAt).length,
    humanAttention: intakes.filter(item => Boolean(item.humanAttentionReason) && !item.resolvedAt).length
  }
}

export type TypedGuardInput = Omit<AutonomousGuardEvent, 'source'>

function typedGuard(source: AutonomousGuardSource, input: TypedGuardInput): AutonomousGuardEvent {
  return { ...input, source }
}

export const gptWebGuardEvent = (input: TypedGuardInput): AutonomousGuardEvent => typedGuard('gpt_web', input)
export const executionGuardEvent = (input: TypedGuardInput): AutonomousGuardEvent => typedGuard('execution', input)
export const workerGuardEvent = (input: TypedGuardInput): AutonomousGuardEvent => typedGuard('worker', input)
export const gitGuardEvent = (input: TypedGuardInput): AutonomousGuardEvent => typedGuard('git', input)
export const computeGuardEvent = (input: TypedGuardInput): AutonomousGuardEvent => typedGuard('compute', input)
export const toolMcpGuardEvent = (input: TypedGuardInput): AutonomousGuardEvent => typedGuard('tool_mcp', input)
export const artifactCompletionGuardEvent = (input: TypedGuardInput): AutonomousGuardEvent => typedGuard('artifact_completion', input)
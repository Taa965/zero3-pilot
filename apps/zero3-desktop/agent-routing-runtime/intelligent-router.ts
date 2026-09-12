import type { Zero3ResolvedAgentTarget, Zero3TaskSpecV2, Zero3TaskType } from './agent-contracts'
import { validateTaskSpecV2, type Zero3ProviderAvailability, type Zero3ProviderAvailabilityState } from './agent-router'
import {
  ZERO3_INTELLIGENT_ROUTE_DECISION_V1,
  verificationProfileFor,
  Zero3RoutingError,
  type Zero3IntelligentRouteDecision,
  type Zero3RoutingAlternative,
  type Zero3RoutingCapability,
  type Zero3RoutingExecutorCandidate,
  type Zero3RoutingExecutorId,
  type Zero3RoutingExecutorStatus,
  type Zero3RoutingFactors,
  type Zero3RoutingMetricsSnapshot,
  type Zero3RoutingRejection,
  type Zero3RoutingRequest
} from './intelligent-router-contracts'

// Default routing catalog. These are the shipped capability/effort profiles for
// the built-in executors. They are heuristics the router starts from, not hard
// bindings: hosts may override individual entries through the catalog option,
// and historical performance continuously reshapes the outcome.
const DEFAULT_CATALOG: readonly Zero3RoutingExecutorCandidate[] = [
  {
    executorId: 'CODEX',
    provider: 'CODEX',
    label: 'Native Codex (Zero3 Agent Kernel)',
    capabilities: [
      'repository_read', 'repository_write', 'filesystem', 'shell', 'git', 'build', 'test', 'mcp',
      'large_context', 'code_review', 'architecture_reasoning', 'research', 'workflow', 'artifact_generation',
      'documentation', 'general_reasoning'
    ],
    status: 'ready',
    contextAffinity: 0.4,
    costWeight: 0.55,
    latencyWeight: 0.55,
    maxContextTokens: 272_000
  },
  {
    executorId: 'GEMINI',
    provider: 'GEMINI',
    label: 'Antigravity / Gemini agent',
    capabilities: [
      'repository_read', 'repository_write', 'filesystem', 'shell', 'git', 'browser', 'multimodal',
      'research', 'large_context', 'code_review', 'architecture_reasoning', 'artifact_generation',
      'documentation', 'general_reasoning'
    ],
    status: 'ready',
    contextAffinity: 0.3,
    costWeight: 0.8,
    latencyWeight: 0.4,
    maxContextTokens: 1_000_000
  },
  {
    executorId: 'CLAUDE',
    provider: 'CLAUDE',
    label: 'Claude Code',
    capabilities: [
      'repository_read', 'repository_write', 'filesystem', 'shell', 'git', 'build', 'test', 'mcp',
      'large_context', 'code_review', 'architecture_reasoning', 'research', 'workflow',
      'artifact_generation', 'documentation', 'general_reasoning'
    ],
    status: 'ready',
    contextAffinity: 0.3,
    costWeight: 0.45,
    latencyWeight: 0.65,
    maxContextTokens: 200_000
  },
  {
    executorId: 'ZERO3_API',
    provider: 'ZERO3_API',
    label: 'Zero3 API model session',
    // Honest capability floor for a profile-based model session that cannot
    // mutate a repository. A host whose Zero3 API adapter provably runs the
    // session in a read-only workspace sandbox may add `repository_read` through
    // `catalogOverrides`; write/shell/git/build/test stay absent because this
    // executor never gets write access.
    capabilities: [
      'general_reasoning', 'research', 'code_review', 'architecture_reasoning', 'large_context',
      'documentation', 'multimodal'
    ],
    status: 'ready',
    contextAffinity: 0.3,
    costWeight: 0.85,
    latencyWeight: 0.8,
    maxContextTokens: 128_000
  }
]

// Task-type affinity per executor. Task importance never appears here on
// purpose: importance scales verification/review strength, not executor choice.
const TASK_TYPE_AFFINITY: Record<Zero3RoutingExecutorId, Record<Zero3TaskType, number>> = {
  CODEX: { DESIGN: 0.6, IMPLEMENT: 0.9, VERIFY: 0.8, FIX: 0.9, REVIEW: 0.6, INTEGRATE: 0.85, RESEARCH: 0.55 },
  GEMINI: { DESIGN: 0.9, IMPLEMENT: 0.6, VERIFY: 0.6, FIX: 0.55, REVIEW: 0.8, INTEGRATE: 0.55, RESEARCH: 0.85 },
  CLAUDE: { DESIGN: 0.75, IMPLEMENT: 0.85, VERIFY: 0.7, FIX: 0.85, REVIEW: 0.85, INTEGRATE: 0.8, RESEARCH: 0.75 },
  ZERO3_API: { DESIGN: 0.75, IMPLEMENT: 0.3, VERIFY: 0.4, FIX: 0.25, REVIEW: 0.7, INTEGRATE: 0.25, RESEARCH: 0.8 }
}

const REQUIRED_CAPABILITIES_BY_TYPE: Record<Zero3TaskType, readonly Zero3RoutingCapability[]> = {
  DESIGN: [],
  IMPLEMENT: ['repository_read', 'repository_write'],
  VERIFY: ['repository_read'],
  FIX: ['repository_read', 'repository_write'],
  REVIEW: ['code_review'],
  INTEGRATE: ['repository_read', 'repository_write'],
  RESEARCH: ['research']
}

// Composite score weights. capability is a hard filter, so it has no weight:
// an executor missing a required capability is never selected, whatever its
// other factors look like.
const WEIGHTS = {
  taskType: 0.28,
  historicalSuccess: 0.22,
  contextAffinity: 0.18,
  availability: 0.12,
  latency: 0.1,
  cost: 0.1
} as const

const HISTORICAL_NEUTRAL_PRIOR = 0.5
const AVAILABILITY_UNPROVEN_PENALTY = 0.7

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function availabilityState(
  executorId: Zero3RoutingExecutorId,
  availability: Zero3ProviderAvailability
): Zero3ProviderAvailabilityState {
  switch (executorId) {
    case 'CODEX': return availability.codex
    case 'GEMINI': return availability.gemini
    case 'CLAUDE': return availability.claude
    case 'ZERO3_API': return availability.zero3Api ?? { available: false, authenticated: null }
  }
}

const PROBE_HEALTH_STATUSES: readonly Zero3RoutingExecutorStatus[] = [
  'offline', 'unauthenticated', 'rate_limited', 'quota_exhausted', 'overloaded', 'unregistered'
]

// A catalog status other than 'ready' wins (it carries operator knowledge);
// otherwise the live availability probe decides, including the richer health
// states a production probe reports (quota_exhausted / rate_limited /
// overloaded). `authenticated: null` means the probe could not prove
// authentication either way: the executor stays eligible with a penalty instead
// of blocking the whole system, because execution failures are caught by the
// dispatcher's failover loop.
function effectiveStatus(
  candidate: Zero3RoutingExecutorCandidate,
  availability: Zero3ProviderAvailability
): Zero3RoutingExecutorStatus {
  if (candidate.status !== 'ready') return candidate.status
  const state = availabilityState(candidate.executorId, availability)
  const reported = state.status ?? null
  if (reported && reported !== 'ready' && PROBE_HEALTH_STATUSES.includes(reported)) return reported
  if (!state.available) return 'offline'
  if (state.authenticated === false) return 'unauthenticated'
  return 'ready'
}

function blockedStatusReason(status: Zero3RoutingExecutorStatus): string | null {
  switch (status) {
    case 'offline': return 'offline'
    case 'unauthenticated': return 'known unauthenticated'
    case 'rate_limited': return 'rate limited'
    case 'quota_exhausted': return 'quota exhausted'
    case 'overloaded': return 'currently overloaded'
    case 'unregistered': return 'no adapter or availability probe registered'
    default: return null
  }
}

function availabilityFactor(status: Zero3RoutingExecutorStatus, authenticated: boolean | null): number {
  if (status !== 'ready') return 0
  return authenticated === true ? 1 : AVAILABILITY_UNPROVEN_PENALTY
}

// Observed latency (probe reading, else rolling p50 from the shared routing
// metrics store) scales the catalog latency weight. Missing history is neutral:
// an executor without latency evidence keeps its catalog weight rather than
// being penalised for data that does not exist.
function latencyFactor(
  candidate: Zero3RoutingExecutorCandidate,
  state: Zero3ProviderAvailabilityState,
  task: Zero3TaskSpecV2,
  metrics: Zero3RoutingMetricsSnapshot | null | undefined
): number {
  const base = clamp01(candidate.latencyWeight)
  const stats = metrics?.executors?.[candidate.executorId]?.[task.type]
  const candidates = [
    state.latencyMs,
    stats && stats.p50LatencyMs > 0 ? stats.p50LatencyMs : null,
    stats && stats.avgLatencyMs > 0 ? stats.avgLatencyMs : null
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  if (candidates.length === 0) return round3(base)
  const observed = Math.min(...candidates)
  // 1s -> 1, 10s -> 0.85, 100s -> 0.7, 1000s -> 0.55. Deterministic, bounded,
  // and only applied to evidence the system actually observed.
  const score = clamp01(1 - clamp01(Math.log10(Math.max(observed, 1_000) / 1_000) / 2) * 0.6)
  return round3(clamp01(base * score))
}

function historicalFactor(
  executorId: Zero3RoutingExecutorId,
  task: Zero3TaskSpecV2,
  metrics: Zero3RoutingMetricsSnapshot | null | undefined
): number {
  const stats = metrics?.executors?.[executorId]?.[task.type]
  if (!stats || stats.attempts === 0) return HISTORICAL_NEUTRAL_PRIOR
  const verificationPart = stats.verificationPasses + stats.verificationFailures > 0
    ? stats.verificationPassRate
    : stats.successRate
  return clamp01(stats.successRate * 0.6 + verificationPart * 0.4)
}

export type Zero3IntelligentRouterOptions = {
  // Overrides/extends the default catalog by executorId. Entries must keep the
  // executor/provider pairing of the built-in set.
  catalogOverrides?: readonly Partial<Zero3RoutingExecutorCandidate>[]
  now?: () => string
}

function mergeCatalog(overrides?: readonly Partial<Zero3RoutingExecutorCandidate>[]): Zero3RoutingExecutorCandidate[] {
  if (!overrides?.length) return [...DEFAULT_CATALOG]
  const merged = new Map<Zero3RoutingExecutorId, Zero3RoutingExecutorCandidate>(
    DEFAULT_CATALOG.map(candidate => [candidate.executorId, { ...candidate, capabilities: [...candidate.capabilities] }])
  )
  for (const override of overrides) {
    if (!override.executorId) throw new Error('catalog override requires executorId')
    const base = merged.get(override.executorId)
    if (!base) throw new Error(`catalog override references unknown executor ${override.executorId}`)
    merged.set(override.executorId, {
      ...base,
      ...override,
      capabilities: override.capabilities ? [...override.capabilities] : base.capabilities
    })
  }
  return [...merged.values()]
}

export class Zero3IntelligentTaskRouter {
  readonly #catalog: Zero3RoutingExecutorCandidate[]
  readonly #now: () => string

  constructor(options: Zero3IntelligentRouterOptions = {}) {
    this.#catalog = mergeCatalog(options.catalogOverrides)
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  route(request: Zero3RoutingRequest): Zero3IntelligentRouteDecision {
    const task = request.task
    validateTaskSpecV2(task)
    const mode = request.mode
    if (mode !== 'AUTO' && mode !== 'PINNED' && mode !== 'PREFERRED') {
      throw new Zero3RoutingError('INVALID_ROUTING_REQUEST', `routing mode ${String(mode)} is invalid`)
    }
    if (request.importance !== 'low' && request.importance !== 'normal' && request.importance !== 'high' && request.importance !== 'critical') {
      throw new Zero3RoutingError('INVALID_ROUTING_REQUEST', `task importance ${String(request.importance)} is invalid`)
    }
    if ((mode === 'PINNED' || mode === 'PREFERRED') && !request.requestedExecutor) {
      throw new Zero3RoutingError('INVALID_ROUTING_REQUEST', `${mode} routing requires an explicit executor`)
    }

    const required = new Set<Zero3RoutingCapability>([
      ...REQUIRED_CAPABILITIES_BY_TYPE[task.type],
      ...(request.requiredCapabilities ?? [])
    ])
    const exclusions = new Set<Zero3RoutingExecutorId>(request.exclusions ?? [])
    const rejections: Zero3RoutingRejection[] = []

    type Scored = {
      candidate: Zero3RoutingExecutorCandidate
      status: Zero3RoutingExecutorStatus
      factors: Zero3RoutingFactors
      score: number
    }

    const scored: Scored[] = []
    for (const candidate of this.#catalog) {
      if (exclusions.has(candidate.executorId)) {
        rejections.push({ executorId: candidate.executorId, reason: 'excluded: previously failed for this task' })
        continue
      }
      const status = effectiveStatus(candidate, request.availability)
      const blocked = blockedStatusReason(status)
      if (blocked) {
        rejections.push({ executorId: candidate.executorId, reason: blocked })
        continue
      }
      const missing = required.size === 0
        ? []
        : [...required].filter(capability => !candidate.capabilities.includes(capability))
      if (missing.length > 0) {
        rejections.push({ executorId: candidate.executorId, reason: `missing required capabilities: ${missing.join(', ')}` })
        continue
      }
      const authState = availabilityState(candidate.executorId, request.availability)
      const factors: Zero3RoutingFactors = {
        capability: 1,
        availability: round3(availabilityFactor(status, authState.authenticated)),
        taskType: round3(TASK_TYPE_AFFINITY[candidate.executorId][task.type]),
        contextAffinity: round3(clamp01(candidate.contextAffinity)),
        latency: latencyFactor(candidate, authState, task, request.metrics),
        cost: round3(clamp01(candidate.costWeight)),
        historicalSuccess: round3(historicalFactor(candidate.executorId, task, request.metrics))
      }
      const score = round3(
        factors.taskType * WEIGHTS.taskType
        + factors.historicalSuccess * WEIGHTS.historicalSuccess
        + factors.contextAffinity * WEIGHTS.contextAffinity
        + factors.availability * WEIGHTS.availability
        + factors.latency * WEIGHTS.latency
        + factors.cost * WEIGHTS.cost
      )
      scored.push({ candidate, status, factors, score })
    }

    scored.sort((a, b) => b.score - a.score)

    const describeFactors = (factors: Zero3RoutingFactors): string => {
      const strongest = Object.entries(factors)
        .filter(([name]) => name !== 'capability')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name, value]) => `${name} ${value}`)
      return strongest.join(', ')
    }

    const buildDecision = (
      selected: Scored,
      reason: string,
      requestedExecutor: Zero3RoutingExecutorId | null
    ): Zero3IntelligentRouteDecision => ({
      protocol: ZERO3_INTELLIGENT_ROUTE_DECISION_V1,
      taskId: task.taskId,
      executionId: task.executionId,
      routingMode: mode,
      requestedExecutor,
      importance: request.importance,
      verificationProfile: verificationProfileFor(request.importance),
      selectedExecutor: selected.candidate.executorId,
      provider: selected.candidate.provider as Zero3ResolvedAgentTarget,
      reason,
      score: selected.score,
      alternatives: scored
        .filter(entry => entry.candidate.executorId !== selected.candidate.executorId)
        .map(entry => ({
          executorId: entry.candidate.executorId,
          provider: entry.candidate.provider as Zero3ResolvedAgentTarget,
          score: entry.score,
          reason: `eligible alternative (${describeFactors(entry.factors)})`
        })),
      fallbackOrder: scored
        .filter(entry => entry.candidate.executorId !== selected.candidate.executorId)
        .map(entry => entry.candidate.executorId),
      routingFactors: selected.factors,
      rejectedExecutors: rejections,
      decidedAt: this.#now()
    })

    if (mode === 'PINNED') {
      const pinned = scored.find(entry => entry.candidate.executorId === request.requestedExecutor)
      if (!pinned) {
        throw new Zero3RoutingError(
          'PINNED_EXECUTOR_UNAVAILABLE',
          `pinned executor ${request.requestedExecutor} is not eligible: ${
            rejections.find(item => item.executorId === request.requestedExecutor)?.reason ?? 'not registered'
          }; pinned targets are never silently changed`,
          rejections
        )
      }
      return buildDecision(pinned, `pinned executor ${pinned.candidate.executorId} honored for task type ${task.type}`, request.requestedExecutor)
    }

    if (mode === 'PREFERRED' && request.requestedExecutor) {
      const preferred = scored.find(entry => entry.candidate.executorId === request.requestedExecutor)
      if (preferred) {
        return buildDecision(
          preferred,
          `preferred executor ${preferred.candidate.executorId} is eligible and honored ahead of scored alternatives`,
          request.requestedExecutor
        )
      }
      // Preferred executor is unavailable: PREFERRED semantics allow falling
      // back to the best scored remaining candidate instead of blocking.
    }

    const best = scored[0]
    if (!best) {
      throw new Zero3RoutingError(
        'NO_ELIGIBLE_EXECUTOR',
        `no eligible executor for task type ${task.type}: ${rejections.map(item => `${item.executorId} (${item.reason})`).join('; ') || 'no executors registered'}`,
        rejections
      )
    }
    const preferredNote = mode === 'PREFERRED'
      ? `preferred executor ${request.requestedExecutor} unavailable (${rejections.find(item => item.executorId === request.requestedExecutor)?.reason ?? 'not registered'}); `
      : ''
    return buildDecision(
      best,
      `${preferredNote}AUTO selected ${best.candidate.executorId} with composite score ${best.score} (${describeFactors(best.factors)})`,
      request.requestedExecutor
    )
  }
}

import type { Zero3ResolvedAgentTarget, Zero3TaskImportance, Zero3TaskSpecV2 } from './agent-contracts'
import type { Zero3ProviderAvailability } from './agent-router'

export const ZERO3_INTELLIGENT_ROUTE_DECISION_V1 = 'zero3.pilot.intelligent-route-decision.v1' as const

// Routing modes. AUTO lets Zero3 choose the executor; PINNED honors an explicit
// executor and never silently switches; PREFERRED tries the requested executor
// first but allows automatic failover when it is unavailable or fails.
export type Zero3RoutingMode = 'AUTO' | 'PINNED' | 'PREFERRED'

export type Zero3RoutingExecutorId = 'CODEX' | 'GEMINI' | 'CLAUDE' | 'ZERO3_API'

export type Zero3RoutingCapability =
  | 'repository_read'
  | 'repository_write'
  | 'filesystem'
  | 'shell'
  | 'git'
  | 'build'
  | 'test'
  | 'browser'
  | 'mcp'
  | 'large_context'
  | 'code_review'
  | 'architecture_reasoning'
  | 'multimodal'
  | 'research'
  | 'workflow'
  | 'artifact_generation'
  | 'documentation'
  | 'general_reasoning'

// Executor health as seen by the routing plane. quota_exhausted/rate_limited/
// overloaded keep the executor out of AUTO selection without blocking the task:
// failover continues with the remaining candidates.
export type Zero3RoutingExecutorStatus =
  | 'ready'
  | 'offline'
  | 'unauthenticated'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'overloaded'
  | 'unregistered'

export type Zero3RoutingExecutorCandidate = {
  executorId: Zero3RoutingExecutorId
  provider: Zero3ResolvedAgentTarget
  label: string
  capabilities: readonly Zero3RoutingCapability[]
  status: Zero3RoutingExecutorStatus
  // 0..1. How much live task/project context this executor already holds. High
  // context affinity lowers the contextSwitchCost of continuing with it.
  contextAffinity: number
  // 0..1 relative weights; higher is cheaper / faster respectively.
  costWeight: number
  latencyWeight: number
  maxContextTokens: number
}

export type Zero3RoutingFactors = {
  capability: number
  availability: number
  taskType: number
  contextAffinity: number
  latency: number
  cost: number
  historicalSuccess: number
}

export type Zero3RoutingAlternative = {
  executorId: Zero3RoutingExecutorId
  provider: Zero3ResolvedAgentTarget
  score: number
  reason: string
}

export type Zero3RoutingRejection = {
  executorId: Zero3RoutingExecutorId
  reason: string
}

// Structured, auditable routing decision. A bare executor string is never a
// sufficient routing output: every decision records why it was made, what the
// alternatives were, and how strong the verification must be.
export type Zero3IntelligentRouteDecision = {
  protocol: typeof ZERO3_INTELLIGENT_ROUTE_DECISION_V1
  taskId: string
  executionId: string
  routingMode: Zero3RoutingMode
  requestedExecutor: Zero3RoutingExecutorId | null
  importance: Zero3TaskImportance
  verificationProfile: Zero3VerificationProfileName
  selectedExecutor: Zero3RoutingExecutorId
  provider: Zero3ResolvedAgentTarget
  reason: string
  score: number
  alternatives: Zero3RoutingAlternative[]
  fallbackOrder: Zero3RoutingExecutorId[]
  routingFactors: Zero3RoutingFactors
  rejectedExecutors: Zero3RoutingRejection[]
  decidedAt: string
}

// Verification profiles bind task importance to verification/review strength.
// They never bind importance to an executor: a critical task may be executed by
// CLAUDE, verified by Codex command/exec evidence and reviewed by Web GPT.
export type Zero3VerificationProfileName = 'low' | 'standard' | 'high' | 'critical'

export type Zero3VerificationProfile = {
  name: Zero3VerificationProfileName
  // Executor self-reported success is not sufficient evidence on its own.
  requiresIndependentVerifier: boolean
  // The reviewer must differ from the executing provider.
  requiresDistinctReviewer: boolean
  // Execution and review must come from different models, not only different
  // sessions of the same model.
  crossModelReview: boolean
  description: string
}

export const ZERO3_VERIFICATION_PROFILES: Record<Zero3VerificationProfileName, Zero3VerificationProfile> = {
  low: {
    name: 'low',
    requiresIndependentVerifier: false,
    requiresDistinctReviewer: false,
    crossModelReview: false,
    description: 'Executor self-checks are sufficient; no independent review is required.'
  },
  standard: {
    name: 'standard',
    requiresIndependentVerifier: false,
    requiresDistinctReviewer: false,
    crossModelReview: false,
    description: 'TaskSpec verification commands (static checks / unit tests) run through the authoritative verification collector.'
  },
  high: {
    name: 'high',
    requiresIndependentVerifier: true,
    requiresDistinctReviewer: true,
    crossModelReview: false,
    description: 'Full project verification plus an independent verifier and a reviewer distinct from the executor.'
  },
  critical: {
    name: 'critical',
    requiresIndependentVerifier: true,
    requiresDistinctReviewer: true,
    crossModelReview: true,
    description: 'Executor, verifier and reviewer must not collapse into one model; cross-model review is enforced.'
  }
}

export function verificationProfileFor(importance: Zero3TaskImportance): Zero3VerificationProfileName {
  switch (importance) {
    case 'low': return 'low'
    case 'high': return 'high'
    case 'critical': return 'critical'
    default: return 'standard'
  }
}

export function verificationProfile(name: Zero3VerificationProfileName): Zero3VerificationProfile {
  return ZERO3_VERIFICATION_PROFILES[name]
}

// Historical executor performance per (executor, taskClass) as recorded by the
// Zero3RoutingMetricsStore. Missing data is a neutral prior, never a penalty.
export type Zero3ExecutorTaskClassStats = {
  attempts: number
  successes: number
  failures: number
  verificationPasses: number
  verificationFailures: number
  successRate: number
  verificationPassRate: number
  avgLatencyMs: number
  p50LatencyMs: number
  p95LatencyMs: number
  avgCostUsd: number
  totalCostUsd: number
}

export type Zero3RoutingMetricsSnapshot = {
  version: 1
  updatedAt: string
  executors: Record<string, Partial<Record<string, Zero3ExecutorTaskClassStats>>>
}

export type Zero3RoutingRequest = {
  task: Zero3TaskSpecV2
  mode: Zero3RoutingMode
  requestedExecutor: Zero3RoutingExecutorId | null
  importance: Zero3TaskImportance
  availability: Zero3ProviderAvailability
  metrics?: Zero3RoutingMetricsSnapshot | null
  // Executors that already failed for this task in the current dispatch loop.
  exclusions?: readonly Zero3RoutingExecutorId[]
  // Explicit capability floor merged with the task-type derivation.
  requiredCapabilities?: readonly Zero3RoutingCapability[]
}

export type Zero3RoutingErrorCode =
  | 'NO_ELIGIBLE_EXECUTOR'
  | 'PINNED_EXECUTOR_UNAVAILABLE'
  | 'INVALID_ROUTING_REQUEST'

export class Zero3RoutingError extends Error {
  readonly code: Zero3RoutingErrorCode
  readonly rejections: Zero3RoutingRejection[]

  constructor(code: Zero3RoutingErrorCode, message: string, rejections: Zero3RoutingRejection[] = []) {
    super(message)
    this.name = 'Zero3RoutingError'
    this.code = code
    this.rejections = rejections
  }
}

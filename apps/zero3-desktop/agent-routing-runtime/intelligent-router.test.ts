import assert from 'node:assert/strict'
import test from 'node:test'

import type { Zero3TaskSpecV2 } from './agent-contracts'
import { Zero3IntelligentTaskRouter } from './intelligent-router'
import {
  Zero3RoutingError,
  verificationProfileFor,
  type Zero3RoutingMetricsSnapshot
} from './intelligent-router-contracts'
import type { Zero3ProviderAvailability } from './agent-router'

const ALL_HEALTHY: Zero3ProviderAvailability = {
  codex: { available: true, authenticated: true },
  gemini: { available: true, authenticated: true },
  claude: { available: true, authenticated: true },
  zero3Api: { available: true, authenticated: true }
}

function taskSpec(overrides: Partial<Zero3TaskSpecV2> = {}): Zero3TaskSpecV2 {
  return {
    protocol: 'zero3.pilot.task-spec.v2',
    taskId: 'task-router-1',
    executionId: 'task-router-1-exec-1',
    projectId: 'project-1',
    target: 'AUTO',
    type: 'IMPLEMENT',
    title: 'Router probe task',
    goal: 'Do the routed work.',
    contextVersion: 1,
    importance: 'normal',
    requirements: [],
    constraints: [],
    requiredContracts: [],
    inputArtifacts: [],
    expectedOutputs: [],
    verification: [],
    completionGate: [],
    reviewPolicy: { required: false, reviewer: 'GPT_WEB' },
    createdBySessionId: 'session-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function metricsWith(
  executorId: string,
  taskClass: string,
  stats: { attempts: number; successes: number; verificationPasses: number; verificationFailures: number }
): Zero3RoutingMetricsSnapshot {
  return {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    executors: {
      [executorId]: {
        [taskClass]: {
          attempts: stats.attempts,
          successes: stats.successes,
          failures: stats.attempts - stats.successes,
          verificationPasses: stats.verificationPasses,
          verificationFailures: stats.verificationFailures,
          successRate: stats.attempts > 0 ? stats.successes / stats.attempts : 0,
          verificationPassRate: stats.verificationPasses + stats.verificationFailures > 0
            ? stats.verificationPasses / (stats.verificationPasses + stats.verificationFailures)
            : 0,
          avgLatencyMs: 0,
          p50LatencyMs: 0,
          p95LatencyMs: 0,
          avgCostUsd: 0,
          totalCostUsd: 0
        }
      }
    }
  }
}

test('AUTO routes a repository coding task to Codex while listing eligible alternatives', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({ task: taskSpec(), mode: 'AUTO', requestedExecutor: null, importance: 'normal', availability: ALL_HEALTHY })
  assert.equal(decision.protocol, 'zero3.pilot.intelligent-route-decision.v1')
  assert.equal(decision.selectedExecutor, 'CODEX')
  assert.equal(decision.provider, 'CODEX')
  assert.equal(decision.routingMode, 'AUTO')
  assert.equal(decision.routingFactors.capability, 1)
  assert.ok(decision.alternatives.some(entry => entry.executorId === 'CLAUDE'))
  assert.ok(decision.fallbackOrder.includes('CLAUDE'))
  assert.ok(
    decision.rejectedExecutors.some(entry => entry.executorId === 'ZERO3_API' && entry.reason.includes('repository_write')),
    'ZERO3_API lacks repository_write and must be rejected for coding tasks'
  )
  assert.ok(decision.reason.includes('AUTO selected CODEX'))
})

test('AUTO skips a quota-exhausted executor and records the rejection instead of blocking the task', () => {
  const router = new Zero3IntelligentTaskRouter({
    catalogOverrides: [{ executorId: 'CODEX', status: 'quota_exhausted' }]
  })
  const decision = router.route({ task: taskSpec(), mode: 'AUTO', requestedExecutor: null, importance: 'normal', availability: ALL_HEALTHY })
  assert.equal(decision.selectedExecutor, 'CLAUDE')
  assert.ok(decision.rejectedExecutors.some(entry => entry.executorId === 'CODEX' && entry.reason === 'quota exhausted'))
})

test('AUTO excludes offline and known-unauthenticated executors', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec(),
    mode: 'AUTO',
    requestedExecutor: null,
    importance: 'normal',
    availability: {
      codex: { available: false, authenticated: null },
      gemini: { available: true, authenticated: false },
      claude: { available: true, authenticated: true }
    }
  })
  assert.equal(decision.selectedExecutor, 'CLAUDE')
  assert.ok(decision.rejectedExecutors.some(entry => entry.executorId === 'CODEX' && entry.reason === 'offline'))
  assert.ok(decision.rejectedExecutors.some(entry => entry.executorId === 'GEMINI' && entry.reason === 'known unauthenticated'))
})

test('AUTO prefers the cheaper low-effort Zero3 API model for research tasks when it is eligible', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec({ type: 'RESEARCH' }),
    mode: 'AUTO',
    requestedExecutor: null,
    importance: 'normal',
    availability: ALL_HEALTHY
  })
  assert.equal(decision.selectedExecutor, 'ZERO3_API')
  assert.equal(decision.routingFactors.cost, 0.85)
  assert.ok(decision.alternatives.some(entry => entry.executorId === 'CLAUDE'))
})

test('AUTO can select Claude for high-importance work; importance never pins an executor', () => {
  const router = new Zero3IntelligentTaskRouter({
    catalogOverrides: [{ executorId: 'CODEX', status: 'rate_limited' }]
  })
  const decision = router.route({
    task: taskSpec({ importance: 'critical' }),
    mode: 'AUTO',
    requestedExecutor: null,
    importance: 'critical',
    availability: ALL_HEALTHY
  })
  assert.equal(decision.selectedExecutor, 'CLAUDE')
  assert.equal(decision.verificationProfile, 'critical')
  assert.equal(decision.importance, 'critical')
  assert.equal(verificationProfileFor('high'), 'high')
  assert.equal(verificationProfileFor('low'), 'low')
  assert.equal(verificationProfileFor('normal'), 'standard')
})

test('large-context requirements filter executors that cannot hold the context', () => {
  const router = new Zero3IntelligentTaskRouter({
    catalogOverrides: [{ executorId: 'CODEX', capabilities: ['repository_read', 'repository_write', 'code_review'] }]
  })
  const decision = router.route({
    task: taskSpec({ type: 'REVIEW' }),
    mode: 'AUTO',
    requestedExecutor: null,
    importance: 'normal',
    availability: ALL_HEALTHY,
    requiredCapabilities: ['large_context', 'code_review', 'repository_read']
  })
  assert.equal(decision.selectedExecutor, 'CLAUDE')
  assert.ok(decision.rejectedExecutors.some(entry => entry.executorId === 'CODEX' && entry.reason.includes('large_context')))
  assert.ok(decision.rejectedExecutors.some(entry => entry.executorId === 'ZERO3_API' && entry.reason.includes('repository_read')))
})

test('historical success lifts an executor with proven results for the task class', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec({ type: 'IMPLEMENT' }),
    mode: 'AUTO',
    requestedExecutor: null,
    importance: 'normal',
    availability: ALL_HEALTHY,
    metrics: metricsWith('CLAUDE', 'IMPLEMENT', { attempts: 12, successes: 12, verificationPasses: 12, verificationFailures: 0 })
  })
  assert.equal(decision.selectedExecutor, 'CLAUDE')
  assert.equal(decision.routingFactors.historicalSuccess, 1)
})

test('pinned routing honors the requested executor and never silently switches', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec(),
    mode: 'PINNED',
    requestedExecutor: 'CLAUDE',
    importance: 'normal',
    availability: ALL_HEALTHY
  })
  assert.equal(decision.selectedExecutor, 'CLAUDE')
  assert.equal(decision.routingMode, 'PINNED')
  assert.equal(decision.requestedExecutor, 'CLAUDE')
})

test('pinned routing fails closed when the pinned executor is unavailable', () => {
  const router = new Zero3IntelligentTaskRouter()
  assert.throws(
    () => router.route({
      task: taskSpec(),
      mode: 'PINNED',
      requestedExecutor: 'CLAUDE',
      importance: 'normal',
      availability: { codex: { available: true, authenticated: true }, gemini: { available: true, authenticated: true }, claude: { available: false, authenticated: null } }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Zero3RoutingError)
      assert.equal(error.code, 'PINNED_EXECUTOR_UNAVAILABLE')
      assert.ok(error.message.includes('never silently changed'))
      return true
    }
  )
})

test('preferred routing honors the requested executor ahead of scored alternatives', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec({ type: 'RESEARCH' }),
    mode: 'PREFERRED',
    requestedExecutor: 'GEMINI',
    importance: 'normal',
    availability: ALL_HEALTHY
  })
  assert.equal(decision.selectedExecutor, 'GEMINI')
  assert.ok(decision.reason.includes('preferred executor GEMINI'))
})

test('preferred routing falls back to the best scored executor when the preference is unavailable', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec({ type: 'RESEARCH' }),
    mode: 'PREFERRED',
    requestedExecutor: 'GEMINI',
    importance: 'normal',
    availability: {
      codex: { available: true, authenticated: true },
      gemini: { available: false, authenticated: null },
      claude: { available: true, authenticated: true },
      zero3Api: { available: true, authenticated: true }
    }
  })
  assert.equal(decision.selectedExecutor, 'ZERO3_API')
  assert.ok(decision.reason.includes('preferred executor GEMINI unavailable'))
})

test('routing fails closed when no executor is eligible', () => {
  const router = new Zero3IntelligentTaskRouter()
  assert.throws(
    () => router.route({
      task: taskSpec(),
      mode: 'AUTO',
      requestedExecutor: null,
      importance: 'normal',
      availability: {
        codex: { available: false, authenticated: null },
        gemini: { available: false, authenticated: null },
        claude: { available: false, authenticated: null }
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Zero3RoutingError)
      assert.equal(error.code, 'NO_ELIGIBLE_EXECUTOR')
      assert.ok(error.rejections.some(entry => entry.executorId === 'CODEX'))
      return true
    }
  )
})

test('excluded executors are never re-selected within the same dispatch', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec(),
    mode: 'AUTO',
    requestedExecutor: null,
    importance: 'normal',
    availability: ALL_HEALTHY,
    exclusions: ['CODEX']
  })
  assert.equal(decision.selectedExecutor, 'CLAUDE')
  assert.ok(decision.rejectedExecutors.some(entry => entry.executorId === 'CODEX' && entry.reason.includes('previously failed')))
  assert.equal(decision.fallbackOrder.includes('CODEX'), false)
})

test('unprobed Zero3 API availability keeps the executor out of routing', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec({ type: 'RESEARCH' }),
    mode: 'AUTO',
    requestedExecutor: null,
    importance: 'normal',
    availability: {
      codex: { available: true, authenticated: true },
      gemini: { available: true, authenticated: true },
      claude: { available: true, authenticated: true }
    }
  })
  assert.notEqual(decision.selectedExecutor, 'ZERO3_API')
  assert.ok(
    decision.rejectedExecutors.some(entry => entry.executorId === 'ZERO3_API' && entry.reason === 'offline'),
    'an executor without an availability probe is treated as offline, never silently selected'
  )
})

test('invalid routing requests fail closed', () => {
  const router = new Zero3IntelligentTaskRouter()
  assert.throws(
    () => router.route({ task: taskSpec(), mode: 'PINNED', requestedExecutor: null, importance: 'normal', availability: ALL_HEALTHY }),
    (error: unknown) => error instanceof Zero3RoutingError && error.code === 'INVALID_ROUTING_REQUEST'
  )
  assert.throws(
    () => router.route({ task: taskSpec({ target: 'AUTO' }), mode: 'AUTO', requestedExecutor: null, importance: 'urgent' as never, availability: ALL_HEALTHY }),
    (error: unknown) => error instanceof Zero3RoutingError && error.code === 'INVALID_ROUTING_REQUEST'
  )
})

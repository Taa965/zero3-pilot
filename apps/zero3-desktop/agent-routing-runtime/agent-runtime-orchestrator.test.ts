import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { Zero3TaskSpecV2 } from './agent-contracts'
import type { Zero3ExecutionResultV2 } from './agent-contracts'
import { Zero3AgentRouter, type Zero3ProviderAvailability } from './agent-router'
import { Zero3AgentRuntimeOrchestrator, type Zero3AgentRuntimeDependencies } from './agent-runtime-orchestrator'
import { Zero3AgentTaskStore, type Zero3AgentTaskRecord } from './agent-task-store'
import { Zero3IntelligentTaskRouter } from './intelligent-router'
import { Zero3RoutingError } from './intelligent-router-contracts'
import { Zero3RoutingMetricsStore } from './routing-metrics-store'
import type { Zero3ReviewLoopStore } from './review-loop-store'

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `zero3-agent-dispatch-${label}-`))
}

function taskSpec(overrides: Partial<Zero3TaskSpecV2> = {}): Zero3TaskSpecV2 {
  return {
    protocol: 'zero3.pilot.task-spec.v2',
    taskId: 'task-dispatch-1',
    executionId: 'task-dispatch-1-exec-1',
    projectId: 'project-1',
    target: 'AUTO',
    type: 'IMPLEMENT',
    title: 'Dispatch probe task',
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

function resultFor(
  task: Zero3TaskSpecV2,
  provider: Zero3ExecutionResultV2['provider'],
  providerRuntime: Zero3ExecutionResultV2['providerRuntime'],
  status: Zero3ExecutionResultV2['status'],
  overrides: Partial<Zero3ExecutionResultV2> = {}
): Zero3ExecutionResultV2 {
  return {
    protocol: 'zero3.pilot.execution-result.v2',
    taskId: task.taskId,
    executionId: task.executionId,
    projectId: task.projectId,
    provider,
    providerRuntime,
    status,
    contextVersion: task.contextVersion,
    conversationId: `conv-${provider.toLowerCase()}`,
    summary: `${provider} finished with ${status}`,
    changedFiles: [],
    artifacts: [],
    git: null,
    verification: [],
    knownIssues: [],
    blockers: [],
    recommendedAction: status === 'COMPLETE' || status === 'PARTIAL' ? 'GPT_REVIEW' : 'RETRY',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...overrides
  }
}

const HEALTHY_CODEX_CLAUDE = () => ({
  codex: { available: true, authenticated: true },
  gemini: { available: false, authenticated: null },
  claude: { available: true, authenticated: true }
})

function fakeReviewStore(captured: { tasks: Zero3TaskSpecV2[] } = { tasks: [] }): Zero3ReviewLoopStore {
  return {
    createReview: async (task: Zero3TaskSpecV2) => {
      captured.tasks.push(structuredClone(task))
      return { reviewId: 'review-1' }
    },
    submitDecision: async () => {
      throw new Error('submitDecision is not expected in dispatch tests')
    }
  } as unknown as Zero3ReviewLoopStore
}

type DepsOptions = {
  codex: (task: Zero3TaskSpecV2) => Promise<Zero3ExecutionResultV2>
  claude?: (task: Zero3TaskSpecV2) => Promise<Zero3ExecutionResultV2>
  zero3Api?: (task: Zero3TaskSpecV2) => Promise<Zero3ExecutionResultV2>
  availability?: () => Zero3ProviderAvailability
  router?: Zero3IntelligentTaskRouter
  reviewStore?: Zero3ReviewLoopStore
  metrics?: Zero3RoutingMetricsStore
  maxAttempts?: number
  maxExecutorSwitches?: number
}

async function buildOrchestrator(label: string, options: DepsOptions) {
  const taskStore = new Zero3AgentTaskStore(await tempDir(label))
  const deps: Zero3AgentRuntimeDependencies = {
    router: new Zero3AgentRouter(),
    taskStore,
    reviewStore: options.reviewStore ?? fakeReviewStore(),
    antigravity: {
      startTurn: async () => ({ turnId: 'turn-1' }),
      waitTurn: async () => ({
        turnId: 'turn-1', logicalSessionId: 'gemini-session', conversationId: 'conv-gemini',
        status: 'COMPLETE', response: 'done', structuredOutput: { status: 'COMPLETE', summary: 'done' },
        error: null, rawStatus: 'COMPLETE'
      })
    },
    codex: { dispatchTask: options.codex },
    ...(options.claude ? { claude: { dispatchTask: options.claude } } : {}),
    ...(options.zero3Api ? { zero3Api: { dispatchTask: options.zero3Api } } : {}),
    availability: options.availability ?? HEALTHY_CODEX_CLAUDE,
    finalizeResult: async (_task, candidate) => candidate,
    intelligentRouting: {
      router: options.router ?? new Zero3IntelligentTaskRouter(),
      ...(options.metrics ? { metrics: options.metrics } : {}),
      maxAttempts: options.maxAttempts ?? 3,
      maxExecutorSwitches: options.maxExecutorSwitches ?? 2
    }
  }
  return { orchestrator: new Zero3AgentRuntimeOrchestrator(deps), taskStore }
}

const DISPATCH_CONTEXT = { targetLogicalSessionId: 'codex-task:probe', reviewSessionId: 'session-1' }

test('quota failure on Codex fails over to Claude while Task identity and the attempt ledger stay intact', async () => {
  const codexTasks: Zero3TaskSpecV2[] = []
  const metrics = new Zero3RoutingMetricsStore(await tempDir('metrics-fo'))
  const { orchestrator, taskStore } = await buildOrchestrator('failover', {
    metrics,
    codex: async task => {
      codexTasks.push(task)
      throw new Error('usage_limit_exceeded: Codex plan quota reached')
    },
    claude: async task => resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'COMPLETE')
  })
  const task = taskSpec({ taskId: 'task-fo-1', executionId: 'task-fo-1-exec-1' })

  const record: Zero3AgentTaskRecord = await orchestrator.dispatch(task, DISPATCH_CONTEXT)

  assert.equal(record.task.taskId, 'task-fo-1', 'executor switch must never change Task identity')
  assert.equal(record.task.executionId, 'task-fo-1-exec-1')
  assert.equal(record.state, 'COMPLETE')
  assert.equal(record.result?.provider, 'CLAUDE')
  assert.equal(record.resolvedTarget, 'CLAUDE')

  assert.equal(record.attempts?.length, 2)
  const [first, second] = record.attempts ?? []
  assert.equal(first.executor, 'CODEX')
  assert.equal(first.status, 'FAILED')
  assert.equal(first.attempt, 1)
  assert.ok(first.failureReason?.includes('usage_limit_exceeded'))
  assert.ok(first.failoverReason?.includes('FAILED') || first.failoverReason?.includes('error'))
  assert.equal(second.executor, 'CLAUDE')
  assert.equal(second.status, 'SUCCEEDED')
  assert.equal(second.attempt, 2)

  assert.equal(record.routingDecisions?.length, 2)
  assert.equal(record.routingDecisions?.[0].selectedExecutor, 'CODEX')
  assert.equal(record.routingDecisions?.[1].selectedExecutor, 'CLAUDE')
  assert.ok(
    record.routingDecisions?.[1].rejectedExecutors.some(entry => entry.executorId === 'CODEX' && entry.reason.includes('previously failed'))
  )

  const codexStats = (await metrics.snapshot()).executors['CODEX']?.['IMPLEMENT']
  const claudeStats = (await metrics.snapshot()).executors['CLAUDE']?.['IMPLEMENT']
  assert.equal(codexStats?.failures, 1)
  assert.equal(claudeStats?.successes, 1)
})

test('verification failure on the selected executor switches to the next eligible executor', async () => {
  const { orchestrator } = await buildOrchestrator('verify-fail', {
    codex: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'FAILED', {
      verification: [{ id: 'unit-tests', state: 'FAILED', command: 'cargo test', reason: '3 tests failed' }],
      summary: 'verification failed'
    }),
    claude: async task => resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'COMPLETE', {
      verification: [{ id: 'unit-tests', state: 'PASSED', command: 'cargo test' }]
    })
  })
  const task = taskSpec({ taskId: 'task-vf-1', executionId: 'task-vf-1-exec-1' })

  const record = await orchestrator.dispatch(task, DISPATCH_CONTEXT)

  assert.equal(record.state, 'COMPLETE')
  assert.equal(record.result?.provider, 'CLAUDE')
  assert.equal(record.attempts?.length, 2)
  assert.equal(record.attempts?.[0].executor, 'CODEX')
  assert.equal(record.attempts?.[0].status, 'FAILED')
  assert.equal(record.attempts?.[1].executor, 'CLAUDE')
  assert.equal(record.attempts?.[1].status, 'SUCCEEDED')
})

test('blocked executors wait for humans instead of silently switching providers', async () => {
  let claudeCalled = false
  const { orchestrator } = await buildOrchestrator('blocked', {
    codex: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'BLOCKED', {
      summary: 'auth_required: Codex login expired',
      recommendedAction: 'HUMAN_REVIEW',
      blockers: ['auth_required']
    }),
    claude: async task => {
      claudeCalled = true
      return resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'COMPLETE')
    }
  })
  const task = taskSpec({ taskId: 'task-bl-1', executionId: 'task-bl-1-exec-1' })

  const record = await orchestrator.dispatch(task, DISPATCH_CONTEXT)

  assert.equal(record.state, 'BLOCKED')
  assert.equal(record.result?.provider, 'CODEX')
  assert.equal(record.attempts?.length, 1)
  assert.equal(claudeCalled, false)
})

test('failover bounds stop executor ping-pong and failed executors are never retried', async () => {
  const attempts: string[] = []
  const { orchestrator, taskStore } = await buildOrchestrator('bounds', {
    maxAttempts: 3,
    maxExecutorSwitches: 2,
    availability: () => ({
      codex: { available: true, authenticated: true },
      gemini: { available: false, authenticated: null },
      claude: { available: true, authenticated: true },
      zero3Api: { available: true, authenticated: true }
    }),
    codex: async task => {
      attempts.push('CODEX')
      throw new Error(`codex transport lost (attempt ${attempts.length})`)
    },
    claude: async task => {
      attempts.push('CLAUDE')
      throw new Error(`claude transport lost (attempt ${attempts.length})`)
    },
    zero3Api: async task => {
      attempts.push('ZERO3_API')
      throw new Error(`zero3 api transport lost (attempt ${attempts.length})`)
    }
  })
  const task = taskSpec({ taskId: 'task-bd-1', executionId: 'task-bd-1-exec-1', type: 'RESEARCH' })

  await assert.rejects(() => orchestrator.dispatch(task, DISPATCH_CONTEXT), /codex transport lost/)

  const record = await taskStore.get('task-bd-1')
  assert.ok(record)
  assert.equal(record.state, 'FAILED')
  assert.equal(record.task.taskId, 'task-bd-1', 'Task identity survives every failed attempt')
  assert.deepEqual(attempts, ['ZERO3_API', 'CLAUDE', 'CODEX'])
  assert.equal(record.attempts?.length, 3)
  const executors = new Set(record.attempts?.map(entry => entry.executor))
  assert.equal(executors.size, 3, 'no executor may be retried within one dispatch')
  assert.ok(record.attempts?.every(entry => entry.failoverReason || entry.attempt === 3))
})

test('quota-exhausted status keeps the executor out of the first attempt entirely', async () => {
  let codexCalled = false
  const router = new Zero3IntelligentTaskRouter({
    catalogOverrides: [{ executorId: 'CODEX', status: 'quota_exhausted' }]
  })
  const { orchestrator } = await buildOrchestrator('quota-status', {
    router,
    codex: async task => {
      codexCalled = true
      return resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE')
    },
    claude: async task => resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'COMPLETE')
  })
  const task = taskSpec({ taskId: 'task-qs-1', executionId: 'task-qs-1-exec-1' })

  const record = await orchestrator.dispatch(task, DISPATCH_CONTEXT)

  assert.equal(codexCalled, false)
  assert.equal(record.result?.provider, 'CLAUDE')
  assert.equal(record.attempts?.length, 1)
  assert.equal(record.attempts?.[0].executor, 'CLAUDE')
})

test('pinned executors are honored and never silently switched, even on failure', async () => {
  let claudeCalled = false
  const { orchestrator } = await buildOrchestrator('pinned-fail', {
    codex: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'FAILED', { summary: 'codex repair failed' }),
    claude: async task => {
      claudeCalled = true
      return resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'COMPLETE')
    }
  })
  const task = taskSpec({ taskId: 'task-pf-1', executionId: 'task-pf-1-exec-1', target: 'CODEX' })

  const record = await orchestrator.dispatch(task, DISPATCH_CONTEXT)

  assert.equal(record.state, 'FAILED')
  assert.equal(record.result?.provider, 'CODEX')
  assert.equal(record.attempts?.length, 1)
  assert.equal(record.routingDecisions?.[0].routingMode, 'PINNED')
  assert.equal(claudeCalled, false, 'PINNED tasks must not be silently re-routed')
})

test('pinned executor unavailability surfaces a typed waiting-human error without creating a task record', async () => {
  const { orchestrator, taskStore } = await buildOrchestrator('pinned-off', {
    codex: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE'),
    availability: () => ({
      codex: { available: true, authenticated: true },
      gemini: { available: false, authenticated: null },
      claude: { available: false, authenticated: null }
    })
  })
  const task = taskSpec({ taskId: 'task-po-1', executionId: 'task-po-1-exec-1', target: 'CLAUDE' })

  await assert.rejects(
    () => orchestrator.dispatch(task, DISPATCH_CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof Zero3RoutingError)
      assert.equal(error.code, 'PINNED_EXECUTOR_UNAVAILABLE')
      return true
    }
  )
  assert.equal(await taskStore.get('task-po-1'), null)
})

test('preferred executor falls back to the best scored executor when it cannot run', async () => {
  const { orchestrator } = await buildOrchestrator('preferred', {
    availability: () => ({
      codex: { available: true, authenticated: true },
      gemini: { available: false, authenticated: null },
      claude: { available: true, authenticated: true },
      zero3Api: { available: true, authenticated: true }
    }),
    codex: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE'),
    zero3Api: async task => resultFor(task, 'ZERO3_API', 'ZERO3_API_SESSION', 'COMPLETE')
  })
  const task = taskSpec({ taskId: 'task-pr-1', executionId: 'task-pr-1-exec-1', type: 'RESEARCH' })

  const record = await orchestrator.dispatch(task, { ...DISPATCH_CONTEXT, preferredExecutor: 'GEMINI' })

  assert.equal(record.routingDecisions?.[0].routingMode, 'PREFERRED')
  assert.ok(record.routingDecisions?.[0].reason.includes('preferred executor GEMINI unavailable'))
  assert.equal(record.attempts?.[0].executor, 'ZERO3_API', 'cost/latency-aware AUTO picks the Zero3 API model for research')
  assert.equal(record.result?.provider, 'ZERO3_API')
})

test('zero3Api AUTO selection dispatches through the Zero3 API adapter', async () => {
  const { orchestrator } = await buildOrchestrator('zero3-api', {
    availability: () => ({
      codex: { available: true, authenticated: true },
      gemini: { available: false, authenticated: null },
      claude: { available: true, authenticated: true },
      zero3Api: { available: true, authenticated: true }
    }),
    codex: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE'),
    zero3Api: async task => resultFor(task, 'ZERO3_API', 'ZERO3_API_SESSION', 'COMPLETE')
  })
  const task = taskSpec({ taskId: 'task-za-1', executionId: 'task-za-1-exec-1', type: 'RESEARCH' })

  const record = await orchestrator.dispatch(task, DISPATCH_CONTEXT)

  assert.equal(record.result?.provider, 'ZERO3_API')
  assert.equal(record.result?.providerRuntime, 'ZERO3_API_SESSION')
  assert.equal(record.attempts?.[0].executor, 'ZERO3_API')
})

test('critical importance strengthens verification and forces a reviewer distinct from the executor', async () => {
  const captured = { tasks: [] as Zero3TaskSpecV2[] }
  const { orchestrator } = await buildOrchestrator('critical', {
    reviewStore: fakeReviewStore(captured),
    codex: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE')
  })
  const task = taskSpec({
    taskId: 'task-cr-1',
    executionId: 'task-cr-1-exec-1',
    importance: 'critical',
    reviewPolicy: { required: true, reviewer: 'CODEX', maxCycles: 2 }
  })

  const record = await orchestrator.dispatch(task, DISPATCH_CONTEXT)

  assert.equal(record.importance, 'critical')
  assert.equal(record.verificationProfile, 'critical')
  assert.equal(record.state, 'REVIEW_PENDING')
  assert.equal(captured.tasks.length, 1)
  assert.equal(captured.tasks[0].reviewPolicy.reviewer, 'GPT_WEB', 'a CODEX execution must not be reviewed by CODEX at critical importance')
})

test('legacy dispatch without intelligent routing stays single-shot and compatible', async () => {
  const taskStore = new Zero3AgentTaskStore(await tempDir('legacy'))
  const orchestrator = new Zero3AgentRuntimeOrchestrator({
    router: new Zero3AgentRouter(),
    taskStore,
    reviewStore: fakeReviewStore(),
    antigravity: { startTurn: async () => ({ turnId: 't' }), waitTurn: async () => { throw new Error('not used') } },
    codex: { dispatchTask: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE') },
    claude: { dispatchTask: async task => resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'COMPLETE') },
    availability: HEALTHY_CODEX_CLAUDE,
    finalizeResult: async (_task, candidate) => candidate
  })
  const task = taskSpec({ taskId: 'task-lg-1', executionId: 'task-lg-1-exec-1', target: 'CODEX' })

  const record = await orchestrator.dispatch(task, DISPATCH_CONTEXT)

  assert.equal(record.state, 'COMPLETE')
  assert.equal(record.result?.provider, 'CODEX')
  assert.equal(record.attempts?.length, 0, 'legacy records carry no attempt ledger')
  assert.equal(record.routingDecisions?.length, 0)
})

test('dispatchAgentTask without intelligent routing configuration fails closed', async () => {
  const taskStore = new Zero3AgentTaskStore(await tempDir('no-routing'))
  const orchestrator = new Zero3AgentRuntimeOrchestrator({
    router: new Zero3AgentRouter(),
    taskStore,
    reviewStore: fakeReviewStore(),
    antigravity: { startTurn: async () => ({ turnId: 't' }), waitTurn: async () => { throw new Error('not used') } },
    codex: { dispatchTask: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE') },
    availability: HEALTHY_CODEX_CLAUDE,
    finalizeResult: async (_task, candidate) => candidate
  })

  await assert.rejects(
    () => orchestrator.dispatchAgentTask(taskSpec(), DISPATCH_CONTEXT),
    /intelligent routing is not configured/
  )
})

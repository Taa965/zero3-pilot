import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { Zero3ExecutionResultV2, Zero3TaskSpecV2 } from './agent-contracts'
import type { Zero3ProviderAvailability } from './agent-router'
import { Zero3AgentRouter } from './agent-router'
import { Zero3AgentRuntimeOrchestrator } from './agent-runtime-orchestrator'
import { Zero3AgentTaskStore } from './agent-task-store'
import { Zero3IntelligentTaskRouter } from './intelligent-router'
import type { Zero3ReviewLoopStore } from './review-loop-store'
import {
  Zero3Zero3ApiAvailabilityProbe,
  type Zero3ApiAvailabilityPort,
  type Zero3ApiProbeProfile
} from './zero3-api-availability'
import {
  Zero3Zero3ApiTaskAdapter,
  parseZero3ApiStructuredOutput,
  type Zero3Zero3ApiSessionPort,
  type Zero3Zero3ApiTurnRequest,
  type Zero3Zero3ApiTurnResult
} from './zero3-api-task-adapter'

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `zero3-api-executor-${label}-`))
}

function profile(overrides: Partial<Zero3ApiProbeProfile> = {}): Zero3ApiProbeProfile {
  return {
    id: 'api-profile-1',
    name: 'Zero3 API test profile',
    protocol: 'openai_compatible',
    model: 'test-model',
    baseUrl: 'https://api.example.invalid/v1',
    hasApiKey: true,
    ...overrides
  }
}

function taskSpec(overrides: Partial<Zero3TaskSpecV2> = {}): Zero3TaskSpecV2 {
  return {
    protocol: 'zero3.pilot.task-spec.v2',
    taskId: 'task-zero3-api-1',
    executionId: 'task-zero3-api-1-exec-1',
    projectId: 'project-1',
    target: 'AUTO',
    type: 'RESEARCH',
    title: 'Zero3 API executor probe',
    goal: 'Read the existing architecture document and summarize it. Do not modify any code.',
    contextVersion: 1,
    importance: 'normal',
    worktreePath: process.cwd(),
    requirements: ['Summarize the architecture'],
    constraints: ['Do not modify files'],
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

const STRUCTURED_ANSWER = [
  'Here is the analysis.',
  '```json',
  JSON.stringify({
    status: 'COMPLETE',
    summary: 'The router chooses an executor from capability, availability and history.',
    output: { sections: ['router', 'executors', 'verification'] },
    knownIssues: ['none'],
    blockers: [],
    recommendedAction: 'GPT_REVIEW'
  }),
  '```'
].join('\n')

function fakeSessionPort(
  options: {
    profiles?: readonly Zero3ApiProbeProfile[]
    turn?: (request: Zero3Zero3ApiTurnRequest) => Promise<Zero3Zero3ApiTurnResult>
  } = {}
): { port: Zero3Zero3ApiSessionPort; requests: Zero3Zero3ApiTurnRequest[] } {
  const requests: Zero3Zero3ApiTurnRequest[] = []
  const port: Zero3Zero3ApiSessionPort = {
    listProfiles: async () => options.profiles ?? [profile()],
    runTurn: async request => {
      requests.push(request)
      if (options.turn) return options.turn(request)
      return {
        text: STRUCTURED_ANSWER,
        threadId: 'thread-zero3-api-1',
        model: 'test-model',
        profileId: request.profileId,
        usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 }
      }
    }
  }
  return { port, requests }
}

function fakeProbePort(
  options: {
    profiles?: readonly Zero3ApiProbeProfile[]
    usage?: Zero3ApiAvailabilityPort['usage']
    metrics?: Zero3ApiAvailabilityPort['metrics']
  } = {}
): Zero3ApiAvailabilityPort {
  return {
    listProfiles: async () => options.profiles ?? [profile()],
    usage: options.usage ?? (async () => ({ status: 'unsupported', remainingPercent: null })),
    ...(options.metrics ? { metrics: options.metrics } : {})
  }
}

function buildAdapter(
  options: {
    profiles?: readonly Zero3ApiProbeProfile[]
    turn?: (request: Zero3Zero3ApiTurnRequest) => Promise<Zero3Zero3ApiTurnResult>
    usage?: Zero3ApiAvailabilityPort['usage']
    profileId?: string | null
    stateFile?: string | null
  } = {}
) {
  const session = fakeSessionPort({ profiles: options.profiles, turn: options.turn })
  const probe = new Zero3Zero3ApiAvailabilityProbe({
    port: fakeProbePort({ profiles: options.profiles, usage: options.usage }),
    profileId: options.profileId ?? null,
    stateFile: options.stateFile ?? null
  })
  const adapter = new Zero3Zero3ApiTaskAdapter({ port: session.port, probe })
  return { adapter, probe, session }
}

test('structured model output is parsed, and unstructured prose is never presented as structured', () => {
  const parsed = parseZero3ApiStructuredOutput(STRUCTURED_ANSWER)
  assert.equal(parsed.structured?.status, 'COMPLETE')
  assert.deepEqual((parsed.structured?.output as Record<string, unknown>).sections, ['router', 'executors', 'verification'])

  const prose = parseZero3ApiStructuredOutput('The document describes a router. No JSON here.')
  assert.equal(prose.structured, null)
  assert.equal(prose.raw.startsWith('The document describes'), true)
})

test('a real Zero3 API turn produces a structured executor result with usage and timing', async () => {
  const { adapter, session } = buildAdapter()
  const result = await adapter.dispatchTask(taskSpec())

  assert.equal(result.protocol, 'zero3.pilot.execution-result.v2')
  assert.equal(result.provider, 'ZERO3_API')
  assert.equal(result.providerRuntime, 'ZERO3_API_SESSION')
  assert.equal(result.executorId, 'ZERO3_API:api-profile-1')
  assert.equal(result.status, 'COMPLETE')
  assert.equal(result.conversationId, 'thread-zero3-api-1')
  assert.ok(result.summary.includes('capability'))
  assert.deepEqual((result.output as Record<string, unknown>).sections, ['router', 'executors', 'verification'])
  assert.equal(result.usage?.totalTokens, 160)
  assert.equal(result.usage?.model, 'test-model')
  assert.equal(typeof result.timing?.executionLatencyMs, 'number')
  assert.equal(result.failure, null)
  assert.equal(result.taskId, 'task-zero3-api-1')
  assert.equal(result.executionId, 'task-zero3-api-1-exec-1')

  assert.equal(session.requests.length, 1)
  assert.equal(session.requests[0].sandbox, 'read-only', 'the Zero3 API executor never receives write access')
  assert.equal(session.requests[0].cwd, process.cwd())
  assert.ok(session.requests[0].prompt.includes('ZERO3_TASK_EXECUTION_ENVELOPE'))
})

test('an unstructured model answer is still a structured result, flagged as unstructured', async () => {
  const { adapter } = buildAdapter({
    turn: async request => ({ text: 'Just prose from the model.', threadId: 'thread-2', model: request.profileId, profileId: request.profileId })
  })
  const result = await adapter.dispatchTask(taskSpec())
  assert.equal(result.status, 'COMPLETE')
  assert.equal((result.output as Record<string, unknown>).structured, false)
  assert.equal((result.output as Record<string, unknown>).text, 'Just prose from the model.')
})

test('provider offline is a typed routable failure, not a silent success', async () => {
  const { adapter, probe } = buildAdapter({
    turn: async () => {
      throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434')
    }
  })
  const result = await adapter.dispatchTask(taskSpec())

  assert.equal(result.status, 'FAILED')
  assert.equal(result.provider, 'ZERO3_API')
  assert.equal(result.failure?.code, 'transport_lost')
  assert.equal(result.failure?.class, 'reroute')
  assert.equal(result.failure?.retryable, true)
  assert.equal((await probe.probe()).status, 'offline', 'an observed transport failure becomes probe evidence')
})

test('missing authentication is reported as an unauthenticated provider', async () => {
  const { adapter, probe } = buildAdapter({
    profiles: [profile({ protocol: 'anthropic', hasApiKey: false })],
    turn: async () => {
      throw new Error('upstream API HTTP 401: invalid api key')
    }
  })

  const availability = await probe.probe()
  assert.equal(availability.available, true)
  assert.equal(availability.authenticated, false)
  assert.equal(availability.status, 'unauthenticated')

  const result = await adapter.dispatchTask(taskSpec())
  assert.equal(result.status, 'FAILED')
  assert.equal(result.failure?.code, 'auth_required')
})

test('quota exhaustion is classified once and re-routes the task instead of blocking it', async () => {
  const { adapter, probe } = buildAdapter({
    turn: async () => {
      throw new Error('upstream API HTTP 402: insufficient balance, quota exhausted')
    }
  })
  const result = await adapter.dispatchTask(taskSpec())

  assert.equal(result.status, 'FAILED')
  assert.equal(result.failure?.code, 'quota_exhausted')
  assert.equal(result.failure?.class, 'reroute')
  const availability = await probe.probe()
  assert.equal(availability.status, 'quota_exhausted')
  assert.equal(availability.quotaExhausted, true)
})

test('a provider timeout is classified as a transport failure', async () => {
  const { adapter } = buildAdapter({
    turn: async () => {
      throw new Error('Codex Agent Kernel turn 超时')
    }
  })
  const result = await adapter.dispatchTask(taskSpec())
  assert.equal(result.status, 'FAILED')
  assert.equal(result.failure?.code, 'transport_lost')
  assert.equal(result.failure?.retryable, true)
})

test('an empty model response is a retryable same-executor failure', async () => {
  const { adapter } = buildAdapter({
    turn: async request => ({ text: '   ', threadId: 'thread-empty', model: 'test-model', profileId: request.profileId })
  })
  const result = await adapter.dispatchTask(taskSpec())
  assert.equal(result.status, 'FAILED')
  assert.equal(result.failure?.code, 'provider_error')
  assert.equal(result.failure?.class, 'retry_same_executor')
  assert.equal(result.blockers.length, 1)
})

test('a task without a workspace fails closed with a typed unsupported capability', async () => {
  const { adapter, session } = buildAdapter()
  const result = await adapter.dispatchTask(taskSpec({ worktreePath: null }))
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.failure?.code, 'unsupported')
  assert.equal(result.failure?.class, 'waiting_human')
  assert.equal(session.requests.length, 0, 'no provider turn may run without a workspace')
})

test('Zero3 API availability distinguishes unregistered, unauthenticated, ready, rate limited and quota exhausted', async () => {
  const unregistered = new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort({ profiles: [] }) })
  const missing = await unregistered.probe()
  assert.equal(missing.available, false)
  assert.equal(missing.status, 'unregistered')
  assert.equal(missing.registered, false)

  const keyRequired = new Zero3Zero3ApiAvailabilityProbe({
    port: fakeProbePort({ profiles: [profile({ protocol: 'google_gemini', hasApiKey: false })] })
  })
  const unauthenticated = await keyRequired.probe()
  assert.equal(unauthenticated.authenticated, false)
  assert.equal(unauthenticated.status, 'unauthenticated')

  const keyless = new Zero3Zero3ApiAvailabilityProbe({
    port: fakeProbePort({ profiles: [profile({ hasApiKey: false })] })
  })
  const unknownAuth = await keyless.probe()
  assert.equal(unknownAuth.available, true)
  assert.equal(unknownAuth.authenticated, null, 'an optional-key endpoint is unknown, never assumed authenticated')
  assert.equal(unknownAuth.status, 'ready')

  const ready = new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort() })
  const online = await ready.probe()
  assert.equal(online.available, true)
  assert.equal(online.authenticated, true)
  assert.equal(online.status, 'ready')

  await ready.noteOutcome({ failureCode: 'rate_limited', failureClass: 'reroute', detail: '429 too many requests' })
  const rateLimited = await ready.probe()
  assert.equal(rateLimited.status, 'rate_limited')
  assert.equal(rateLimited.rateLimited, true)

  await ready.noteOutcome({ failureCode: 'quota_exhausted', failureClass: 'reroute', detail: 'insufficient balance' })
  const exhausted = await ready.probe()
  assert.equal(exhausted.status, 'quota_exhausted')
  assert.equal(exhausted.quotaExhausted, true)

  await ready.noteSuccess()
  assert.equal((await ready.probe()).status, 'ready')
})

test('provider health survives a restart through the durable health snapshot', async () => {
  const stateFile = path.join(await tempDir('health'), 'zero3-api-health.json')
  const first = new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort(), stateFile })
  await first.noteOutcome({ failureCode: 'quota_exhausted', failureClass: 'reroute', detail: 'insufficient balance' })

  const second = new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort(), stateFile })
  const result = await second.probe()
  assert.equal(result.status, 'quota_exhausted')
})

test('availability latency reuses the routing metrics store instead of a second statistics source', async () => {
  const probe = new Zero3Zero3ApiAvailabilityProbe({
    port: fakeProbePort({
      metrics: async () => ({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        executors: {
          ZERO3_API: {
            RESEARCH: {
              attempts: 8,
              successes: 8,
              failures: 0,
              verificationPasses: 8,
              verificationFailures: 0,
              successRate: 1,
              verificationPassRate: 1,
              avgLatencyMs: 5_000,
              p50LatencyMs: 4_000,
              p95LatencyMs: 9_000,
              avgCostUsd: 0,
              totalCostUsd: 0
            }
          }
        }
      })
    })
  })
  const result = await probe.probe()
  assert.equal(result.latencyMs, 4_000)
  assert.equal(result.p95LatencyMs, 9_000)
})

test('probe-reported quota exhaustion keeps Zero3 API out of AUTO selection with a typed reason', () => {
  const router = new Zero3IntelligentTaskRouter()
  const decision = router.route({
    task: taskSpec(),
    mode: 'AUTO',
    requestedExecutor: null,
    importance: 'normal',
    availability: {
      codex: { available: true, authenticated: true },
      gemini: { available: false, authenticated: null },
      claude: { available: true, authenticated: true },
      zero3Api: { available: true, authenticated: true, status: 'quota_exhausted', detail: 'insufficient balance' }
    }
  })
  assert.notEqual(decision.selectedExecutor, 'ZERO3_API')
  assert.ok(decision.rejectedExecutors.some(entry => entry.executorId === 'ZERO3_API' && entry.reason === 'quota exhausted'))
})

test('a slow executor with real latency history scores below its catalog latency profile', () => {
  // Both executors are made equal apart from latency, so the only thing that can
  // move the decision is the observed latency evidence itself.
  const router = new Zero3IntelligentTaskRouter({
    catalogOverrides: [
      { executorId: 'CLAUDE', costWeight: 0.5, latencyWeight: 1, contextAffinity: 0.3 },
      { executorId: 'ZERO3_API', costWeight: 0.5, latencyWeight: 1, contextAffinity: 0.3 }
    ]
  })
  const base = {
    task: taskSpec(),
    mode: 'AUTO' as const,
    requestedExecutor: null,
    importance: 'normal' as const,
    availability: {
      codex: { available: true, authenticated: true },
      gemini: { available: false, authenticated: null },
      claude: { available: true, authenticated: true },
      zero3Api: { available: true, authenticated: true }
    } satisfies Zero3ProviderAvailability
  }
  const withoutHistory = router.route({ ...base, availability: { ...base.availability, codex: { available: false, authenticated: null } } })
  assert.equal(withoutHistory.selectedExecutor, 'ZERO3_API')

  const stats = (p50: number) => ({
    attempts: 10,
    successes: 8,
    failures: 2,
    verificationPasses: 8,
    verificationFailures: 2,
    successRate: 0.8,
    verificationPassRate: 0.8,
    avgLatencyMs: p50,
    p50LatencyMs: p50,
    p95LatencyMs: p50 * 2,
    avgCostUsd: 0,
    totalCostUsd: 0
  })
  const slow = router.route({
    ...base,
    availability: {
      ...base.availability,
      codex: { available: false, authenticated: null },
      zero3Api: { available: true, authenticated: true, latencyMs: 120_000 }
    },
    metrics: {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      executors: {
        ZERO3_API: { RESEARCH: stats(120_000) },
        CLAUDE: { RESEARCH: stats(2_000) }
      }
    }
  })
  assert.equal(slow.routingFactors.latency < withoutHistory.routingFactors.latency, true)
  assert.equal(slow.selectedExecutor, 'CLAUDE', 'observed latency must be able to change the executor decision')
})

// ---------------------------------------------------------------------------
// Unified dispatch: AUTO / PREFERRED / PINNED and real failover through the
// authoritative Task Ledger with the production Zero3 API adapter bound.
// ---------------------------------------------------------------------------

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

function fakeReviewStore(): Zero3ReviewLoopStore {
  return {
    createReview: async () => ({ reviewId: 'review-1' }),
    submitDecision: async () => {
      throw new Error('submitDecision is not expected in dispatch tests')
    }
  } as unknown as Zero3ReviewLoopStore
}

async function buildDispatch(options: {
  label: string
  availability: Zero3ProviderAvailability
  codex?: (task: Zero3TaskSpecV2) => Promise<Zero3ExecutionResultV2>
  claude?: (task: Zero3TaskSpecV2) => Promise<Zero3ExecutionResultV2>
  adapter?: Zero3Zero3ApiTaskAdapter
  maxAttempts?: number
  maxExecutorSwitches?: number
  probe?: Zero3Zero3ApiAvailabilityProbe
}) {
  const taskStore = new Zero3AgentTaskStore(await tempDir(options.label))
  const session = fakeSessionPort()
  const adapter = options.adapter ?? new Zero3Zero3ApiTaskAdapter({
    port: session.port,
    probe: options.probe ?? new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort() })
  })
  const orchestrator = new Zero3AgentRuntimeOrchestrator({
    router: new Zero3AgentRouter(),
    taskStore,
    reviewStore: fakeReviewStore(),
    antigravity: {
      startTurn: async () => ({ turnId: 'turn-1' }),
      waitTurn: async () => ({
        turnId: 'turn-1', logicalSessionId: 'gemini-session', conversationId: 'conv-gemini',
        status: 'COMPLETE', response: 'done', structuredOutput: { status: 'COMPLETE', summary: 'done' },
        error: null, rawStatus: 'COMPLETE'
      })
    },
    codex: { dispatchTask: options.codex ?? (async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE')) },
    ...(options.claude ? { claude: { dispatchTask: options.claude } } : {}),
    zero3Api: { dispatchTask: (task, skills, skillContext) => adapter.dispatchTask(task, skills, skillContext) },
    availability: () => options.availability,
    finalizeResult: async (_task, candidate) => candidate,
    intelligentRouting: {
      router: new Zero3IntelligentTaskRouter(),
      maxAttempts: options.maxAttempts ?? 3,
      maxExecutorSwitches: options.maxExecutorSwitches ?? 2
    }
  })
  return { orchestrator, taskStore, session }
}

const ZERO3_API_READY = (): Zero3ProviderAvailability => ({
  codex: { available: false, authenticated: null },
  gemini: { available: false, authenticated: null },
  claude: { available: false, authenticated: null },
  zero3Api: { available: true, authenticated: true, status: 'ready' }
})

test('AUTO dispatches a research task through the real Zero3 API adapter and records one authoritative result', async () => {
  const { orchestrator, taskStore } = await buildDispatch({ label: 'auto-zero3-api', availability: ZERO3_API_READY() })
  const task = taskSpec()

  const record = await orchestrator.dispatch(task, { targetLogicalSessionId: 'task:auto-zero3-api' })

  assert.equal(record.state, 'COMPLETE')
  assert.equal(record.resolvedTarget, 'ZERO3_API')
  assert.equal(record.result?.provider, 'ZERO3_API')
  assert.equal(record.result?.providerRuntime, 'ZERO3_API_SESSION')
  assert.equal(record.result?.executorId, 'ZERO3_API:api-profile-1')
  assert.equal(record.attempts?.length, 1)
  assert.equal(record.attempts?.[0].executor, 'ZERO3_API')
  assert.equal(record.attempts?.[0].status, 'SUCCEEDED')
  assert.equal(record.routingDecisions?.length, 1)
  assert.equal(record.routingDecisions?.[0].selectedExecutor, 'ZERO3_API')
  assert.equal(record.task.taskId, 'task-zero3-api-1')
  assert.equal((await taskStore.get('task-zero3-api-1'))?.result?.provider, 'ZERO3_API')
})

test('real failover keeps one Task identity when the Zero3 API executor runs out of quota', async () => {
  const session = fakeSessionPort({
    turn: async () => {
      throw new Error('insufficient balance: quota exhausted')
    }
  })
  const probe = new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort() })
  const adapter = new Zero3Zero3ApiTaskAdapter({ port: session.port, probe })
  const availability: Zero3ProviderAvailability = {
    codex: { available: false, authenticated: null },
    gemini: { available: false, authenticated: null },
    claude: { available: true, authenticated: true },
    zero3Api: { available: true, authenticated: true, status: 'ready' }
  }
  const { orchestrator, taskStore } = await buildDispatch({
    label: 'failover-zero3-api',
    availability,
    adapter,
    probe,
    claude: async task => resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'COMPLETE')
  })
  const task = taskSpec({ taskId: 'task-fo-zero3-api', executionId: 'task-fo-zero3-api-exec-1' })

  const record = await orchestrator.dispatch(task, { targetLogicalSessionId: 'task:failover-zero3-api' })

  assert.equal(record.state, 'COMPLETE')
  assert.equal(record.result?.provider, 'CLAUDE')
  assert.equal(record.task.taskId, 'task-fo-zero3-api', 'Task identity never changes across executors')
  assert.equal(record.task.executionId, 'task-fo-zero3-api-exec-1')
  assert.equal(record.attempts?.length, 2)
  const [first, second] = record.attempts ?? []
  assert.equal(first.executor, 'ZERO3_API')
  assert.equal(first.status, 'FAILED')
  assert.equal(first.failureCode, 'quota_exhausted')
  assert.equal(first.failureClass, 'reroute')
  assert.ok(first.failoverReason?.includes('quota_exhausted'))
  assert.equal(second.executor, 'CLAUDE')
  assert.equal(second.status, 'SUCCEEDED')
  assert.equal(record.routingDecisions?.length, 2)
  assert.equal(record.routingDecisions?.[1].selectedExecutor, 'CLAUDE')
  assert.ok(
    record.routingDecisions?.[1].rejectedExecutors.some(entry => entry.executorId === 'ZERO3_API' && entry.reason.includes('previously failed')),
    'the exhausted executor must be excluded from the re-route, not retried'
  )
  assert.equal((await taskStore.get('task-fo-zero3-api'))?.result?.provider, 'CLAUDE')
  assert.equal((await probe.probe()).status, 'quota_exhausted', 'availability learns from the real attempt')
})

test('Claude failing over to the Zero3 API executor keeps attempt history and shared context', async () => {
  const session = fakeSessionPort()
  const adapter = new Zero3Zero3ApiTaskAdapter({
    port: session.port,
    probe: new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort() })
  })
  const availability: Zero3ProviderAvailability = {
    codex: { available: false, authenticated: null },
    gemini: { available: false, authenticated: null },
    claude: { available: true, authenticated: true },
    zero3Api: { available: true, authenticated: true, status: 'ready' }
  }
  const { orchestrator } = await buildDispatch({
    label: 'failover-claude-zero3-api',
    availability,
    adapter,
    claude: async task => resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'FAILED', {
      summary: 'claude process exited with code 1'
    })
  })
  const task = taskSpec({ taskId: 'task-fo-c2z', executionId: 'task-fo-c2z-exec-1', type: 'DESIGN' })

  // CLAUDE is preferred for this task, so it runs first and the re-route proves
  // the Zero3 API executor continues the same task afterwards.
  const record = await orchestrator.dispatch(task, {
    targetLogicalSessionId: 'task:fo-c2z',
    routingMode: 'PREFERRED',
    preferredExecutor: 'CLAUDE'
  })

  assert.equal(record.result?.provider, 'ZERO3_API')
  assert.equal(record.routingDecisions?.[0].selectedExecutor, 'CLAUDE')
  assert.equal(record.attempts?.length, 2)
  assert.equal(record.attempts?.[0].executor, 'CLAUDE')
  assert.equal(record.attempts?.[1].executor, 'ZERO3_API')
  assert.equal(session.requests.length, 1)
  assert.ok(
    session.requests[0].prompt.includes('ZERO3_PRIOR_ATTEMPT_CONTEXT'),
    'the failover executor must receive the previous attempt context instead of starting from zero'
  )
  assert.ok(session.requests[0].prompt.includes('CLAUDE'))
  assert.equal(record.routingDecisions?.length, 2)
})

test('PINNED Zero3 API failures never silently switch executors', async () => {
  const session = fakeSessionPort({
    turn: async () => {
      throw new Error('insufficient balance')
    }
  })
  const adapter = new Zero3Zero3ApiTaskAdapter({
    port: session.port,
    probe: new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort() })
  })
  const { orchestrator } = await buildDispatch({
    label: 'pinned-zero3-api',
    availability: ZERO3_API_READY(),
    adapter,
    claude: async task => resultFor(task, 'CLAUDE', 'CLAUDE_CODE', 'COMPLETE')
  })
  const task = taskSpec({ taskId: 'task-pinned-z', executionId: 'task-pinned-z-exec-1', target: 'ZERO3_API' })

  const record = await orchestrator.dispatch(task, { targetLogicalSessionId: 'task:pinned-z' })

  assert.equal(record.resolvedTarget, 'ZERO3_API')
  assert.equal(record.attempts?.length, 1, 'a pinned executor is never swapped out')
  assert.equal(record.result?.provider, 'ZERO3_API')
  assert.equal(record.state, 'FAILED')
})

test('PREFERRED Zero3 API falls back to another executor when the preference cannot run', async () => {
  const session = fakeSessionPort({
    turn: async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    }
  })
  const adapter = new Zero3Zero3ApiTaskAdapter({
    port: session.port,
    probe: new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort() })
  })
  const availability: Zero3ProviderAvailability = {
    codex: { available: true, authenticated: true },
    gemini: { available: false, authenticated: null },
    // Only CODEX remains eligible behind the preference, so the fallback target
    // is deterministic instead of depending on which executor scores second.
    claude: { available: false, authenticated: null },
    zero3Api: { available: true, authenticated: true, status: 'ready' }
  }
  const { orchestrator } = await buildDispatch({
    label: 'preferred-zero3-api',
    availability,
    adapter,
    codex: async task => resultFor(task, 'CODEX', 'CODEX_LOCAL', 'COMPLETE')
  })
  const task = taskSpec({ taskId: 'task-preferred-z', executionId: 'task-preferred-z-exec-1' })

  const record = await orchestrator.dispatch(task, {
    targetLogicalSessionId: 'task:preferred-z',
    routingMode: 'PREFERRED',
    preferredExecutor: 'ZERO3_API'
  })

  assert.equal(record.routingDecisions?.[0].routingMode, 'PREFERRED')
  assert.equal(record.routingDecisions?.[0].selectedExecutor, 'ZERO3_API')
  assert.equal(record.attempts?.length, 2)
  assert.equal(record.attempts?.[0].executor, 'ZERO3_API')
  assert.equal(record.attempts?.[1].executor, 'CODEX')
  assert.equal(record.state, 'COMPLETE')
  assert.equal(record.task.taskId, 'task-preferred-z')
})

test('a retryable same-executor failure keeps the executor eligible but still respects the attempt bound', async () => {
  let turns = 0
  const session = fakeSessionPort({
    turn: async request => {
      turns += 1
      if (turns < 2) return { text: '', threadId: 'thread-x', model: 'test-model', profileId: request.profileId }
      return {
        text: STRUCTURED_ANSWER,
        threadId: 'thread-x',
        model: 'test-model',
        profileId: request.profileId,
        usage: { totalTokens: 10 }
      }
    }
  })
  const adapter = new Zero3Zero3ApiTaskAdapter({
    port: session.port,
    probe: new Zero3Zero3ApiAvailabilityProbe({ port: fakeProbePort() })
  })
  const { orchestrator } = await buildDispatch({
    label: 'retry-same-executor',
    availability: ZERO3_API_READY(),
    adapter,
    maxAttempts: 2
  })
  const task = taskSpec({ taskId: 'task-retry-z', executionId: 'task-retry-z-exec-1' })

  const record = await orchestrator.dispatch(task, { targetLogicalSessionId: 'task:retry-z' })

  assert.equal(record.state, 'COMPLETE')
  assert.equal(record.attempts?.length, 2)
  assert.equal(record.attempts?.[0].executor, 'ZERO3_API')
  assert.equal(record.attempts?.[0].failureClass, 'retry_same_executor')
  assert.equal(record.attempts?.[1].executor, 'ZERO3_API', 'a same-executor retry is not forced onto another provider')
  assert.equal(record.task.taskId, 'task-retry-z')
})

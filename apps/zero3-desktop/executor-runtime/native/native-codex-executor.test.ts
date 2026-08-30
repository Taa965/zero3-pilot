import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { ZERO3_EXECUTOR_CONTRACT, ZERO3_HANDOFF_PROTOCOL, type ExecutorEvent } from '../executor-types.ts'
import {
  NativeCodexAppServerDriver,
  type NativeCodexAppServerEvent,
  type NativeCodexAppServerTransport
} from './native-app-server-driver.ts'
import { NativeCodexContextLostError, NativeCodexExecutor } from './native-codex-executor.ts'
import type { NativeCodexDriver, NativeCodexDriverEvent } from './native-driver.ts'
import { nativeCodexAppServerEnv, resolveNativeSubscriptionCodexHome } from './native-home.ts'

class FakeDriver implements NativeCodexDriver {
  starts = 0
  resumes = 0
  permissions = 0
  cancelled = 0
  closed = 0
  resumeError: Error | undefined
  async probe() { return { available: true as const, reason: 'chatgpt_subscription' as const, planType: 'plus' } }
  async startThread() { this.starts += 1; return { threadId: 'thread-fake' } }
  async resumeThread() { this.resumes += 1; if (this.resumeError) throw this.resumeError }
  async *prompt(): AsyncIterable<NativeCodexDriverEvent> {
    yield { type: 'message', text: 'ok' }
    yield { type: 'failure', reason: 'rate_limit_reached', message: 'rate' }
    yield { type: 'completed', outcome: 'failed' }
  }
  async respondPermission() { this.permissions += 1 }
  async cancel() { this.cancelled += 1 }
  async close() { this.closed += 1 }
}

type TransportScenario = 'normal' | 'resume-missing' | 'crash' | 'quota' | 'rate' | 'auth' | 'no-capabilities'

class FakeAppServerTransport implements NativeCodexAppServerTransport {
  readonly requests: Array<{ method: string; params: unknown }> = []
  readonly responses: unknown[] = []
  readonly #listeners = new Set<(event: NativeCodexAppServerEvent) => void>()
  approved = false
  interrupted = false

  constructor(readonly scenario: TransportScenario = 'normal') {}

  subscribe(listener: (event: NativeCodexAppServerEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit(event: NativeCodexAppServerEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus', accessToken: 'MUST_NOT_ESCAPE' } }
    if (method === 'modelProvider/capabilities/read') {
      if (this.scenario === 'no-capabilities') throw new Error('method unsupported')
      return { capabilities: { hidden: 'provider-private' } }
    }
    if (method === 'account/rateLimits/read') return { rateLimits: { rateLimitReachedType: null }, spendControlReached: false }
    if (method === 'thread/start') {
      assert.equal(input.approvalPolicy, 'on-request')
      assert.equal(input.sandbox, 'workspace-write')
      return { thread: { id: 'thread-1' } }
    }
    if (method === 'thread/resume') {
      if (this.scenario === 'resume-missing') throw new Error('thread context missing')
      return { thread: { id: String(input.threadId) } }
    }
    if (method === 'turn/start') {
      if (this.scenario === 'quota') throw new Error('quota exhausted')
      if (this.scenario === 'rate') throw new Error('429 rate limit reached')
      if (this.scenario === 'auth') throw new Error('401 authentication required')
      queueMicrotask(() => {
        if (this.scenario === 'crash') {
          this.emit({ kind: 'lifecycle', state: 'stopped', detail: 'exit code=7' })
          return
        }
        this.emit({
          kind: 'request',
          id: 'approval-1',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1', turnId: 'turn-1', reason: 'run test', command: ['node', 'test'],
            cwd: '/workspace', availableDecisions: ['accept', 'acceptForSession', 'decline']
          }
        })
      })
      return { turn: { id: 'turn-1' } }
    }
    if (method === 'thread/read') {
      if (!this.approved) {
        return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'inProgress', items: [{ id: 'tool-1', type: 'commandExecution', status: 'inProgress' }] }] } }
      }
      return {
        thread: {
          id: 'thread-1',
          turns: [{
            id: 'turn-1', status: 'completed', usage: { inputTokens: 10, outputTokens: 5 },
            items: [
              { id: 'tool-1', type: 'commandExecution', status: 'completed' },
              { id: 'agent-1', type: 'agentMessage', text: 'done' }
            ]
          }]
        }
      }
    }
    if (method === 'turn/interrupt') { this.interrupted = true; return {} }
    throw new Error(`unexpected method: ${method}`)
  }

  async respondToServerRequest(value: unknown): Promise<unknown> {
    this.responses.push(value)
    const root = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const result = root.result && typeof root.result === 'object' ? root.result as Record<string, unknown> : {}
    this.approved = result.decision === 'accept' || result.decision === 'acceptForSession'
    return { ok: true }
  }
}

const startContext = {
  contract: ZERO3_EXECUTOR_CONTRACT,
  identity: {
    taskId: 'task-1', executionId: 'execution-1', workspace: '/workspace', objective: 'test', constraints: [], acceptanceCriteria: []
  },
  policy: { permissionProfile: 'standard' as const, approvalRequired: true },
  generation: 1
}

test('Native executor implements frozen contract and normalizes failures with correct provenance', async () => {
  const driver = new FakeDriver()
  const executor = new NativeCodexExecutor(driver, { now: () => '2026-08-30T00:00:00.000Z' })
  assert.deepEqual(await executor.probe(), { executorId: 'native-codex', status: 'ready', detail: 'chatgpt_subscription' })
  const session = await executor.start(startContext)
  assert.equal(driver.starts, 1)
  assert.equal(session.generation, 1)
  const events: ExecutorEvent[] = []
  for await (const event of executor.prompt(session, { kind: 'prompt', clientRequestId: 'client-1', text: 'hello' })) events.push(event)
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3])
  assert.equal(events[1].type, 'failure')
  if (events[1].type === 'failure') {
    assert.equal(events[1].failure.code, 'rate_limited')
    assert.equal(events[1].failure.source, 'native-codex')
  }
})

test('resume failure becomes context_lost and never silently starts a replacement thread', async () => {
  const driver = new FakeDriver()
  driver.resumeError = new Error('thread missing')
  const executor = new NativeCodexExecutor(driver)
  await assert.rejects(
    executor.resume(
      { executorId: 'native-codex', sessionId: 'thread-old', generation: 2 },
      { protocol: ZERO3_HANDOFF_PROTOCOL, checkpointHash: 'a'.repeat(64), generation: 2, workspaceFingerprint: 'b'.repeat(64) }
    ),
    error => error instanceof NativeCodexContextLostError && error.failure.code === 'context_lost'
  )
  assert.equal(driver.resumes, 1)
  assert.equal(driver.starts, 0)
})

test('native Codex home is selected per app-server instance without mutating process-global CODEX_HOME', () => {
  assert.equal(resolveNativeSubscriptionCodexHome({ env: { CODEX_HOME: '/zero3/isolated' }, homeDir: '/users/alice' }), path.join('/users/alice', '.codex'))
  const env = { CODEX_HOME: '/zero3/isolated', KEEP: 'yes' }
  const appServerEnv = nativeCodexAppServerEnv('/users/alice/.codex', env)
  assert.equal(env.CODEX_HOME, '/zero3/isolated')
  assert.equal(appServerEnv.CODEX_HOME, '/users/alice/.codex')
  assert.equal(appServerEnv.KEEP, 'yes')
})

test('injected Zero3CodexAppServer transport probes subscription/capabilities and preserves approval + sandbox semantics', async () => {
  const transport = new FakeAppServerTransport()
  const driver = new NativeCodexAppServerDriver({ transport, turnTimeoutMs: 2_000, pollMs: 1 })
  const executor = new NativeCodexExecutor(driver, { now: () => '2026-08-30T00:00:00.000Z' })
  assert.equal((await executor.probe()).status, 'ready')
  assert.deepEqual(transport.requests.slice(0, 3).map(request => request.method), [
    'account/read', 'modelProvider/capabilities/read', 'account/rateLimits/read'
  ])
  const session = await executor.start(startContext)
  const events: ExecutorEvent[] = []
  for await (const event of executor.prompt(session, { kind: 'prompt', clientRequestId: 'client-real', text: 'run' })) {
    events.push(event)
    if (event.type === 'permission.requested') {
      assert.equal(event.allowSessionApproval, true)
      await executor.respondPermission(session, { requestId: event.requestId, decision: 'approve_session' })
    }
  }
  assert.equal(events.some(event => event.type === 'tool.started'), true)
  assert.equal(events.some(event => event.type === 'message' && event.text === 'done'), true)
  assert.equal(events.some(event => event.type === 'usage.updated' && event.usage.inputTokens === 10), true)
  const completed = events.at(-1)
  assert.equal(completed?.type, 'completed')
  if (completed?.type === 'completed') assert.equal(completed.outcome, 'succeeded')
  assert.deepEqual(transport.responses.at(-1), { id: 'approval-1', result: { decision: 'acceptForSession' } })
})

test('capability probe failure is unsupported without exposing raw provider data', async () => {
  const executor = new NativeCodexExecutor(new NativeCodexAppServerDriver({ transport: new FakeAppServerTransport('no-capabilities') }))
  assert.equal((await executor.probe()).status, 'unsupported')
})

test('injected transport lifecycle stop during turn maps to process_crash', async () => {
  const transport = new FakeAppServerTransport('crash')
  const executor = new NativeCodexExecutor(new NativeCodexAppServerDriver({ transport, turnTimeoutMs: 500, pollMs: 1 }))
  const session = await executor.start(startContext)
  const events: ExecutorEvent[] = []
  for await (const event of executor.prompt(session, { kind: 'prompt', clientRequestId: 'crash', text: 'run' })) events.push(event)
  const failure = events.find(event => event.type === 'failure')
  assert.ok(failure && failure.type === 'failure')
  if (failure?.type === 'failure') assert.equal(failure.failure.code, 'process_crash')
})

test('quota, rate-limit and auth failures normalize at the Native boundary', async () => {
  for (const [scenario, code] of [['quota','quota_exhausted'],['rate','rate_limited'],['auth','auth_required']] as const) {
    const transport = new FakeAppServerTransport(scenario)
    const executor = new NativeCodexExecutor(new NativeCodexAppServerDriver({ transport, turnTimeoutMs: 500, pollMs: 1 }))
    const session = await executor.start(startContext)
    const events: ExecutorEvent[] = []
    for await (const event of executor.prompt(session, { kind: 'prompt', clientRequestId: scenario, text: scenario })) events.push(event)
    const failure = events.find(event => event.type === 'failure')
    assert.ok(failure && failure.type === 'failure')
    if (failure?.type === 'failure') {
      assert.equal(failure.failure.code, code)
      assert.equal(failure.failure.source, 'native-codex')
    }
  }
})

test('transport resume context loss fails closed with no thread/start fallback', async () => {
  const transport = new FakeAppServerTransport('resume-missing')
  const executor = new NativeCodexExecutor(new NativeCodexAppServerDriver({ transport }))
  await assert.rejects(
    executor.resume(
      { executorId: 'native-codex', sessionId: 'thread-old', generation: 1 },
      { protocol: ZERO3_HANDOFF_PROTOCOL, checkpointHash: 'a'.repeat(64), generation: 1, workspaceFingerprint: 'b'.repeat(64) }
    ),
    error => error instanceof NativeCodexContextLostError
  )
  assert.equal(transport.requests.filter(request => request.method === 'thread/start').length, 0)
  assert.equal(transport.requests.filter(request => request.method === 'thread/resume').length, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeExecutor,
  mapClaudeFailure,
  type ClaudeCliRunRequest,
  type ClaudeCliRunResult,
  type ClaudeCliRunner
} from './claude-executor.ts'
import { ZERO3_EXECUTOR_CONTRACT, type ExecutorStartContext } from '../executor-types.ts'

class QueueRunner implements ClaudeCliRunner {
  readonly requests: ClaudeCliRunRequest[] = []

  constructor(private readonly results: ClaudeCliRunResult[]) {}

  async run(request: ClaudeCliRunRequest): Promise<ClaudeCliRunResult> {
    this.requests.push(request)
    const result = this.results.shift()
    if (!result) throw new Error('no queued Claude CLI result')
    return result
  }
}

const baseContext: ExecutorStartContext = {
  contract: ZERO3_EXECUTOR_CONTRACT,
  identity: {
    taskId: 'task-claude',
    executionId: 'execution-claude',
    workspace: '/tmp/zero3-claude-test',
    objective: 'implement the task',
    constraints: [],
    acceptanceCriteria: []
  },
  policy: { permissionProfile: 'standard', approvalRequired: false },
  generation: 1
}

test('Claude failure mapping distinguishes quota, rate limit, and context exhaustion', () => {
  assert.equal(mapClaudeFailure({ exitCode: 1, stdout: '', stderr: 'Usage limit reached for this billing period' }), 'quota_exhausted')
  assert.equal(mapClaudeFailure({ exitCode: 1, stdout: '', stderr: '429 rate_limit_error: too many requests' }), 'rate_limited')
  assert.equal(mapClaudeFailure({ exitCode: 1, stdout: '', stderr: 'model_context_window_exceeded: prompt is too long' }), 'context_exhausted')
  assert.equal(mapClaudeFailure({ exitCode: 1, stdout: '', stderr: '529 overloaded_error' }), 'provider_overloaded')
  assert.equal(mapClaudeFailure({ exitCode: 1, stdout: '', stderr: '401 authentication_failed' }), 'auth_required')
})

test('Claude executor captures CLI session id and resumes subsequent prompts', async () => {
  const runner = new QueueRunner([
    { exitCode: 0, stdout: '{"result":"first","session_id":"session-real","usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":0.01}', stderr: '' },
    { exitCode: 0, stdout: '{"result":"second","session_id":"session-real"}', stderr: '' }
  ])
  const executor = new ClaudeExecutor({ runner, now: () => '2026-09-08T00:00:00.000Z' })
  const session = await executor.start(baseContext)
  const first = []
  for await (const event of executor.prompt(session, { kind: 'prompt', clientRequestId: 'one', text: 'first prompt' })) first.push(event)
  const second = []
  for await (const event of executor.prompt(session, { kind: 'prompt', clientRequestId: 'two', text: 'second prompt' })) second.push(event)

  assert.equal(first.at(-1)?.type, 'completed')
  assert.equal(second.at(-1)?.type, 'completed')
  assert.deepEqual(runner.requests[0]?.args.slice(0, 5), ['-p', 'first prompt', '--output-format', 'json', '--permission-mode'])
  assert.equal(runner.requests[0]?.args.includes('--resume'), false)
  const resumeIndex = runner.requests[1]?.args.indexOf('--resume') ?? -1
  assert.ok(resumeIndex >= 0)
  assert.equal(runner.requests[1]?.args[resumeIndex + 1], 'session-real')
})

test('Claude executor keeps approval-required sessions fail-closed', async () => {
  const runner = new QueueRunner([{ exitCode: 0, stdout: '{"result":"ok","session_id":"session"}', stderr: '' }])
  const executor = new ClaudeExecutor({ runner })
  const session = await executor.start({ ...baseContext, policy: { permissionProfile: 'elevated', approvalRequired: true } })
  for await (const _event of executor.prompt(session, { kind: 'prompt', clientRequestId: 'one', text: 'do work' })) {}
  const modeIndex = runner.requests[0]?.args.indexOf('--permission-mode') ?? -1
  assert.equal(runner.requests[0]?.args[modeIndex + 1], 'dontAsk')
})

test('Claude quota failure is emitted with the canonical executor code', async () => {
  const runner = new QueueRunner([{ exitCode: 1, stdout: '', stderr: 'credit balance is too low; usage limit reached' }])
  const executor = new ClaudeExecutor({ runner })
  const session = await executor.start(baseContext)
  const events = []
  for await (const event of executor.prompt(session, { kind: 'prompt', clientRequestId: 'one', text: 'work' })) events.push(event)
  assert.equal(events[0]?.type, 'failure')
  if (events[0]?.type === 'failure') assert.equal(events[0].failure.code, 'quota_exhausted')
  assert.deepEqual(events.at(-1), { type: 'completed', sequence: 2, at: events.at(-1)?.at, outcome: 'failed' })
})

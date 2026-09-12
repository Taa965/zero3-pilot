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

test('a logged-out Claude CLI probes as installed-but-unauthorized, not as missing', async () => {
  // What `claude auth status` really prints when no login exists: JSON on
  // stdout, exit code 1, and not one word the failure mapper recognises.
  const runner = new QueueRunner([{
    exitCode: 1,
    stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
    stderr: ''
  }])
  const probe = await new ClaudeExecutor({ runner }).probe()
  assert.equal(probe.status, 'auth_required')
  assert.deepEqual(runner.requests[0].args, ['auth', 'status'])
})

test('a logged-in Claude CLI probes as ready even when the exit code disagrees', async () => {
  const runner = new QueueRunner([{ exitCode: 1, stdout: '{"loggedIn":true,"authMethod":"claudeai"}', stderr: '' }])
  assert.equal((await new ClaudeExecutor({ runner }).probe()).status, 'ready')
})

test('only a failed spawn makes the Claude CLI unavailable', async () => {
  const missing: ClaudeCliRunner = {
    run: async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }
  }
  const missingProbe = await new ClaudeExecutor({ runner: missing }).probe()
  assert.equal(missingProbe.status, 'unavailable')
  assert.match(missingProbe.detail ?? '', /ENOENT/)

  // An unrecognised answer still came from a binary that exists, so the picker
  // must not report it as 未安装.
  const confused = new QueueRunner([{ exitCode: 1, stdout: '', stderr: "unknown command 'auth'" }])
  const confusedProbe = await new ClaudeExecutor({ runner: confused }).probe()
  assert.equal(confusedProbe.status, 'auth_required')
  assert.match(confusedProbe.detail ?? '', /unknown command/)
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

test('a prompt beyond the Windows command-line limit travels on stdin instead of argv', async () => {
  const longPrompt = 'x'.repeat(40_000)
  const stdout = JSON.stringify({ result: 'ok', session_id: 'session-long' })
  const longRunner = new QueueRunner([{ exitCode: 0, stdout, stderr: '' }])
  const longExecutor = new ClaudeExecutor({ runner: longRunner })
  const longSession = await longExecutor.start(baseContext)
  for await (const _event of longExecutor.prompt(longSession, { kind: 'prompt', clientRequestId: 'long', text: longPrompt })) {}

  const request = longRunner.requests[0]
  assert.equal(request?.args.includes(longPrompt), false, 'the prompt must not be an argv element')
  assert.equal(request?.stdin, longPrompt, 'the prompt must be delivered on stdin')
  assert.deepEqual(request?.args.slice(0, 2), ['-p', '--output-format'])

  // A short prompt keeps the argv path, which is what the CLI documents.
  const shortRunner = new QueueRunner([{ exitCode: 0, stdout, stderr: '' }])
  const shortExecutor = new ClaudeExecutor({ runner: shortRunner })
  const shortSession = await shortExecutor.start(baseContext)
  for await (const _event of shortExecutor.prompt(shortSession, { kind: 'prompt', clientRequestId: 'short', text: 'short prompt' })) {}
  assert.deepEqual(shortRunner.requests[0]?.args.slice(0, 2), ['-p', 'short prompt'])
  assert.equal(shortRunner.requests[0]?.stdin, undefined)
})

test('Claude permission mode preserves workspace-write semantics without bypassing read-only', async () => {
  const writeRunner = new QueueRunner([{ exitCode: 0, stdout: '{"result":"ok","session_id":"session-write"}', stderr: '' }])
  const writeExecutor = new ClaudeExecutor({ runner: writeRunner })
  const writeSession = await writeExecutor.start({ ...baseContext, policy: { permissionProfile: 'elevated', approvalRequired: true } })
  for await (const _event of writeExecutor.prompt(writeSession, { kind: 'prompt', clientRequestId: 'write', text: 'do work' })) {}
  const writeModeIndex = writeRunner.requests[0]?.args.indexOf('--permission-mode') ?? -1
  assert.equal(writeRunner.requests[0]?.args[writeModeIndex + 1], 'acceptEdits')

  const readRunner = new QueueRunner([{ exitCode: 0, stdout: '{"result":"ok","session_id":"session-read"}', stderr: '' }])
  const readExecutor = new ClaudeExecutor({ runner: readRunner })
  const readSession = await readExecutor.start({ ...baseContext, policy: { permissionProfile: 'read_only', approvalRequired: false } })
  for await (const _event of readExecutor.prompt(readSession, { kind: 'prompt', clientRequestId: 'read', text: 'inspect only' })) {}
  const readModeIndex = readRunner.requests[0]?.args.indexOf('--permission-mode') ?? -1
  assert.equal(readRunner.requests[0]?.args[readModeIndex + 1], 'dontAsk')
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

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ZERO3_EXECUTOR_CONTRACT,
  type ExecutorEvent,
  type ExecutorProbe,
  type ExecutorSession,
  type ExecutorStartContext
} from '../executor-runtime/executor-types.ts'
import {
  ZERO3_TASK_SPEC_V2,
  type Zero3TaskSpecV2
} from './agent-contracts'
import {
  Zero3ClaudeTaskAdapter,
  zero3ClaudeProjectMcpConfig,
  type Zero3ClaudeExecutorPort
} from './claude-task-adapter'

function task(): Zero3TaskSpecV2 {
  return {
    protocol: ZERO3_TASK_SPEC_V2,
    taskId: 'task-claude-1',
    executionId: 'exec-claude-1',
    projectId: 'project-a',
    target: 'CLAUDE',
    type: 'IMPLEMENT',
    title: 'Implement with Claude',
    goal: 'Implement the requested change without losing handoff context.',
    contextVersion: 3,
    repo: 'owner/repo',
    baseSha: '1111111111111111111111111111111111111111',
    branch: 'feature/claude',
    worktreePath: '/tmp/zero3-claude-worktree',
    requirements: ['preserve prior handoff context'],
    constraints: ['stay in the selected worktree'],
    requiredContracts: [],
    inputArtifacts: [],
    expectedOutputs: [],
    verification: [],
    completionGate: ['git.clean'],
    reviewPolicy: { required: true, reviewer: 'GPT_WEB', maxCycles: 2 },
    createdBySessionId: 'gpt-entry-1',
    createdAt: '2026-09-08T00:00:00.000Z'
  }
}

class FakeClaudeExecutor implements Zero3ClaudeExecutorPort {
  starts: ExecutorStartContext[] = []
  prompts: string[] = []
  closed = false

  async probe(): Promise<ExecutorProbe> {
    return { executorId: 'claude', status: 'ready' }
  }

  async start(context: ExecutorStartContext): Promise<ExecutorSession> {
    this.starts.push(context)
    return { executorId: 'claude', sessionId: 'claude-session-1', generation: context.generation, startedAt: '2026-09-08T00:00:01.000Z' }
  }

  async *prompt(_session: ExecutorSession, input: { kind: 'prompt'; clientRequestId: string; text: string }): AsyncIterable<ExecutorEvent> {
    this.prompts.push(input.text)
    yield { type: 'message', sequence: 1, at: '2026-09-08T00:00:02.000Z', text: 'Claude completed the task.' }
    yield { type: 'completed', sequence: 2, at: '2026-09-08T00:00:03.000Z', outcome: 'succeeded' }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

test('Claude project MCP config is strictly scoped to the TaskSpec project', () => {
  const config = JSON.parse(zero3ClaudeProjectMcpConfig(task(), {
    serverPath: '/opt/zero3/project-context-server.mjs',
    stateDir: '/var/lib/zero3/project-context'
  }))
  const server = config.mcpServers.zero3_project_context
  assert.equal(server.type, 'stdio')
  assert.equal(server.command, process.execPath)
  assert.deepEqual(server.args, ['/opt/zero3/project-context-server.mjs'])
  assert.equal(server.env.ZERO3_ACTIVE_PROJECT_ID, 'project-a')
  assert.equal(server.env.ZERO3_PROJECT_CONTEXT_DIR, '/var/lib/zero3/project-context')
  assert.equal(server.env.ELECTRON_RUN_AS_NODE, '1')
})

test('Claude task dispatch requires handoff_get before execution and preserves result identity', async () => {
  const fake = new FakeClaudeExecutor()
  let configuredMcp: string | undefined
  const adapter = new Zero3ClaudeTaskAdapter({
    serverPath: '/opt/zero3/project-context-server.mjs',
    stateDir: '/var/lib/zero3/project-context',
    executorFactory: mcpConfig => {
      configuredMcp = mcpConfig
      return fake
    },
    now: () => '2026-09-08T00:00:04.000Z'
  })

  const result = await adapter.dispatchTask(task())
  assert.ok(configuredMcp)
  assert.equal(fake.starts[0].contract, ZERO3_EXECUTOR_CONTRACT)
  assert.equal(fake.starts[0].identity.taskId, 'task-claude-1')
  assert.equal(fake.starts[0].identity.workspace, '/tmp/zero3-claude-worktree')
  assert.match(fake.prompts[0], /mcp__zero3_project_context__handoff_get/)
  assert.match(fake.prompts[0], /task-claude-1/)
  assert.match(fake.prompts[0], /mcp__zero3_project_context__project_get_context/)
  assert.match(fake.prompts[0], /project-a/)
  assert.equal(fake.closed, true)
  assert.equal(result.provider, 'CLAUDE')
  assert.equal(result.providerRuntime, 'CLAUDE_CODE')
  assert.equal(result.projectId, 'project-a')
  assert.equal(result.taskId, 'task-claude-1')
  assert.equal(result.executionId, 'exec-claude-1')
  assert.equal(result.contextVersion, 3)
  assert.equal(result.status, 'COMPLETE')
})

test('Claude availability exposes authenticated and unavailable probe states without AUTO guessing', async () => {
  const ready = new Zero3ClaudeTaskAdapter({
    serverPath: '/opt/zero3/project-context-server.mjs',
    stateDir: '/var/lib/zero3/project-context',
    executorFactory: () => new FakeClaudeExecutor()
  })
  assert.deepEqual(await ready.availability(), { available: true, authenticated: true })

  const unavailable = new Zero3ClaudeTaskAdapter({
    serverPath: '/opt/zero3/project-context-server.mjs',
    stateDir: '/var/lib/zero3/project-context',
    executorFactory: () => ({
      probe: async () => ({ executorId: 'claude', status: 'unavailable' }),
      start: async () => { throw new Error('not used') },
      prompt: async function * () {},
      close: async () => {}
    })
  })
  assert.deepEqual(await unavailable.availability(), { available: false, authenticated: null })
})

import path from 'node:path'

import {
  ZERO3_EXECUTOR_CONTRACT,
  type ExecutorEvent,
  type ExecutorFailure,
  type ExecutorProbe,
  type ExecutorSession,
  type ExecutorStartContext
} from '../executor-runtime/executor-types'
import { ClaudeExecutor } from '../executor-runtime/external/claude-executor'
import {
  ZERO3_EXECUTION_RESULT_V2,
  type Zero3ExecutionResultV2,
  type Zero3TaskSpecV2
} from './agent-contracts'
import { renderZero3AgentTaskPrompt } from './task-prompt'

export type Zero3ClaudeProjectMcpOptions = {
  serverPath: string
  stateDir: string
}

export type Zero3ClaudeExecutorPort = {
  probe(): Promise<ExecutorProbe>
  start(context: ExecutorStartContext): Promise<ExecutorSession>
  prompt(session: ExecutorSession, input: { kind: 'prompt'; clientRequestId: string; text: string }): AsyncIterable<ExecutorEvent>
  close(session: ExecutorSession): Promise<void>
}

export type Zero3ClaudeTaskAdapterOptions = Zero3ClaudeProjectMcpOptions & {
  executorFactory?: (mcpConfig?: string) => Zero3ClaudeExecutorPort
  now?: () => string
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} must be non-empty`)
  return normalized
}

export function zero3ClaudeProjectMcpConfig(
  task: Pick<Zero3TaskSpecV2, 'projectId'>,
  options: Zero3ClaudeProjectMcpOptions
): string {
  const projectId = nonEmpty(task.projectId, 'projectId')
  const serverPath = path.resolve(nonEmpty(options.serverPath, 'project-context MCP server path'))
  const stateDir = path.resolve(nonEmpty(options.stateDir, 'project-context state directory'))
  return JSON.stringify({
    mcpServers: {
      zero3_project_context: {
        type: 'stdio',
        command: process.execPath,
        args: [serverPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ZERO3_PROJECT_CONTEXT_DIR: stateDir,
          ZERO3_ACTIVE_PROJECT_ID: projectId,
          ...(process.env.ZERO3_SHARED_MEMORY_CONFIG ? { ZERO3_SHARED_MEMORY_CONFIG: process.env.ZERO3_SHARED_MEMORY_CONFIG } : {})
        }
      }
    }
  })
}

function handoffInstruction(task: Zero3TaskSpecV2): string {
  return [
    'ZERO3_PROJECT_CONTEXT_HANDOFF_REQUIRED:',
    `- This execution is scoped to Zero3 projectId ${JSON.stringify(task.projectId)} and taskId ${JSON.stringify(task.taskId)}.`,
    `- Before changing files, call mcp__zero3_project_context__handoff_get with taskId ${JSON.stringify(task.taskId)}.`,
    '- If handoff_get returns version > 0, treat its result as authoritative prior-execution context and continue from it instead of restarting from scratch.',
    `- Also call mcp__zero3_project_context__project_get_context with projectId ${JSON.stringify(task.projectId)} before relying on remembered project decisions.`,
    '- Do not request or use context for another projectId. The MCP server is intentionally fail-closed to the active project.',
    '- Do not claim a handoff was read unless the MCP tool call actually succeeded.'
  ].join('\n')
}

function statusForFailure(failure: ExecutorFailure | null): Zero3ExecutionResultV2['status'] {
  if (!failure) return 'FAILED'
  if (['auth_required', 'permission_denied', 'policy_denied', 'context_lost', 'context_exhausted'].includes(failure.code)) {
    return 'BLOCKED'
  }
  return 'FAILED'
}

function recommendedActionForFailure(failure: ExecutorFailure | null): Zero3ExecutionResultV2['recommendedAction'] {
  if (!failure) return 'RETRY'
  if (['auth_required', 'permission_denied', 'policy_denied'].includes(failure.code)) return 'HUMAN_REVIEW'
  return 'RETRY'
}

export class Zero3ClaudeTaskAdapter {
  readonly #factory: (mcpConfig?: string) => Zero3ClaudeExecutorPort
  readonly #now: () => string

  constructor(readonly options: Zero3ClaudeTaskAdapterOptions) {
    nonEmpty(options.serverPath, 'project-context MCP server path')
    nonEmpty(options.stateDir, 'project-context state directory')
    this.#factory = options.executorFactory ?? (mcpConfig => new ClaudeExecutor({
      ...(mcpConfig ? { mcpConfig, strictMcpConfig: true } : {})
    }))
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async availability(): Promise<{ available: boolean; authenticated: boolean | null }> {
    const probe = await this.#factory().probe()
    if (probe.status === 'ready') return { available: true, authenticated: true }
    if (probe.status === 'auth_required') return { available: true, authenticated: false }
    if (probe.status === 'unsupported') return { available: false, authenticated: null }
    return { available: false, authenticated: null }
  }

  async dispatchTask(task: Zero3TaskSpecV2): Promise<Zero3ExecutionResultV2> {
    const workspace = nonEmpty(task.worktreePath ?? '', 'Claude task worktreePath')
    const executor = this.#factory(zero3ClaudeProjectMcpConfig(task, this.options))
    const startContext: ExecutorStartContext = {
      contract: ZERO3_EXECUTOR_CONTRACT,
      identity: {
        taskId: task.taskId,
        executionId: task.executionId,
        workspace,
        ...(task.repo?.trim() ? { repoIdentity: task.repo.trim() } : {}),
        ...(task.branch?.trim() ? { branch: task.branch.trim() } : {}),
        objective: task.goal,
        constraints: [...task.constraints],
        acceptanceCriteria: [...task.requirements, ...task.completionGate]
      },
      policy: { permissionProfile: 'standard', approvalRequired: false },
      generation: 1
    }

    const session = await executor.start(startContext)
    let summary = ''
    let failure: ExecutorFailure | null = null
    let outcome: 'succeeded' | 'cancelled' | 'failed' | null = null
    try {
      const prompt = `${handoffInstruction(task)}\n\n${renderZero3AgentTaskPrompt(task)}`
      for await (const event of executor.prompt(session, {
        kind: 'prompt',
        clientRequestId: `${task.executionId}:claude`,
        text: prompt
      })) {
        if (event.type === 'message' && event.text.trim()) summary = event.text.trim()
        if (event.type === 'failure') failure = event.failure
        if (event.type === 'completed') outcome = event.outcome
      }
    } finally {
      await executor.close(session)
    }

    const succeeded = outcome === 'succeeded' && !failure
    const status: Zero3ExecutionResultV2['status'] = succeeded ? 'COMPLETE' : statusForFailure(failure)
    const fallbackSummary = failure?.message
      ?? (outcome === 'cancelled' ? 'Claude execution was cancelled.' : 'Claude execution ended without a successful terminal result.')

    return {
      protocol: ZERO3_EXECUTION_RESULT_V2,
      taskId: task.taskId,
      executionId: task.executionId,
      projectId: task.projectId,
      provider: 'CLAUDE',
      providerRuntime: 'CLAUDE_CODE',
      status,
      contextVersion: task.contextVersion,
      conversationId: session.sessionId,
      summary: summary || fallbackSummary,
      changedFiles: [],
      artifacts: [],
      git: task.baseSha || task.branch
        ? { baseSha: task.baseSha ?? null, branch: task.branch ?? null }
        : null,
      verification: [],
      knownIssues: [],
      blockers: succeeded ? [] : [fallbackSummary],
      recommendedAction: succeeded ? 'GPT_REVIEW' : recommendedActionForFailure(failure),
      completedAt: this.#now()
    }
  }
}

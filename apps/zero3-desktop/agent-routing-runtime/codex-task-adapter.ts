import {
  ZERO3_EXECUTION_RESULT_V2,
  type Zero3ExecutionResultV2,
  type Zero3TaskSpecV2
} from './agent-contracts'

export type Zero3CodexRunnerLike = {
  run(lease: {
    lease_id: string
    fencing_token: number
    task: Record<string, unknown>
  }): Promise<unknown>
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function remoteTask(task: Zero3TaskSpecV2): Record<string, unknown> {
  if (!task.worktreePath?.trim()) throw new Error('Codex TaskSpecV2 requires an explicit isolated worktreePath')
  return {
    protocol: 'zero3.pilot.remote-task.v1',
    task_id: task.taskId,
    execution_id: task.executionId,
    objective: task.goal,
    target: {
      workspace: task.worktreePath,
      ...(task.baseSha ? { base_ref: task.baseSha } : {})
    },
    constraints: [...task.constraints],
    acceptance_criteria: [...task.requirements],
    permission_profile: 'standard',
    execution: {
      max_turns: 1,
      timeout_seconds: 3600,
      require_clean_worktree: true,
      require_clean_worktree_on_success: true
    },
    project_context: {
      project_id: task.projectId,
      context_version: task.contextVersion,
      source_entry_id: task.createdBySessionId
    },
    handoff: {
      result_protocol: 'zero3.pilot.execution-result.v1',
      return_entry_id: task.createdBySessionId,
      required_evidence: [...task.completionGate]
    }
  }
}

function status(value: unknown): Zero3ExecutionResultV2['status'] {
  switch (value) {
    case 'succeeded': return 'COMPLETE'
    case 'failed': return 'FAILED'
    case 'blocked': return 'BLOCKED'
    case 'outcome_unknown': return 'OUTCOME_UNKNOWN'
    default: return 'PARTIAL'
  }
}

function resultFromRun(task: Zero3TaskSpecV2, rawValue: unknown): Zero3ExecutionResultV2 {
  const raw = record(rawValue)
  const execution = record(raw.executionResult)
  const state = text(raw.state) ?? text(execution.state) ?? 'outcome_unknown'
  const preflight = record(execution.git_preflight)
  const postflight = record(execution.git_postflight)
  const mappedStatus = status(state)
  const summary = text(execution.agent_summary)
    ?? (mappedStatus === 'OUTCOME_UNKNOWN'
      ? 'Codex task runner did not produce an authoritative terminal result.'
      : `Codex task runner finished with state ${state}.`)

  return {
    protocol: ZERO3_EXECUTION_RESULT_V2,
    taskId: task.taskId,
    executionId: task.executionId,
    projectId: task.projectId,
    provider: 'CODEX',
    providerRuntime: 'CODEX_LOCAL',
    status: mappedStatus,
    contextVersion: task.contextVersion,
    conversationId: text(execution.codex_thread_id),
    summary,
    changedFiles: [],
    artifacts: [],
    git: Object.keys(postflight).length || Object.keys(preflight).length
      ? {
          baseSha: text(postflight.base_commit) ?? text(preflight.base_commit) ?? task.baseSha ?? null,
          headSha: text(postflight.head_commit) ?? text(preflight.head_commit),
          commitSha: text(postflight.head_commit),
          branch: text(postflight.branch) ?? task.branch ?? null
        }
      : task.baseSha || task.branch
        ? { baseSha: task.baseSha ?? null, branch: task.branch ?? null }
        : null,
    verification: [],
    knownIssues: [],
    blockers: mappedStatus === 'OUTCOME_UNKNOWN'
      ? ['Codex runner outcome is unknown; explicit recovery is required before retry.']
      : mappedStatus === 'BLOCKED'
        ? ['Codex runner completion gate blocked the task.']
        : [],
    recommendedAction: mappedStatus === 'COMPLETE' || mappedStatus === 'PARTIAL' ? 'GPT_REVIEW' : 'HUMAN_REVIEW',
    completedAt: new Date().toISOString()
  }
}

export class Zero3CodexTaskAdapter {
  constructor(private readonly runner: Zero3CodexRunnerLike) {}

  async dispatchTask(task: Zero3TaskSpecV2): Promise<Zero3ExecutionResultV2> {
    let raw: unknown
    try {
      raw = await this.runner.run({
        lease_id: `local-${task.executionId}`,
        fencing_token: 1,
        task: remoteTask(task)
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const message = error instanceof Error ? error.message : String(error)
      const unknown = name.includes('OutcomeUnknown')
      return {
        protocol: ZERO3_EXECUTION_RESULT_V2,
        taskId: task.taskId,
        executionId: task.executionId,
        projectId: task.projectId,
        provider: 'CODEX',
        providerRuntime: 'CODEX_LOCAL',
        status: unknown ? 'OUTCOME_UNKNOWN' : 'BLOCKED',
        contextVersion: task.contextVersion,
        conversationId: null,
        summary: message,
        changedFiles: [],
        artifacts: [],
        git: task.baseSha || task.branch ? { baseSha: task.baseSha ?? null, branch: task.branch ?? null } : null,
        verification: [],
        knownIssues: [],
        blockers: [message],
        recommendedAction: 'HUMAN_REVIEW',
        completedAt: new Date().toISOString()
      }
    }
    return resultFromRun(task, raw)
  }
}

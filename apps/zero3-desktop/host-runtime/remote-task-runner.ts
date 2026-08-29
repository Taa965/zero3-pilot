import path from 'node:path'

import { zero3RemoteWorkspaceAllowed } from './remote-config'
import { Zero3RemoteEvidenceCollector } from './remote-evidence'
import type {
  Zero3RemoteCodexMapping,
  Zero3RemoteHostConfig,
  Zero3RemoteLease,
  Zero3RemoteTask
} from './remote-types'
import { ZERO3_REMOTE_TASK_PROTOCOL } from './remote-types'

export type Zero3CodexRuntime = {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
  onEvent(listener: (event: unknown) => void): () => void
}

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
}

function requiredString(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return text
}

function stringArray(value: unknown, label: string, maxItems: number, maxItemLength: number): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} items`)
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`, maxItemLength))
}

function validateTask(task: Zero3RemoteTask): Zero3RemoteTask {
  const raw = record(task)
  if (raw.protocol !== ZERO3_REMOTE_TASK_PROTOCOL) throw new Error('unsupported Zero3 remote task protocol')
  const target = record(raw.target)
  const execution = record(raw.execution)
  const permission = raw.permission_profile == null ? 'standard' : requiredString(raw.permission_profile, 'permission_profile', 32)
  if (!['read_only', 'standard', 'elevated', 'full_control'].includes(permission)) {
    throw new Error('unsupported remote permission_profile')
  }
  const maxTurns = execution.max_turns == null ? 8 : Number(execution.max_turns)
  const timeoutSeconds = execution.timeout_seconds == null ? 3600 : Number(execution.timeout_seconds)
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) throw new Error('execution.max_turns must be an integer from 1 to 32')
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 8 * 60 * 60) {
    throw new Error('execution.timeout_seconds must be an integer from 30 to 28800')
  }

  return {
    protocol: ZERO3_REMOTE_TASK_PROTOCOL,
    task_id: requiredString(raw.task_id, 'task_id', 256),
    execution_id: requiredString(raw.execution_id, 'execution_id', 256),
    objective: requiredString(raw.objective, 'objective', 64_000),
    target: {
      workspace: requiredString(target.workspace, 'target.workspace', 4096),
      ...(target.base_ref == null ? {} : { base_ref: requiredString(target.base_ref, 'target.base_ref', 256) })
    },
    constraints: stringArray(raw.constraints, 'constraints', 64, 4096),
    acceptance_criteria: stringArray(raw.acceptance_criteria, 'acceptance_criteria', 64, 4096),
    permission_profile: permission as Zero3RemoteTask['permission_profile'],
    execution: {
      max_turns: maxTurns,
      timeout_seconds: timeoutSeconds,
      require_clean_worktree: execution.require_clean_worktree == null ? true : execution.require_clean_worktree === true
    }
  }
}

function taskPrompt(task: Zero3RemoteTask): string {
  const constraints = task.constraints?.length ? task.constraints.map(value => `- ${value}`).join('\n') : '- none supplied'
  const acceptance = task.acceptance_criteria?.length
    ? task.acceptance_criteria.map(value => `- ${value}`).join('\n')
    : '- verify the requested objective against the real project'
  return `[ZERO3 REMOTE TASK]\n\nTask ID: ${task.task_id}\nExecution ID: ${task.execution_id}\n\nObjective:\n${task.objective}\n\nConstraints:\n${constraints}\n\nAcceptance Criteria:\n${acceptance}\n\nExecution requirements:\n- Inspect the real repository before modifying it.\n- Preserve Zero3 architecture invariants; open-source Codex remains the only Agent Kernel.\n- Use real project verification rather than assuming generated code works.\n- Do not bypass sandbox or approval policy.\n- Do not claim success until the acceptance criteria have been verified.\n- If an action needs permission outside the granted profile, stop and surface the requirement.\n`
}

function idFromResult(value: unknown, label: string): string {
  const root = record(value)
  const candidate = typeof root.id === 'string' ? root.id : typeof record(root.thread).id === 'string' ? String(record(root.thread).id) : typeof record(root.turn).id === 'string' ? String(record(root.turn).id) : ''
  return requiredString(candidate, label, 512)
}

function eventMethod(event: unknown): string {
  const root = record(event)
  return root.kind === 'notification' && typeof root.method === 'string' ? root.method : ''
}

function eventParams(event: unknown): unknown {
  return record(event).params ?? null
}

function eventThreadId(event: unknown): string | null {
  const params = record(eventParams(event))
  if (typeof params.threadId === 'string') return params.threadId
  const thread = record(params.thread)
  return typeof thread.id === 'string' ? thread.id : null
}

function eventTurnId(event: unknown): string | null {
  const params = record(eventParams(event))
  if (typeof params.turnId === 'string') return params.turnId
  const turn = record(params.turn)
  return typeof turn.id === 'string' ? turn.id : null
}

export class Zero3RemoteTaskRunner {
  constructor(
    private readonly config: Zero3RemoteHostConfig,
    private readonly codex: Zero3CodexRuntime
  ) {}

  async run(lease: Zero3RemoteLease, onEvidence?: (sequence: number, method: string, payload: unknown) => Promise<void>) {
    const task = validateTask(lease.task)
    const allowedWorkspace = zero3RemoteWorkspaceAllowed(this.config, task.target.workspace)
    if (!allowedWorkspace) throw new Error('remote task workspace is not present in the local allow-list')
    const workspace = path.resolve(allowedWorkspace)

    // H3 deliberately preserves the current Zero3 desktop safety boundary:
    // remote tasks do not silently widen the default sandbox. Codex can issue
    // its normal server-originated approval request if a write/escalation is needed.
    const threadResult = await this.codex.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      ephemeral: false
    })
    const threadId = idFromResult(threadResult, 'Codex thread id')
    const mapping: Zero3RemoteCodexMapping = {
      taskId: task.task_id,
      executionId: task.execution_id,
      threadId,
      turnIds: [],
      workspace
    }
    const evidence = new Zero3RemoteEvidenceCollector(mapping)

    let resolveTerminal: ((value: { method: string; params: unknown }) => void) | null = null
    let rejectTerminal: ((reason: Error) => void) | null = null
    const terminal = new Promise<{ method: string; params: unknown }>((resolve, reject) => {
      resolveTerminal = resolve
      rejectTerminal = reject
    })

    const unsubscribe = this.codex.onEvent(event => {
      try {
        const method = eventMethod(event)
        if (!method) return
        const relatedThread = eventThreadId(event)
        if (relatedThread && relatedThread !== threadId) return
        const relatedTurn = eventTurnId(event)
        if (relatedTurn && mapping.turnIds.length > 0 && !mapping.turnIds.includes(relatedTurn)) return
        const params = eventParams(event)
        const item = evidence.push(method, params)
        if (onEvidence) void onEvidence(item.sequence, method, params).catch(() => undefined)
        if (method === 'turn/completed') resolveTerminal?.({ method, params })
        if (method === 'turn/failed') resolveTerminal?.({ method, params })
      } catch (error) {
        rejectTerminal?.(error instanceof Error ? error : new Error(String(error)))
      }
    })

    try {
      const turnResult = await this.codex.request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: taskPrompt(task), text_elements: [] }]
        },
        (task.execution?.timeout_seconds ?? 3600) * 1000
      )
      const turnId = idFromResult(turnResult, 'Codex turn id')
      mapping.turnIds.push(turnId)
      const completed = await terminal
      const completedRecord = record(completed.params)
      const turnRecord = record(completedRecord.turn)
      const status = typeof turnRecord.status === 'string' ? turnRecord.status : typeof completedRecord.status === 'string' ? completedRecord.status : ''
      const succeeded = completed.method === 'turn/completed' && !['failed', 'cancelled', 'interrupted'].includes(status)
      return {
        state: succeeded ? ('succeeded' as const) : ('failed' as const),
        task,
        mapping,
        terminal: completed,
        evidence: evidence.snapshot()
      }
    } finally {
      unsubscribe()
    }
  }
}

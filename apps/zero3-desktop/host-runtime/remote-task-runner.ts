import path from 'node:path'

import { zero3RemoteWorkspaceAllowed } from './remote-config'
import { Zero3RemoteEvidenceCollector } from './remote-evidence'
import { Zero3RemoteMappingStore } from './remote-mapping-store'
import type {
  Zero3RemoteCodexMapping,
  Zero3RemoteHostConfig,
  Zero3RemoteLease,
  Zero3RemoteTask
} from './remote-types'
import { ZERO3_REMOTE_TASK_PROTOCOL } from './remote-types'

export type Zero3CodexRuntime = {
  startThread(params: unknown): Promise<unknown>
  startTurn(params: unknown, timeoutMs?: number): Promise<unknown>
  readThread(params: unknown): Promise<unknown>
}

type RecordValue = Record<string, unknown>

export class Zero3RemoteTaskBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Zero3RemoteTaskBlockedError'
  }
}

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
  const maxTurns = execution.max_turns == null ? 1 : Number(execution.max_turns)
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
      require_clean_worktree: execution.require_clean_worktree === true
    }
  }
}

function taskPrompt(task: Zero3RemoteTask): string {
  const constraints = task.constraints?.length ? task.constraints.map(value => `- ${value}`).join('\n') : '- none supplied'
  const acceptance = task.acceptance_criteria?.length
    ? task.acceptance_criteria.map(value => `- ${value}`).join('\n')
    : '- verify the requested objective against the real project'
  return `[ZERO3 REMOTE TASK]\n\nTask ID: ${task.task_id}\nExecution ID: ${task.execution_id}\nPermission intent: ${task.permission_profile ?? 'standard'}\nMaximum host-started Codex Turns: ${task.execution?.max_turns ?? 1}\n\nObjective:\n${task.objective}\n\nConstraints:\n${constraints}\n\nAcceptance Criteria:\n${acceptance}\n\nExecution requirements:\n- Inspect the real repository before modifying it.\n- Preserve Zero3 architecture invariants; open-source Codex remains the only Agent Kernel.\n- Use real project verification rather than assuming generated code works.\n- Do not bypass sandbox or approval policy.\n- Do not claim success until the acceptance criteria have been verified.\n- If an action needs permission outside the granted profile, stop and surface the requirement.\n`
}

function idFromResult(value: unknown, label: string): string {
  const root = record(value)
  const candidate =
    typeof root.id === 'string'
      ? root.id
      : typeof record(root.thread).id === 'string'
        ? String(record(root.thread).id)
        : typeof record(root.turn).id === 'string'
          ? String(record(root.turn).id)
          : ''
  return requiredString(candidate, label, 512)
}

function findTurn(threadRead: unknown, turnId: string): RecordValue | null {
  const root = record(threadRead)
  const thread = record(root.thread)
  const turns = Array.isArray(thread.turns) ? thread.turns : Array.isArray(root.turns) ? root.turns : []
  for (const raw of turns) {
    const turn = record(raw)
    if (turn.id === turnId) return turn
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class Zero3RemoteTaskRunner {
  constructor(
    private readonly config: Zero3RemoteHostConfig,
    private readonly codex: Zero3CodexRuntime,
    private readonly mappings = new Zero3RemoteMappingStore(config.mappingStateFile)
  ) {}

  async run(lease: Zero3RemoteLease, onEvidence?: (sequence: number, method: string, payload: unknown) => Promise<void>) {
    const task = validateTask(lease.task)
    const allowedWorkspace = zero3RemoteWorkspaceAllowed(this.config, task.target.workspace)
    if (!allowedWorkspace) throw new Zero3RemoteTaskBlockedError('remote task workspace is not present in the local allow-list')
    const workspace = path.resolve(allowedWorkspace)

    // H3 has no generic Git or shell escape hatch outside Codex. Until a
    // host-owned, Codex-authoritative Git preflight exists, explicit conditions
    // that cannot be proven through the narrow adapter are rejected rather than
    // silently treated as satisfied.
    if (task.target.base_ref) {
      throw new Zero3RemoteTaskBlockedError('target.base_ref requires a future Codex-authoritative Git preflight; H3 will not guess it')
    }
    if (task.execution?.require_clean_worktree) {
      throw new Zero3RemoteTaskBlockedError(
        'execution.require_clean_worktree requires a future Codex-authoritative Git preflight; H3 will not bypass the kernel to inspect it'
      )
    }

    let mapping = await this.mappings.get(task.task_id)
    if (mapping) {
      if (mapping.executionId !== task.execution_id) {
        throw new Zero3RemoteTaskBlockedError('task_id is already bound to a different execution_id')
      }
      if (path.resolve(mapping.workspace) !== workspace) {
        throw new Zero3RemoteTaskBlockedError('task_id is already bound to a different local workspace')
      }
      mapping = { ...mapping, turnIds: [...mapping.turnIds] }
    } else {
      // H3 deliberately preserves the current Zero3 desktop safety boundary:
      // remote tasks do not silently widen the default sandbox. Codex can issue
      // its normal server-originated approval request if a write/escalation is needed.
      const threadResult = await this.codex.startThread({
        cwd: workspace,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
        ephemeral: false
      })
      const threadId = idFromResult(threadResult, 'Codex thread id')
      mapping = {
        taskId: task.task_id,
        executionId: task.execution_id,
        threadId,
        turnIds: [],
        workspace
      }
      await this.mappings.put(mapping)
    }

    const evidence = new Zero3RemoteEvidenceCollector(mapping)
    const threadEvidence = evidence.push(mapping.turnIds.length ? 'remote.thread.resumed' : 'remote.thread.started', {
      threadId: mapping.threadId,
      workspace
    })
    if (onEvidence) await onEvidence(threadEvidence.sequence, threadEvidence.method, threadEvidence.params)

    let turnId = mapping.turnIds.at(-1) ?? null
    if (!turnId) {
      const turnResult = await this.codex.startTurn(
        {
          threadId: mapping.threadId,
          input: [{ type: 'text', text: taskPrompt(task), text_elements: [] }]
        },
        30_000
      )
      turnId = idFromResult(turnResult, 'Codex turn id')
      mapping.turnIds.push(turnId)
      await this.mappings.put(mapping)
      const turnStarted = evidence.push('remote.turn.started', { threadId: mapping.threadId, turnId })
      if (onEvidence) await onEvidence(turnStarted.sequence, turnStarted.method, turnStarted.params)
    } else {
      const turnResumed = evidence.push('remote.turn.resumed', { threadId: mapping.threadId, turnId })
      if (onEvidence) await onEvidence(turnResumed.sequence, turnResumed.method, turnResumed.params)
    }

    const timeoutMs = (task.execution?.timeout_seconds ?? 3600) * 1000
    const deadline = Date.now() + timeoutMs
    let lastStatus = ''

    while (Date.now() < deadline) {
      const snapshot = await this.codex.readThread({ threadId: mapping.threadId, includeTurns: true })
      const turn = findTurn(snapshot, turnId)
      if (!turn) {
        await delay(750)
        continue
      }

      const status = typeof turn.status === 'string' ? turn.status : ''
      if (status && status !== lastStatus) {
        lastStatus = status
        const statusEvidence = evidence.push('remote.turn.status', { turnId, status, error: turn.error ?? null })
        if (onEvidence) await onEvidence(statusEvidence.sequence, statusEvidence.method, statusEvidence.params)
      }

      if (status === 'completed') {
        return {
          state: 'succeeded' as const,
          task,
          mapping,
          terminal: { turnId, status },
          evidence: evidence.snapshot()
        }
      }
      if (status === 'failed' || status === 'interrupted') {
        return {
          state: 'failed' as const,
          task,
          mapping,
          terminal: { turnId, status, error: turn.error ?? null },
          evidence: evidence.snapshot()
        }
      }

      await delay(1000)
    }

    return {
      state: 'outcome_unknown' as const,
      task,
      mapping,
      terminal: { turnId, status: lastStatus || 'unknown', reason: 'remote task observation timed out' },
      evidence: evidence.snapshot()
    }
  }
}

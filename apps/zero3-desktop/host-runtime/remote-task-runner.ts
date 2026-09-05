import { createHash } from 'node:crypto'
import path from 'node:path'

import { zero3RemoteWorkspaceAllowed } from './remote-config'
import { Zero3RemoteEvidenceCollector } from './remote-evidence'
import { Zero3RemoteMappingStore } from './remote-mapping-store'
import type {
  Zero3RemoteCodexMapping,
  Zero3RemoteExecutionResult,
  Zero3RemoteGitEvidence,
  Zero3RemoteHostConfig,
  Zero3RemoteLease,
  Zero3RemoteProjectContextRef,
  Zero3RemoteTask
} from './remote-types'
import { ZERO3_REMOTE_EXECUTION_RESULT_PROTOCOL, ZERO3_REMOTE_TASK_PROTOCOL } from './remote-types'

export type Zero3CodexRuntime = {
  startThread(params: unknown): Promise<unknown>
  startTurn(params: unknown, timeoutMs?: number): Promise<unknown>
  readThread(params: unknown): Promise<unknown>
  execCommand(params: unknown, timeoutMs?: number): Promise<unknown>
}

type RecordValue = Record<string, unknown>

type Zero3RemoteGitPreflight = {
  repositoryRoot: string
  headCommit: string
  baseCommit: string | null
  cleanWorktree: boolean | null
}

type Zero3RemoteGitPostflight = Zero3RemoteGitPreflight & {
  branch: string | null
  upstreamCommit: string | null
  remoteSynced: boolean | null
}

const GIT_COMMAND_TIMEOUT_MS = 10_000
const GIT_COMMAND_REQUEST_TIMEOUT_MS = 15_000
const GIT_OUTPUT_BYTES_CAP = 64 * 1024

export class Zero3RemoteTaskBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Zero3RemoteTaskBlockedError'
  }
}

export class Zero3RemoteTaskOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Zero3RemoteTaskOutcomeUnknownError'
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

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === '') return undefined
  return requiredString(value, label, max)
}

function stringArray(value: unknown, label: string, maxItems: number, maxItemLength: number): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} items`)
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`, maxItemLength))
}

function optionalContextRef(value: unknown): Zero3RemoteProjectContextRef | undefined {
  if (value == null) return undefined
  const raw = record(value)
  const projectId = requiredString(raw.project_id, 'project_context.project_id', 512)
  const contextVersion = raw.context_version == null ? undefined : Number(raw.context_version)
  if (
    contextVersion != null &&
    (!Number.isSafeInteger(contextVersion) || contextVersion < 1 || contextVersion > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('project_context.context_version must be a positive safe integer')
  }
  const sourceKind = optionalString(raw.source_kind, 'project_context.source_kind', 32)
  if (sourceKind && sourceKind !== 'gpt_web' && sourceKind !== 'codex') {
    throw new Error('project_context.source_kind must be gpt_web or codex')
  }
  return {
    project_id: projectId,
    ...(contextVersion == null ? {} : { context_version: contextVersion }),
    ...(optionalString(raw.context_ref, 'project_context.context_ref', 8_192) ? {
      context_ref: optionalString(raw.context_ref, 'project_context.context_ref', 8_192)
    } : {}),
    ...(optionalString(raw.source_entry_id, 'project_context.source_entry_id', 256) ? {
      source_entry_id: optionalString(raw.source_entry_id, 'project_context.source_entry_id', 256)
    } : {}),
    ...(sourceKind ? { source_kind: sourceKind as 'gpt_web' | 'codex' } : {})
  }
}

function validateTask(task: Zero3RemoteTask): Zero3RemoteTask {
  const raw = record(task)
  if (raw.protocol !== ZERO3_REMOTE_TASK_PROTOCOL) throw new Error('unsupported Zero3 remote task protocol')
  const target = record(raw.target)
  const execution = record(raw.execution)
  const handoff = record(raw.handoff)
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

  const baseRef = target.base_ref == null ? null : requiredString(target.base_ref, 'target.base_ref', 256)
  if (baseRef?.startsWith('-')) throw new Error('target.base_ref must not start with a dash')

  const projectContext = optionalContextRef(raw.project_context)
  const handoffRequested = raw.handoff != null
  const resultProtocol = handoff.result_protocol == null
    ? ZERO3_REMOTE_EXECUTION_RESULT_PROTOCOL
    : requiredString(handoff.result_protocol, 'handoff.result_protocol', 128)
  if (handoffRequested && resultProtocol !== ZERO3_REMOTE_EXECUTION_RESULT_PROTOCOL) {
    throw new Error('unsupported handoff.result_protocol')
  }

  const contextRef = projectContext?.context_ref
  const sourceEntryId = projectContext?.source_entry_id

  return {
    protocol: ZERO3_REMOTE_TASK_PROTOCOL,
    task_id: requiredString(raw.task_id, 'task_id', 256),
    execution_id: requiredString(raw.execution_id, 'execution_id', 256),
    objective: requiredString(raw.objective, 'objective', 64_000),
    target: {
      workspace: requiredString(target.workspace, 'target.workspace', 4096),
      ...(baseRef ? { base_ref: baseRef } : {})
    },
    constraints: stringArray(raw.constraints, 'constraints', 64, 4096),
    acceptance_criteria: stringArray(raw.acceptance_criteria, 'acceptance_criteria', 64, 4096),
    permission_profile: permission as Zero3RemoteTask['permission_profile'],
    execution: {
      max_turns: maxTurns,
      timeout_seconds: timeoutSeconds,
      require_clean_worktree: execution.require_clean_worktree === true,
      require_clean_worktree_on_success: execution.require_clean_worktree_on_success === true,
      require_remote_sync_on_success: execution.require_remote_sync_on_success === true
    },
    ...(projectContext ? {
      project_context: {
        ...projectContext,
        ...(contextRef ? { context_ref: contextRef } : {}),
        ...(sourceEntryId ? { source_entry_id: sourceEntryId } : {})
      }
    } : {}),
    ...(handoffRequested ? {
      handoff: {
        result_protocol: ZERO3_REMOTE_EXECUTION_RESULT_PROTOCOL,
        ...(optionalString(handoff.return_entry_id, 'handoff.return_entry_id', 256) ? {
          return_entry_id: optionalString(handoff.return_entry_id, 'handoff.return_entry_id', 256)
        } : {}),
        required_evidence: stringArray(handoff.required_evidence, 'handoff.required_evidence', 64, 256)
      }
    } : {})
  }
}

function taskPrompt(task: Zero3RemoteTask, gitPreflight: Zero3RemoteGitPreflight): string {
  const constraints = task.constraints?.length ? task.constraints.map(value => `- ${value}`).join('\n') : '- none supplied'
  const acceptance = task.acceptance_criteria?.length
    ? task.acceptance_criteria.map(value => `- ${value}`).join('\n')
    : '- verify the requested objective against the real project'
  const clean = gitPreflight.cleanWorktree == null ? 'not required' : gitPreflight.cleanWorktree ? 'clean' : 'dirty'
  const projectContext = task.project_context
    ? `- project_id: ${task.project_context.project_id}\n- context_version: ${task.project_context.context_version ?? 'not supplied'}\n- context_ref: ${task.project_context.context_ref ?? 'not supplied'}\n- source: ${task.project_context.source_kind ?? 'not supplied'} / ${task.project_context.source_entry_id ?? 'not supplied'}`
    : '- not supplied'
  const requiredEvidence = task.handoff?.required_evidence?.length
    ? task.handoff.required_evidence.map(value => `- ${value}`).join('\n')
    : '- no additional named evidence requested'
  return `[ZERO3 REMOTE TASK]\n\nTask ID: ${task.task_id}\nExecution ID: ${task.execution_id}\nPermission intent: ${task.permission_profile ?? 'standard'}\nMaximum host-started Codex Turns: ${task.execution?.max_turns ?? 1}\n\nProject context reference:\n${projectContext}\n\nAuthoritative Git preflight:\n- repository root: ${gitPreflight.repositoryRoot}\n- HEAD: ${gitPreflight.headCommit}\n- requested base commit: ${gitPreflight.baseCommit ?? 'not required'}\n- worktree: ${clean}\n\nObjective:\n${task.objective}\n\nConstraints:\n${constraints}\n\nAcceptance Criteria:\n${acceptance}\n\nRequested handoff evidence:\n${requiredEvidence}\n\nExecution requirements:\n- Inspect the real repository before modifying it.\n- Preserve Zero3 architecture invariants; open-source Codex remains the only Agent Kernel.\n- Use real project verification rather than assuming generated code works.\n- Do not bypass sandbox or approval policy.\n- Do not claim success until the acceptance criteria have been verified.\n- If an action needs permission outside the granted profile, stop and surface the requirement.\n- Finish with a concise factual handoff summary for the supervising GPT session.\n`
}

function taskFingerprint(task: Zero3RemoteTask): string {
  return createHash('sha256').update(JSON.stringify(task)).digest('hex')
}

function turnClientId(task: Zero3RemoteTask): string {
  const digest = createHash('sha256')
    .update([ZERO3_REMOTE_TASK_PROTOCOL, task.task_id, task.execution_id, 'turn:1'].join('\u0000'))
    .digest('hex')
  return `zero3-remote-${digest}`
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

function threadTurns(threadRead: unknown): RecordValue[] {
  const root = record(threadRead)
  const thread = record(root.thread)
  const turns = Array.isArray(thread.turns) ? thread.turns : Array.isArray(root.turns) ? root.turns : []
  return turns.map(record)
}

function findTurn(threadRead: unknown, turnId: string): RecordValue | null {
  for (const turn of threadTurns(threadRead)) {
    if (turn.id === turnId) return turn
  }
  return null
}

function findTurnByClientId(threadRead: unknown, clientId: string): { turnId: string; turn: RecordValue } | null {
  for (const turn of threadTurns(threadRead)) {
    const items = Array.isArray(turn.items) ? turn.items : []
    for (const rawItem of items) {
      const item = record(rawItem)
      if (item.clientId === clientId && typeof turn.id === 'string') {
        return { turnId: turn.id, turn }
      }
    }
  }
  return null
}

function lastAgentSummary(turn: RecordValue): string | null {
  const items = Array.isArray(turn.items) ? turn.items : []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = record(items[index])
    if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
      const text = item.text.trim()
      return text.length <= 64_000 ? text : `${text.slice(0, 63_997)}...`
    }
  }
  return null
}

function commandExecResult(value: unknown, label: string): { exitCode: number; stdout: string; stderr: string } {
  const root = record(value)
  const exitCode = Number(root.exitCode)
  if (!Number.isInteger(exitCode)) throw new Zero3RemoteTaskBlockedError(`${label} returned an invalid exit code`)
  const stdout = typeof root.stdout === 'string' ? root.stdout : ''
  const stderr = typeof root.stderr === 'string' ? root.stderr : ''
  return { exitCode, stdout, stderr }
}

function boundedDiagnostic(value: string): string {
  const text = value.trim()
  return text.length <= 2_000 ? text : `${text.slice(0, 1_997)}...`
}

async function runGitCommand(
  codex: Zero3CodexRuntime,
  workspace: string,
  args: string[],
  label: string
): Promise<{ stdout: string; stderr: string }> {
  let response: unknown
  try {
    response = await codex.execCommand(
      {
        command: ['git', ...args],
        cwd: workspace,
        timeoutMs: GIT_COMMAND_TIMEOUT_MS,
        outputBytesCap: GIT_OUTPUT_BYTES_CAP,
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      },
      GIT_COMMAND_REQUEST_TIMEOUT_MS
    )
  } catch (error) {
    throw new Zero3RemoteTaskBlockedError(
      `${label} could not be proven through Codex command/exec: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const result = commandExecResult(response, label)
  if (result.exitCode !== 0) {
    const detail = boundedDiagnostic(result.stderr || result.stdout || `exit code ${result.exitCode}`)
    throw new Zero3RemoteTaskBlockedError(`${label} failed: ${detail}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

function workspaceInsideRepository(repositoryRoot: string, workspace: string): boolean {
  const relative = path.relative(repositoryRoot, workspace)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function runGitPreflight(
  codex: Zero3CodexRuntime,
  workspace: string,
  task: Zero3RemoteTask
): Promise<Zero3RemoteGitPreflight> {
  const rootResult = await runGitCommand(codex, workspace, ['rev-parse', '--show-toplevel'], 'Git repository-root preflight')
  const repositoryRootText = rootResult.stdout.trim().split(/\r?\n/, 1)[0] ?? ''
  if (!repositoryRootText) throw new Zero3RemoteTaskBlockedError('Git repository-root preflight returned an empty repository root')
  const repositoryRoot = path.resolve(repositoryRootText)
  if (!workspaceInsideRepository(repositoryRoot, workspace)) {
    throw new Zero3RemoteTaskBlockedError('remote task workspace is not inside the Git repository reported by Codex command/exec')
  }

  const headResult = await runGitCommand(codex, workspace, ['rev-parse', '--verify', 'HEAD'], 'Git HEAD preflight')
  const headCommit = requiredString(headResult.stdout.trim().split(/\r?\n/, 1)[0], 'Git HEAD commit', 128)

  let baseCommit: string | null = null
  if (task.target.base_ref) {
    const baseResult = await runGitCommand(
      codex,
      workspace,
      ['rev-parse', '--verify', '--end-of-options', `${task.target.base_ref}^{commit}`],
      'Git base-ref preflight'
    )
    baseCommit = requiredString(baseResult.stdout.trim().split(/\r?\n/, 1)[0], 'Git base commit', 128)
    if (headCommit.toLowerCase() !== baseCommit.toLowerCase()) {
      throw new Zero3RemoteTaskBlockedError(
        `Git base-ref preflight failed: workspace HEAD ${headCommit} does not match requested base ${baseCommit}`
      )
    }
  }

  let cleanWorktree: boolean | null = null
  if (task.execution?.require_clean_worktree) {
    const statusResult = await runGitCommand(
      codex,
      workspace,
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      'Git clean-worktree preflight'
    )
    cleanWorktree = statusResult.stdout.trim().length === 0
    if (!cleanWorktree) {
      throw new Zero3RemoteTaskBlockedError(
        `Git clean-worktree preflight failed: ${boundedDiagnostic(statusResult.stdout) || 'workspace is dirty'}`
      )
    }
  }

  return { repositoryRoot, headCommit, baseCommit, cleanWorktree }
}

async function runGitPostflight(
  codex: Zero3CodexRuntime,
  workspace: string,
  task: Zero3RemoteTask,
  preflight: Zero3RemoteGitPreflight
): Promise<Zero3RemoteGitPostflight> {
  const headResult = await runGitCommand(codex, workspace, ['rev-parse', '--verify', 'HEAD'], 'Git HEAD postflight')
  const headCommit = requiredString(headResult.stdout.trim().split(/\r?\n/, 1)[0], 'Git postflight HEAD commit', 128)
  const branchResult = await runGitCommand(codex, workspace, ['branch', '--show-current'], 'Git branch postflight')
  const branch = branchResult.stdout.trim() || null
  const statusResult = await runGitCommand(
    codex,
    workspace,
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    'Git worktree postflight'
  )
  const cleanWorktree = statusResult.stdout.trim().length === 0
  if (task.execution?.require_clean_worktree_on_success && !cleanWorktree) {
    throw new Zero3RemoteTaskBlockedError(
      `Git completion gate failed: ${boundedDiagnostic(statusResult.stdout) || 'workspace is dirty'}`
    )
  }

  let upstreamCommit: string | null = null
  let remoteSynced: boolean | null = null
  if (task.execution?.require_remote_sync_on_success) {
    const upstreamResult = await runGitCommand(
      codex,
      workspace,
      ['rev-parse', '--verify', '@{upstream}'],
      'Git upstream postflight'
    )
    upstreamCommit = requiredString(upstreamResult.stdout.trim().split(/\r?\n/, 1)[0], 'Git upstream commit', 128)
    remoteSynced = headCommit.toLowerCase() === upstreamCommit.toLowerCase()
    if (!remoteSynced) {
      throw new Zero3RemoteTaskBlockedError(
        `Git completion gate failed: local HEAD ${headCommit} does not match upstream ${upstreamCommit}`
      )
    }
  }

  return {
    repositoryRoot: preflight.repositoryRoot,
    headCommit,
    baseCommit: preflight.baseCommit,
    cleanWorktree,
    branch,
    upstreamCommit,
    remoteSynced
  }
}

function gitEvidence(value: Zero3RemoteGitPreflight | Zero3RemoteGitPostflight): Zero3RemoteGitEvidence {
  const post = value as Partial<Zero3RemoteGitPostflight>
  return {
    repository_root: value.repositoryRoot,
    head_commit: value.headCommit,
    base_commit: value.baseCommit,
    clean_worktree: value.cleanWorktree,
    ...('branch' in value ? { branch: post.branch ?? null } : {}),
    ...('upstreamCommit' in value ? { upstream_commit: post.upstreamCommit ?? null } : {}),
    ...('remoteSynced' in value ? { remote_synced: post.remoteSynced ?? null } : {})
  }
}

function buildExecutionResult(input: {
  task: Zero3RemoteTask
  mapping: Zero3RemoteCodexMapping
  state: Zero3RemoteExecutionResult['state']
  turnId: string
  turn: RecordValue
  preflight: Zero3RemoteGitPreflight
  postflight?: Zero3RemoteGitPostflight
  evidence: Zero3RemoteEvidenceCollector
}): Zero3RemoteExecutionResult {
  return {
    protocol: ZERO3_REMOTE_EXECUTION_RESULT_PROTOCOL,
    task_id: input.task.task_id,
    execution_id: input.task.execution_id,
    state: input.state,
    codex_thread_id: input.mapping.threadId,
    codex_turn_id: input.turnId,
    ...(input.task.project_context ? { project_context: input.task.project_context } : {}),
    ...(input.task.handoff?.return_entry_id ? { return_entry_id: input.task.handoff.return_entry_id } : {}),
    agent_summary: lastAgentSummary(input.turn),
    git_preflight: gitEvidence(input.preflight),
    ...(input.postflight ? { git_postflight: gitEvidence(input.postflight) } : {}),
    evidence_methods: input.evidence.snapshot().events.map(event => event.method)
  }
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

  private async recoverPendingTurn(mapping: Zero3RemoteCodexMapping, clientId: string): Promise<string | null> {
    const deadline = Date.now() + 5_000
    do {
      const snapshot = await this.codex.readThread({ threadId: mapping.threadId, includeTurns: true })
      const recovered = findTurnByClientId(snapshot, clientId)
      if (recovered) return recovered.turnId
      if (Date.now() < deadline) await delay(250)
    } while (Date.now() < deadline)
    return null
  }

  async run(lease: Zero3RemoteLease, onEvidence?: (sequence: number, method: string, payload: unknown) => Promise<void>) {
    const task = validateTask(lease.task)
    const fingerprint = taskFingerprint(task)
    const allowedWorkspace = zero3RemoteWorkspaceAllowed(this.config, task.target.workspace)
    if (!allowedWorkspace) throw new Zero3RemoteTaskBlockedError('remote task workspace is not present in the local allow-list')
    const workspace = path.resolve(allowedWorkspace)
    const gitPreflight = await runGitPreflight(this.codex, workspace, task)

    let mapping = await this.mappings.get(task.task_id)
    if (mapping) {
      if (mapping.executionId !== task.execution_id) {
        throw new Zero3RemoteTaskBlockedError('task_id is already bound to a different execution_id')
      }
      if (mapping.taskFingerprint !== fingerprint) {
        throw new Zero3RemoteTaskBlockedError('task_id and execution_id are already bound to different remote task content')
      }
      if (path.resolve(mapping.workspace) !== workspace) {
        throw new Zero3RemoteTaskBlockedError('task_id is already bound to a different local workspace')
      }
      mapping = { ...mapping, turnIds: [...mapping.turnIds] }
    } else {
      // Remote tasks deliberately preserve the current Zero3 desktop safety
      // boundary: the host does not silently widen the default sandbox. Codex
      // remains authoritative for write/escalation approval.
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
        taskFingerprint: fingerprint,
        threadId,
        turnIds: [],
        workspace
      }
      await this.mappings.put(mapping)
    }

    const evidence = new Zero3RemoteEvidenceCollector(mapping)
    const gitPreflightEvidence = evidence.push('remote.git.preflight', gitEvidence(gitPreflight))
    if (onEvidence) await onEvidence(gitPreflightEvidence.sequence, gitPreflightEvidence.method, gitPreflightEvidence.params)
    const threadEvidence = evidence.push(mapping.turnIds.length ? 'remote.thread.resumed' : 'remote.thread.started', {
      threadId: mapping.threadId,
      workspace
    })
    if (onEvidence) await onEvidence(threadEvidence.sequence, threadEvidence.method, threadEvidence.params)

    let turnId = mapping.turnIds.at(-1) ?? null
    if (!turnId && mapping.pendingTurnClientId) {
      turnId = await this.recoverPendingTurn(mapping, mapping.pendingTurnClientId)
      if (!turnId) {
        throw new Zero3RemoteTaskOutcomeUnknownError(
          'a persisted Codex turn-start intent has no authoritative matching Turn; refusing to start a duplicate Turn'
        )
      }
      mapping.turnIds.push(turnId)
      delete mapping.pendingTurnClientId
      try {
        await this.mappings.put(mapping)
      } catch (error) {
        throw new Zero3RemoteTaskOutcomeUnknownError(
          `recovered Codex Turn ${turnId} but could not persist the recovered mapping: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      const recovered = evidence.push('remote.turn.recovered', { threadId: mapping.threadId, turnId })
      if (onEvidence) await onEvidence(recovered.sequence, recovered.method, recovered.params)
    }

    if (!turnId) {
      const clientUserMessageId = turnClientId(task)
      mapping.pendingTurnClientId = clientUserMessageId
      await this.mappings.put(mapping)

      let turnResult: unknown
      try {
        turnResult = await this.codex.startTurn(
          {
            threadId: mapping.threadId,
            clientUserMessageId,
            input: [{ type: 'text', text: taskPrompt(task, gitPreflight), text_elements: [] }]
          },
          30_000
        )
      } catch (error) {
        throw new Zero3RemoteTaskOutcomeUnknownError(
          `Codex turn/start returned without an authoritative Turn id after intent persistence: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      turnId = idFromResult(turnResult, 'Codex turn id')
      mapping.turnIds.push(turnId)
      delete mapping.pendingTurnClientId
      try {
        await this.mappings.put(mapping)
      } catch (error) {
        throw new Zero3RemoteTaskOutcomeUnknownError(
          `Codex Turn ${turnId} started but its durable mapping could not be finalized: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      const turnStarted = evidence.push('remote.turn.started', { threadId: mapping.threadId, turnId, clientUserMessageId })
      if (onEvidence) await onEvidence(turnStarted.sequence, turnStarted.method, turnStarted.params)
    } else {
      if (mapping.pendingTurnClientId) {
        delete mapping.pendingTurnClientId
        await this.mappings.put(mapping)
      }
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
        const gitPostflight = await runGitPostflight(this.codex, workspace, task, gitPreflight)
        const postflightEvidence = evidence.push('remote.git.postflight', gitEvidence(gitPostflight))
        if (onEvidence) await onEvidence(postflightEvidence.sequence, postflightEvidence.method, postflightEvidence.params)
        const executionResult = buildExecutionResult({
          task,
          mapping,
          state: 'succeeded',
          turnId,
          turn,
          preflight: gitPreflight,
          postflight: gitPostflight,
          evidence
        })
        const resultEvidence = evidence.push('remote.execution.result', executionResult)
        if (onEvidence) await onEvidence(resultEvidence.sequence, resultEvidence.method, resultEvidence.params)
        return {
          state: 'succeeded' as const,
          task,
          mapping,
          executionResult,
          terminal: { turnId, status },
          evidence: evidence.snapshot()
        }
      }
      if (status === 'failed' || status === 'interrupted') {
        const executionResult = buildExecutionResult({
          task,
          mapping,
          state: 'failed',
          turnId,
          turn,
          preflight: gitPreflight,
          evidence
        })
        const resultEvidence = evidence.push('remote.execution.result', executionResult)
        if (onEvidence) await onEvidence(resultEvidence.sequence, resultEvidence.method, resultEvidence.params)
        return {
          state: 'failed' as const,
          task,
          mapping,
          executionResult,
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

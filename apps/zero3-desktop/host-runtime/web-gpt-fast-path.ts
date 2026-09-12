import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'

import { loadZero3RemoteHostConfig, zero3RemoteWorkspaceAllowed } from './remote-config.ts'
import type { Zero3RemoteHostConfig } from './remote-types.ts'

export type Zero3ControlDispatchPort = {
  dispatchCodex(input: unknown): Promise<unknown>
}

export type Zero3FastPathCheck = 'git_diff_check' | 'cargo_fmt_check' | 'cargo_check_web' | 'desktop_typecheck'

type CommandResult = { stdout: string; stderr: string }
type CommandRunner = (command: string, args: string[], cwd: string, timeoutMs: number) => Promise<CommandResult>

const MAX_OUTPUT = 128 * 1024
const MAX_PATHS = 256
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return result
}

function id(value: unknown, label: string): string {
  const result = text(value, label, 256)
  if (!/^[A-Za-z0-9._:-]+$/u.test(result)) throw new Error(`${label} is invalid`)
  return result
}

function numberInRange(value: unknown, label: string, fallback: number, min: number, max: number): number {
  if (value == null) return fallback
  const result = Number(value)
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${label} must be ${min}..${max}`)
  return result
}

function stringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} items`)
  return value.map((entry, index) => text(entry, `${label}[${index}]`, maxLength))
}

function allowedWorkspace(config: Zero3RemoteHostConfig, value: unknown): string {
  const requested = text(value, 'workspace', 4096)
  const allowed = zero3RemoteWorkspaceAllowed(config, requested)
  if (!allowed) throw new Error('workspace is not in ZERO3_REMOTE_HOST_WORKSPACES')
  return allowed
}

export type Zero3AgentWorkspaceResolution = {
  workspace: string
  source: 'explicit' | 'project_binding' | 'session_binding' | 'project_session_binding'
}

export type Zero3AgentFastPathTelemetry = {
  timingMs: {
    bootstrap: number | null
    routing: number | null
    queue: number | null
    executor: number | null
    verification: number | null
    total: number
  }
  counts: { toolCalls: number | null; failovers: number }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function optionalBindingText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function lifecycleProjectBinding(contextValue: unknown): string | null {
  const context = recordValue(contextValue)
  const task = recordValue(context.task)
  const definition = recordValue(task.definition)
  const definitionTask = recordValue(definition.task)
  return optionalBindingText(definitionTask.projectId) ?? optionalBindingText(context.projectId)
}

function lifecycleSessionUrls(contextValue: unknown, sessionId: string): Set<string> {
  const context = recordValue(contextValue)
  const task = recordValue(context.task)
  const runtime = recordValue(task.runtime)
  const bindings = Array.isArray(runtime.sessionBindings) ? runtime.sessionBindings : []
  const urls = new Set<string>()
  for (const value of bindings) {
    const binding = recordValue(value)
    if (optionalBindingText(binding.logicalSessionId) !== sessionId) continue
    const url = optionalBindingText(binding.conversationUrl)
    if (url) urls.add(url)
  }
  return urls
}

export function resolveZero3AgentWorkspace(
  value: unknown,
  options: {
    config: Zero3RemoteHostConfig
    sessionId: string
    lifecycleContext: unknown
    projects: readonly unknown[]
    workspaceEntries: readonly unknown[]
  }
): Zero3AgentWorkspaceResolution {
  if (value != null && value !== '') {
    return { workspace: allowedWorkspace(options.config, value), source: 'explicit' }
  }

  const candidates = new Map<string, Set<'project_binding' | 'session_binding'>>()
  const add = (rootValue: unknown, source: 'project_binding' | 'session_binding') => {
    const root = optionalBindingText(rootValue)
    if (!root || !path.isAbsolute(root)) return
    const resolved = path.resolve(root)
    const sources = candidates.get(resolved) ?? new Set<'project_binding' | 'session_binding'>()
    sources.add(source)
    candidates.set(resolved, sources)
  }
  const projects = options.projects.map(recordValue)
  const projectId = lifecycleProjectBinding(options.lifecycleContext)
  if (projectId) {
    for (const project of projects) {
      if (optionalBindingText(project.id) === projectId || optionalBindingText(project.name) === projectId) {
        add(project.rootPath, 'project_binding')
      }
    }
  }

  const sessionUrls = lifecycleSessionUrls(options.lifecycleContext, options.sessionId)
  if (sessionUrls.size > 0) {
    for (const entryValue of options.workspaceEntries) {
      const entry = recordValue(entryValue)
      if (optionalBindingText(entry.kind) !== 'gpt_web') continue
      const conversationUrl = optionalBindingText(entry.conversationUrl)
      const currentUrl = optionalBindingText(entry.currentUrl)
      if ((!conversationUrl || !sessionUrls.has(conversationUrl)) && (!currentUrl || !sessionUrls.has(currentUrl))) continue
      const entryProjectId = optionalBindingText(entry.projectId)
      if (!entryProjectId) continue
      for (const project of projects) {
        if (optionalBindingText(project.id) === entryProjectId) add(project.rootPath, 'session_binding')
      }
    }
  }

  if (candidates.size === 0) {
    throw new Error('workspace could not be inferred from an authoritative Zero3 project/session binding')
  }
  if (candidates.size !== 1) {
    throw new Error('workspace inference is ambiguous across authoritative Zero3 project/session bindings')
  }
  const [candidate, sources] = [...candidates.entries()][0]
  const workspace = allowedWorkspace(options.config, candidate)
  const source = sources.has('project_binding') && sources.has('session_binding')
    ? 'project_session_binding'
    : sources.has('session_binding')
      ? 'session_binding'
      : 'project_binding'
  return { workspace, source }
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function isoMs(value: unknown): number | null {
  const text = optionalBindingText(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

export function summarizeZero3AgentFastPathTelemetry(
  recordValueInput: unknown,
  marks: { startedAtMs: number; dispatchStartedAtMs: number; completedAtMs: number }
): Zero3AgentFastPathTelemetry {
  const record = recordValue(recordValueInput)
  const attempts = Array.isArray(record.attempts) ? record.attempts.map(recordValue) : []
  let routing: number | null = attempts.length > 0 ? 0 : null
  let cursor = marks.dispatchStartedAtMs
  for (const attempt of attempts) {
    const startedAt = isoMs(attempt.startedAt)
    if (startedAt == null) { routing = null; break }
    if (routing != null) routing += Math.max(0, startedAt - cursor)
    const finishedAt = isoMs(attempt.finishedAt)
    cursor = finishedAt == null ? startedAt : Math.max(startedAt, finishedAt)
  }

  const result = recordValue(record.result)
  const timing = recordValue(result.timing)
  const queue = finiteNonNegative(timing.queueLatencyMs)
  const executor = finiteNonNegative(timing.executionLatencyMs)
  const verification = finiteNonNegative(timing.verificationLatencyMs)
  const failovers = attempts.filter(attempt => optionalBindingText(attempt.failoverReason) != null).length
  return {
    timingMs: {
      bootstrap: Math.max(0, marks.dispatchStartedAtMs - marks.startedAtMs),
      routing,
      queue,
      executor,
      verification,
      total: Math.max(0, marks.completedAtMs - marks.startedAtMs)
    },
    counts: { toolCalls: null, failovers }
  }
}

function stableExecutionId(sessionId: string, key: string, suffix: string): string {
  const digest = createHash('sha256').update(`${sessionId}\0${key}\0${suffix}`).digest('hex').slice(0, 24)
  return `web-gpt-${suffix}-${digest}`
}

export async function dispatchZero3CodexTask(
  control: Zero3ControlDispatchPort,
  inputValue: unknown,
  options: { config?: Zero3RemoteHostConfig; projectContext?: Record<string, unknown> } = {}
): Promise<Record<string, unknown>> {
  const started = Date.now()
  const input = object(inputValue, 'dispatch_codex_task input')
  const config = options.config ?? loadZero3RemoteHostConfig()
  const sessionId = id(input.sessionId, 'sessionId')
  const key = id(input.idempotencyKey, 'idempotencyKey')
  const workspace = allowedWorkspace(config, input.workspace)
  const objective = text(input.objective, 'objective', 64_000)
  const permissionProfile = String(input.permissionProfile ?? 'standard')
  if (!['read_only', 'standard', 'elevated'].includes(permissionProfile)) throw new Error('permissionProfile is not allowed for Web GPT Fast Path')
  const maxTurns = numberInRange(input.maxTurns, 'maxTurns', 1, 1, 8)
  const timeoutSeconds = numberInRange(input.timeoutSeconds, 'timeoutSeconds', 3600, 30, 28_800)
  const taskId = stableExecutionId(sessionId, key, 'task')
  const executionId = stableExecutionId(sessionId, key, 'exec')
  const task = {
    protocol: 'zero3.pilot.remote-task.v1',
    task_id: taskId,
    execution_id: executionId,
    objective,
    target: {
      workspace,
      ...(input.baseRef == null ? {} : { base_ref: text(input.baseRef, 'baseRef', 256) })
    },
    constraints: stringList(input.constraints, 'constraints', 64, 4096),
    acceptance_criteria: stringList(input.acceptanceCriteria, 'acceptanceCriteria', 64, 4096),
    permission_profile: permissionProfile,
    execution: {
      max_turns: maxTurns,
      timeout_seconds: timeoutSeconds,
      require_clean_worktree: input.requireCleanWorktree === true,
      require_clean_worktree_on_success: input.requireCleanWorktreeOnSuccess === true,
      require_remote_sync_on_success: input.requireRemoteSyncOnSuccess === true
    }
  }
  const extension = options.projectContext ? { project_context: options.projectContext } : undefined
  const controlResult = await control.dispatchCodex({ task, ...(extension ? { extension } : {}) })
  return {
    dispatched: true,
    taskId,
    executionId,
    workspace,
    control: controlResult,
    timingMs: { total: Date.now() - started }
  }
}

async function defaultRunner(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: Buffer) => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT)
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${(stderr || stdout).trim().slice(-4096)}`))
    })
  })
}

function normalizedOwnedPaths(workspace: string, value: unknown): string[] {
  const raw = stringList(value, 'paths', MAX_PATHS, 4096)
  if (raw.length === 0) throw new Error('paths must contain at least one task-owned path')
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (path.isAbsolute(entry)) throw new Error('task-owned paths must be relative to workspace')
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
    if (!normalized || normalized === '.git' || normalized.startsWith('.git/') || normalized.split('/').includes('..')) {
      throw new Error(`unsafe task-owned path: ${entry}`)
    }
    const resolved = path.resolve(workspace, normalized)
    const relative = path.relative(workspace, resolved).replaceAll('\\', '/')
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(`task-owned path escapes workspace: ${entry}`)
    if (!seen.has(relative)) { seen.add(relative); result.push(relative) }
  }
  return result
}

function pathOwned(candidate: string, owned: string[]): boolean {
  const clean = candidate.replaceAll('\\', '/').replace(/^\.\//u, '')
  return owned.some(entry => clean === entry || clean.startsWith(`${entry}/`))
}

function nulList(value: string): string[] {
  return value.split('\0').map(item => item.trim()).filter(Boolean)
}

function executable(name: 'npm' | 'cargo' | 'git'): string {
  return process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name
}

async function runChecks(runner: CommandRunner, workspace: string, checks: Zero3FastPathCheck[], owned: string[]): Promise<Array<{ check: string; ok: true; durationMs: number }>> {
  const results: Array<{ check: string; ok: true; durationMs: number }> = []
  for (const check of checks) {
    const started = Date.now()
    if (check === 'git_diff_check') await runner(executable('git'), ['diff', '--check', '--', ...owned], workspace, DEFAULT_TIMEOUT_MS)
    else if (check === 'cargo_fmt_check') await runner(executable('cargo'), ['fmt', '--all', '--', '--check'], workspace, DEFAULT_TIMEOUT_MS)
    else if (check === 'cargo_check_web') await runner(executable('cargo'), ['check', '-p', 'zero3-web'], workspace, DEFAULT_TIMEOUT_MS)
    else if (check === 'desktop_typecheck') {
      const desktop = path.join(workspace, 'apps', 'zero3-desktop')
      if (process.platform === 'win32') {
        await runner(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run typecheck'], desktop, DEFAULT_TIMEOUT_MS)
      } else {
        await runner('npm', ['run', 'typecheck'], desktop, DEFAULT_TIMEOUT_MS)
      }
    } else throw new Error(`unsupported verification check: ${check}`)
    results.push({ check, ok: true, durationMs: Date.now() - started })
  }
  return results
}

async function git(runner: CommandRunner, workspace: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  return runner(executable('git'), args, workspace, timeoutMs)
}

async function pushCurrentBranch(runner: CommandRunner, workspace: string, branch: string): Promise<void> {
  await git(runner, workspace, ['remote', 'get-url', 'origin'])
  await git(runner, workspace, ['check-ref-format', '--branch', branch])
  await git(runner, workspace, ['push', 'origin', `HEAD:refs/heads/${branch}`])
}

export async function verifyZero3Commit(
  inputValue: unknown,
  options: { config?: Zero3RemoteHostConfig; runner?: CommandRunner } = {}
): Promise<Record<string, unknown>> {
  const started = Date.now()
  const input = object(inputValue, 'verify_commit input')
  const config = options.config ?? loadZero3RemoteHostConfig()
  const runner = options.runner ?? defaultRunner
  id(input.sessionId, 'sessionId')
  const key = id(input.idempotencyKey, 'idempotencyKey')
  const workspace = allowedWorkspace(config, input.workspace)
  const owned = normalizedOwnedPaths(workspace, input.paths)
  const message = text(input.commitMessage, 'commitMessage', 512)
  const checks = stringList(input.checks, 'checks', 8, 64) as Zero3FastPathCheck[]
  if (checks.length === 0) throw new Error('checks must contain at least one approved static verification check')
  const allowedChecks = new Set<Zero3FastPathCheck>(['git_diff_check', 'cargo_fmt_check', 'cargo_check_web', 'desktop_typecheck'])
  for (const check of checks) if (!allowedChecks.has(check)) throw new Error(`unsupported verification check: ${check}`)

  const root = path.resolve((await git(runner, workspace, ['rev-parse', '--show-toplevel'])).stdout.trim())
  if (root !== path.resolve(workspace)) throw new Error('verify_commit workspace must be the repository root')
  const branch = (await git(runner, workspace, ['branch', '--show-current'])).stdout.trim()
  if (!branch) throw new Error('verify_commit refuses a detached HEAD')
  const trailer = `Zero3-Idempotency-Key: ${key}`
  const headMessage = (await git(runner, workspace, ['log', '-1', '--format=%B'])).stdout
  const scopedStatus = (await git(runner, workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...owned])).stdout
  if (headMessage.includes(trailer)) {
    if (scopedStatus) throw new Error('idempotencyKey is already committed but task-owned paths changed again')
    const committedPaths = nulList((await git(runner, workspace, ['show', '--format=', '--name-only', '-z', 'HEAD'])).stdout)
    if (committedPaths.some(candidate => !pathOwned(candidate, owned))) throw new Error('idempotent commit contains paths outside the declared task scope')
    await pushCurrentBranch(runner, workspace, branch)
    const head = (await git(runner, workspace, ['rev-parse', 'HEAD'])).stdout.trim()
    return { verified: true, committed: true, pushed: true, resumed: true, branch, commit: head, paths: committedPaths, checks: [], timingMs: { total: Date.now() - started } }
  }

  const stagedBefore = nulList((await git(runner, workspace, ['diff', '--cached', '--name-only', '-z'])).stdout)
  if (stagedBefore.some(candidate => !pathOwned(candidate, owned))) throw new Error('pre-staged changes outside task-owned paths block verify_commit')
  if (!scopedStatus) throw new Error('no task-owned changes to verify and commit')

  const checkResults = await runChecks(runner, workspace, checks, owned)
  await git(runner, workspace, ['add', '--', ...owned])
  const staged = nulList((await git(runner, workspace, ['diff', '--cached', '--name-only', '-z'])).stdout)
  if (staged.length === 0) throw new Error('no task-owned changes were staged')
  if (staged.some(candidate => !pathOwned(candidate, owned))) throw new Error('staging escaped declared task-owned paths')
  await git(runner, workspace, ['diff', '--cached', '--check'])
  await git(runner, workspace, ['commit', '-m', message, '-m', trailer])
  await pushCurrentBranch(runner, workspace, branch)
  const head = (await git(runner, workspace, ['rev-parse', 'HEAD'])).stdout.trim()
  return { verified: true, committed: true, pushed: true, resumed: false, branch, commit: head, paths: staged, checks: checkResults, timingMs: { total: Date.now() - started } }
}

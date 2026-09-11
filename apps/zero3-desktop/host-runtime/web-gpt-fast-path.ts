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

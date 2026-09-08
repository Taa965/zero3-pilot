import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

import { createExecutorFailure } from '../failure-normalizer.ts'
import { resolveWindowsCommand } from './windows-command.ts'
import {
  ZERO3_EXECUTOR_CONTRACT,
  ZERO3_HANDOFF_PROTOCOL,
  type ExecutorEvent,
  type ExecutorFailureCode,
  type ExecutorHandoffCheckpointRef,
  type ExecutorInput,
  type ExecutorPermissionResponse,
  type ExecutorProbe,
  type ExecutorSession,
  type ExecutorSessionRef,
  type ExecutorStartContext,
  type Zero3Executor
} from '../executor-types.ts'

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024

export type ClaudeCliRunRequest = {
  command: string
  args: string[]
  cwd?: string
  signal?: AbortSignal
}

export type ClaudeCliRunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  aborted?: boolean
}

export interface ClaudeCliRunner {
  run(request: ClaudeCliRunRequest): Promise<ClaudeCliRunResult>
}

export interface ClaudeExecutorOptions {
  id?: string
  label?: string
  command?: string
  model?: string
  mcpConfig?: string
  strictMcpConfig?: boolean
  now?: () => string
  runner?: ClaudeCliRunner
}

type ClaudeSessionState = {
  workspace: string
  generation: number
  permissionMode: 'dontAsk' | 'acceptEdits'
  cliSessionId: string | null
  abortController: AbortController | null
}

type ClaudeJsonResult = {
  result?: unknown
  session_id?: unknown
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
  } | null
  total_cost_usd?: unknown
  is_error?: unknown
  error?: unknown
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} must be non-empty`)
  return normalized
}

function capturedText(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8')
}

export class NodeClaudeCliRunner implements ClaudeCliRunner {
  run(request: ClaudeCliRunRequest): Promise<ClaudeCliRunResult> {
    return new Promise((resolve, reject) => {
      const resolved = resolveWindowsCommand(request.command)
      const child = spawn(resolved.command, [...resolved.args, ...request.args], {
        ...(request.cwd ? { cwd: request.cwd } : {}),
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let aborted = false

      const finish = (value: ClaudeCliRunResult) => {
        if (settled) return
        settled = true
        request.signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        request.signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
      const onAbort = () => {
        aborted = true
        child.kill()
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted) onAbort()

      child.stdout.on('data', chunk => {
        const buffer = Buffer.from(chunk)
        stdoutBytes += buffer.byteLength
        if (stdoutBytes > MAX_CAPTURE_BYTES) {
          child.kill()
          fail(new Error('Claude CLI stdout exceeded capture limit'))
          return
        }
        stdout.push(buffer)
      })
      child.stderr.on('data', chunk => {
        const buffer = Buffer.from(chunk)
        stderrBytes += buffer.byteLength
        if (stderrBytes > MAX_CAPTURE_BYTES) {
          child.kill()
          fail(new Error('Claude CLI stderr exceeded capture limit'))
          return
        }
        stderr.push(buffer)
      })
      child.once('error', error => fail(error))
      child.once('close', code => finish({ exitCode: code, stdout: capturedText(stdout), stderr: capturedText(stderr), aborted }))
    })
  }
}

function errorText(result: ClaudeCliRunResult): string {
  return `${result.stderr}\n${result.stdout}`.trim()
}

export function mapClaudeFailure(result: ClaudeCliRunResult): ExecutorFailureCode {
  if (result.aborted) return 'user_stopped'
  const value = errorText(result).toLowerCase()

  if (/model_context_window_exceeded|context window|maximum context|context length|prompt (is )?too long|too many tokens/.test(value)) {
    return 'context_exhausted'
  }
  if (/usage limit|quota (is )?(exhausted|exceeded)|quota_exhausted|credit balance|credits? exhausted|monthly limit|spend(ing)? limit|billing_error.*(limit|credit|quota)/.test(value)) {
    return 'quota_exhausted'
  }
  if (/rate[_ -]?limit|too many requests|\b429\b/.test(value)) return 'rate_limited'
  if (/authentication_failed|auth(entication)? required|not logged in|login required|unauthorized|\b401\b/.test(value)) return 'auth_required'
  if (/permission denied|forbidden|\b403\b/.test(value)) return 'permission_denied'
  if (/overloaded|overload_error|\b529\b/.test(value)) return 'provider_overloaded'
  if (/invalid_request|bad request|\b400\b/.test(value)) return 'bad_request'
  if (/econnreset|econnrefused|enotfound|network error|socket hang up|transport/.test(value)) return 'transport_lost'
  if (/billing_error/.test(value)) return 'provider_error'
  return result.exitCode && result.exitCode !== 0 ? 'process_crash' : 'provider_error'
}

function parseJson(stdout: string): ClaudeJsonResult | null {
  try {
    const value = JSON.parse(stdout) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as ClaudeJsonResult : null
  } catch {
    return null
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function permissionMode(context: ExecutorStartContext): ClaudeSessionState['permissionMode'] {
  // Match Zero3's permission profile rather than treating approvalRequired as read-only.
  // Native Codex uses workspace-write for standard/elevated even with on-request approvals;
  // Claude acceptEdits is the closest fail-closed headless equivalent: workspace edits are
  // allowed, while non-filesystem tools and protected paths still require/deny approval.
  if (context.policy.permissionProfile === 'read_only') return 'dontAsk'
  return 'acceptEdits'
}

function ensureSession(executorId: string, session: ExecutorSession | ExecutorSessionRef): void {
  if (session.executorId !== executorId) throw new Error('Claude session belongs to a different executor')
  requireNonEmpty(session.sessionId, 'sessionId')
  if (!Number.isSafeInteger(session.generation) || session.generation < 1) throw new Error('Claude session generation must be a positive safe integer')
}

export class ClaudeExecutor implements Zero3Executor {
  readonly descriptor
  readonly #runner: ClaudeCliRunner
  readonly #command: string
  readonly #now: () => string
  readonly #sessions = new Map<string, ClaudeSessionState>()

  constructor(private readonly options: ClaudeExecutorOptions = {}) {
    this.descriptor = {
      id: requireNonEmpty(options.id ?? 'claude', 'executor id'),
      kind: 'external-agent' as const,
      label: requireNonEmpty(options.label ?? 'Claude Code', 'executor label')
    }
    this.#runner = options.runner ?? new NodeClaudeCliRunner()
    this.#command = requireNonEmpty(options.command ?? 'claude', 'Claude CLI command')
    if (options.mcpConfig != null) requireNonEmpty(options.mcpConfig, 'Claude MCP config')
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async probe(): Promise<ExecutorProbe> {
    try {
      const result = await this.#runner.run({ command: this.#command, args: ['auth', 'status'] })
      if (result.exitCode === 0) return { executorId: this.descriptor.id, status: 'ready' }
      const code = mapClaudeFailure(result)
      return {
        executorId: this.descriptor.id,
        status: code === 'auth_required' ? 'auth_required' : 'unavailable',
        detail: errorText(result).slice(0, 2_000) || `Claude CLI exited with code ${result.exitCode}`
      }
    } catch (error) {
      return {
        executorId: this.descriptor.id,
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async start(context: ExecutorStartContext): Promise<ExecutorSession> {
    if (context.contract !== ZERO3_EXECUTOR_CONTRACT) throw new Error('unsupported Zero3 Executor Contract')
    const workspace = requireNonEmpty(context.identity.workspace, 'workspace')
    if (!Number.isSafeInteger(context.generation) || context.generation < 1) throw new Error('generation must be a positive safe integer')
    if (context.handoff && context.handoff.protocol !== ZERO3_HANDOFF_PROTOCOL) throw new Error('unsupported handoff checkpoint protocol')

    const sessionId = `claude-${randomUUID()}`
    this.#sessions.set(sessionId, {
      workspace,
      generation: context.generation,
      permissionMode: permissionMode(context),
      cliSessionId: null,
      abortController: null
    })
    return { executorId: this.descriptor.id, sessionId, generation: context.generation, startedAt: this.#now() }
  }

  async resume(ref: ExecutorSessionRef, checkpoint: ExecutorHandoffCheckpointRef): Promise<ExecutorSession> {
    ensureSession(this.descriptor.id, ref)
    if (checkpoint.protocol !== ZERO3_HANDOFF_PROTOCOL) throw new Error('unsupported handoff checkpoint protocol')
    if (checkpoint.generation !== ref.generation) throw new Error('handoff generation does not match Claude session')
    if (!this.#sessions.has(ref.sessionId)) {
      const error = new Error('Claude session state is not available in this process; a handoff is required')
      ;(error as Error & { failure?: unknown }).failure = createExecutorFailure('context_lost', error.message, this.descriptor.id)
      throw error
    }
    return { ...ref, startedAt: this.#now() }
  }

  async *prompt(session: ExecutorSession, input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    ensureSession(this.descriptor.id, session)
    const state = this.#sessions.get(session.sessionId)
    if (!state) throw new Error('Claude session state is unavailable')
    if (state.generation !== session.generation) throw new Error('Claude session generation mismatch')
    if (state.abortController) throw new Error('Claude session already has a prompt in flight')

    const controller = new AbortController()
    state.abortController = controller
    let sequence = 0
    try {
      const args = ['-p', input.text, '--output-format', 'json', '--permission-mode', state.permissionMode]
      const mcpConfig = this.options.mcpConfig?.trim()
      if (mcpConfig) {
        if (this.options.strictMcpConfig !== false) args.push('--strict-mcp-config')
        args.push('--mcp-config', mcpConfig)
      }
      if (state.cliSessionId) args.push('--resume', state.cliSessionId)
      if (this.options.model?.trim()) args.push('--model', this.options.model.trim())
      const run = await this.#runner.run({ command: this.#command, args, cwd: state.workspace, signal: controller.signal })
      const parsed = parseJson(run.stdout)
      const failed = run.exitCode !== 0 || parsed?.is_error === true
      if (failed) {
        const combined = parsed?.error ? `${errorText(run)}\n${String(parsed.error)}` : errorText(run)
        sequence += 1
        yield {
          type: 'failure',
          sequence,
          at: this.#now(),
          failure: createExecutorFailure(mapClaudeFailure({ ...run, stdout: `${run.stdout}\n${combined}` }), combined || 'Claude CLI failed', this.descriptor.id)
        }
        sequence += 1
        yield { type: 'completed', sequence, at: this.#now(), outcome: run.aborted ? 'cancelled' : 'failed' }
        return
      }

      if (!parsed) {
        sequence += 1
        yield {
          type: 'failure',
          sequence,
          at: this.#now(),
          failure: createExecutorFailure('provider_error', 'Claude CLI returned invalid JSON output', this.descriptor.id)
        }
        sequence += 1
        yield { type: 'completed', sequence, at: this.#now(), outcome: 'failed' }
        return
      }

      if (typeof parsed.session_id === 'string' && parsed.session_id.trim()) state.cliSessionId = parsed.session_id.trim()
      if (typeof parsed.result === 'string' && parsed.result) {
        sequence += 1
        yield { type: 'message', sequence, at: this.#now(), text: parsed.result }
      }
      const inputTokens = positiveNumber(parsed.usage?.input_tokens)
      const outputTokens = positiveNumber(parsed.usage?.output_tokens)
      const costUsd = positiveNumber(parsed.total_cost_usd)
      if (inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined) {
        sequence += 1
        yield {
          type: 'usage.updated',
          sequence,
          at: this.#now(),
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(costUsd !== undefined ? { costUsd } : {})
          }
        }
      }
      sequence += 1
      yield { type: 'completed', sequence, at: this.#now(), outcome: 'succeeded' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sequence += 1
      yield {
        type: 'failure',
        sequence,
        at: this.#now(),
        failure: createExecutorFailure(
          controller.signal.aborted ? 'user_stopped' : mapClaudeFailure({ exitCode: 1, stdout: '', stderr: message }),
          message,
          this.descriptor.id
        )
      }
      sequence += 1
      yield { type: 'completed', sequence, at: this.#now(), outcome: controller.signal.aborted ? 'cancelled' : 'failed' }
    } finally {
      state.abortController = null
    }
  }

  async respondPermission(session: ExecutorSession, _response: ExecutorPermissionResponse): Promise<void> {
    ensureSession(this.descriptor.id, session)
    throw new Error('Claude headless executor does not expose an interactive permission bridge; start it with an appropriate fail-closed permission policy')
  }

  async cancel(session: ExecutorSession): Promise<void> {
    ensureSession(this.descriptor.id, session)
    this.#sessions.get(session.sessionId)?.abortController?.abort()
  }

  async close(session: ExecutorSession): Promise<void> {
    ensureSession(this.descriptor.id, session)
    const state = this.#sessions.get(session.sessionId)
    state?.abortController?.abort()
    this.#sessions.delete(session.sessionId)
  }
}

import {
  ZERO3_EXECUTION_RESULT_V2,
  type Zero3ExecutionFailure,
  type Zero3ExecutionResultV2,
  type Zero3TaskSpecV2,
  type Zero3ArtifactRef
} from './agent-contracts'
import type { Zero3ProviderAvailabilityState } from './agent-router'
import type { Zero3ResolvedTaskSkill } from '../skill-runtime/skill-types'
import { renderZero3AgentTaskPrompt } from './task-prompt'
import { classifyExecutorError, createExecutorFailure } from './zero3-executor-failure'
import {
  Zero3Zero3ApiAvailabilityProbe,
  type Zero3ApiHealthObservation,
  type Zero3ApiProbeProfile,
  type Zero3ApiProbeResult
} from './zero3-api-availability'

// One real Zero3 API session turn. The port is bound by the host to the existing
// session-provider runtime (API profile -> Codex Agent Kernel thread with the
// profile's model as the provider). The adapter never speaks HTTP to a model
// provider itself and never sees an API key.
export type Zero3Zero3ApiTurnRequest = {
  profileId: string
  prompt: string
  projectId: string
  cwd: string
  taskId: string
  executionId: string
  // Executor-enforced sandbox. The Zero3 API executor is a read-only reasoning
  // executor: it may inspect the workspace, never mutate it.
  sandbox: 'read-only'
  threadId?: string | null
  timeoutMs: number
}

export type Zero3Zero3ApiTurnResult = {
  text: string
  threadId: string
  model: string
  profileId: string
  // Null fields mean the provider did not report the value.
  usage?: {
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
  } | null
}

export type Zero3Zero3ApiSessionPort = {
  listProfiles(): Promise<readonly Zero3ApiProbeProfile[]>
  runTurn(request: Zero3Zero3ApiTurnRequest): Promise<Zero3Zero3ApiTurnResult>
}

export type Zero3Zero3ApiTaskAdapterOptions = {
  port: Zero3Zero3ApiSessionPort
  probe: Zero3Zero3ApiAvailabilityProbe
  // Hard ceiling for one turn. Kept below the session-provider bridge timeout so
  // the adapter classifies the timeout instead of the bridge throwing a generic
  // transport error.
  timeoutMs?: number
  now?: () => string
  nowMs?: () => number
}

const DEFAULT_TURN_TIMEOUT_MS = 9 * 60_000
const MAX_SUMMARY_CHARS = 8_000
const MAX_OUTPUT_CHARS = 200_000
const MAX_PROMPT_CHARS = 200_000

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown, max = MAX_SUMMARY_CHARS): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.length > max ? `${raw.slice(0, max)}…` : raw
}

function stringArray(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string').map(item => (item as string).trim()).filter(Boolean).slice(0, max)
}

function statusOf(value: unknown): Zero3ExecutionResultV2['status'] | null {
  return value === 'COMPLETE' || value === 'PARTIAL' || value === 'BLOCKED' || value === 'FAILED' || value === 'OUTCOME_UNKNOWN'
    ? value
    : null
}

function recommendedActionOf(value: unknown): Zero3ExecutionResultV2['recommendedAction'] | null {
  return value === 'GPT_REVIEW' || value === 'HUMAN_REVIEW' || value === 'CODEX_IMPLEMENT' || value === 'RETRY' ? value : null
}

function artifactRefsOf(value: unknown): Zero3ArtifactRef[] {
  if (!Array.isArray(value)) return []
  const out: Zero3ArtifactRef[] = []
  for (const item of value.slice(0, 200)) {
    const entry = record(item)
    const artifactId = text(entry.artifactId, 256)
    const kind = text(entry.kind, 128)
    const pathOrUri = text(entry.pathOrUri, 2_000)
    const hash = text(entry.hash, 256)
    if (!artifactId || !kind || !pathOrUri || !hash) continue
    out.push({
      artifactId,
      kind,
      pathOrUri,
      hash,
      sourceProvider: 'ZERO3_API',
      sourceCycle: Number.isSafeInteger(entry.sourceCycle) ? Number(entry.sourceCycle) : 1,
      createdAt: text(entry.createdAt, 64) || new Date().toISOString()
    })
  }
  return out
}

// A model answer is untrusted text. Zero3 asks for a fenced JSON object and, when
// the model does not produce one, keeps the raw answer as `output.text` with a
// clearly derived summary instead of pretending the answer was structured.
export function parseZero3ApiStructuredOutput(value: string): { structured: JsonRecord | null; raw: string } {
  const raw = value.trim()
  if (!raw) return { structured: null, raw }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], raw]
  for (const candidate of candidates) {
    const body = candidate?.trim()
    if (!body || !body.startsWith('{')) continue
    try {
      const parsed = JSON.parse(body) as unknown
      const parsedRecord = record(parsed)
      if (Object.keys(parsedRecord).length > 0) return { structured: parsedRecord, raw }
    } catch {
      // Not the structured envelope; fall through to the next candidate.
    }
  }
  return { structured: null, raw }
}

function resultStatusFor(failure: Zero3ExecutionFailure): Zero3ExecutionResultV2['status'] {
  if (failure.class === 'waiting_human') return 'BLOCKED'
  if (failure.class === 'terminal') return 'FAILED'
  return 'FAILED'
}

function recommendedActionFor(failure: Zero3ExecutionFailure): Zero3ExecutionResultV2['recommendedAction'] {
  return failure.class === 'waiting_human' ? 'HUMAN_REVIEW' : failure.retryable ? 'RETRY' : 'HUMAN_REVIEW'
}

// The executor contract handed to the model. It is deliberately explicit about
// the read-only sandbox and about returning structured JSON, because a bare
// string is not an acceptable executor result.
function zero3ApiTaskInstructions(task: Zero3TaskSpecV2): string {
  return [
    'You are a Zero3 Pilot executor running a single task turn.',
    'The workspace is read-only for this turn: you may inspect files and use read-only tools, but you must not mutate the computer, the repository or any remote system.',
    'If the task asks for a write, a commit, a build or any other mutation, do not attempt it: report status BLOCKED and explain which executor is required instead.',
    `Task identity: taskId=${task.taskId} executionId=${task.executionId} projectId=${task.projectId} contextVersion=${String(task.contextVersion)}.`,
    'Do not invent verification results, artifact hashes, git SHAs or changed files. Zero3 re-derives those facts independently.',
    'Answer with exactly one fenced JSON object and no prose outside it, using this shape:',
    '```json',
    '{"status":"COMPLETE|PARTIAL|BLOCKED|FAILED","summary":"one paragraph","output":{},"knownIssues":[],"blockers":[],"recommendedAction":"GPT_REVIEW|HUMAN_REVIEW|CODEX_IMPLEMENT|RETRY"}',
    '```',
    'Use PARTIAL when the analysis is usable but incomplete, and BLOCKED when the task requires capabilities this executor does not have.'
  ].join('\n')
}

export class Zero3Zero3ApiTaskAdapter {
  readonly #port: Zero3Zero3ApiSessionPort
  readonly #probe: Zero3Zero3ApiAvailabilityProbe
  readonly #timeoutMs: number
  readonly #now: () => string
  readonly #nowMs: () => number

  constructor(options: Zero3Zero3ApiTaskAdapterOptions) {
    this.#port = options.port
    this.#probe = options.probe
    this.#timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? options.timeoutMs!
      : DEFAULT_TURN_TIMEOUT_MS
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#nowMs = options.nowMs ?? (() => Date.now())
  }

  // Provider availability for the router. The probe owns profile/auth/quota
  // state so the adapter and the routing plane cannot disagree.
  async availability(): Promise<Zero3ApiProbeResult> {
    return this.#probe.probe()
  }

  async dispatchTask(
    task: Zero3TaskSpecV2,
    skills: readonly Zero3ResolvedTaskSkill[] = [],
    skillContext = ''
  ): Promise<Zero3ExecutionResultV2> {
    const startedAtMs = this.#nowMs()
    const profiles = await this.#safeProfiles()
    const profile = this.#probe.selectProfile(profiles)
    if (!profile) {
      const failure = createExecutorFailure('bad_request', 'no Zero3 API profile is configured')
      return this.#failureResult(task, null, failure, startedAtMs)
    }

    const workspace = task.worktreePath?.trim() || ''
    if (!workspace) {
      // A TaskSpec without a workspace is unusable for every executor here, so
      // switching providers cannot help: stop instead of burning the attempt
      // budget on the same defect.
      const failure = createExecutorFailure('bad_request', 'Zero3 API tasks require an explicit workspace path')
      return this.#failureResult(task, profile.id, failure, startedAtMs)
    }

    const prompt = [
      zero3ApiTaskInstructions(task),
      skillContext.trim(),
      renderZero3AgentTaskPrompt(task)
    ].filter(Boolean).join('\n\n')

    let turn: Zero3Zero3ApiTurnResult
    try {
      turn = await this.#port.runTurn({
        profileId: profile.id,
        prompt: prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt,
        projectId: task.projectId,
        cwd: workspace,
        taskId: task.taskId,
        executionId: task.executionId,
        sandbox: 'read-only',
        timeoutMs: this.#timeoutMs
      })
    } catch (error) {
      const failure = classifyExecutorError(error)
      await this.#recordHealth(failure, this.#nowMs() - startedAtMs)
      return this.#failureResult(task, profile.id, failure, startedAtMs)
    }

    const executionLatencyMs = this.#nowMs() - startedAtMs
    const raw = typeof turn.text === 'string' ? turn.text : ''
    if (!raw.trim()) {
      const failure = createExecutorFailure('provider_error', 'Zero3 API turn completed without returning any model output')
      await this.#recordHealth(failure, executionLatencyMs)
      return this.#failureResult(task, profile.id, failure, startedAtMs, turn)
    }
    await this.#probe.noteSuccess()

    const parsed = parseZero3ApiStructuredOutput(raw)
    const structured = parsed.structured
    const status = statusOf(structured?.status) ?? 'COMPLETE'
    const summary = text(structured?.summary) || text(raw)
    const output: JsonRecord = structured
      ? { ...record(structured.output), envelope: structured }
      : { text: text(raw, MAX_OUTPUT_CHARS), structured: false }
    const knownIssues = stringArray(structured?.knownIssues)
    const blockers = stringArray(structured?.blockers)
    // An executor that reports BLOCKED -- or a partial answer that carries a
    // blocker -- is saying "my tools are not enough for this objective". The
    // router treats that as a capability gap and continues with an executor that
    // can finish the task, instead of parking it on a human. (The authoritative
    // finalizer independently keeps any blocked result out of COMPLETE.)
    const capabilityGap = status === 'BLOCKED' || (status === 'PARTIAL' && blockers.length > 0)
    const declaredCapabilityGap = capabilityGap
      ? createExecutorFailure('unsupported', summary || blockers[0] || 'the Zero3 API executor could not complete this objective')
      : null

    return {
      protocol: ZERO3_EXECUTION_RESULT_V2,
      taskId: task.taskId,
      executionId: task.executionId,
      projectId: task.projectId,
      provider: 'ZERO3_API',
      providerRuntime: 'ZERO3_API_SESSION',
      executorId: `ZERO3_API:${turn.profileId || profile.id}`,
      status,
      contextVersion: task.contextVersion,
      conversationId: turn.threadId || null,
      summary: summary || 'Zero3 API executor returned no summary.',
      output,
      changedFiles: [],
      artifacts: artifactRefsOf(structured?.artifacts),
      git: task.baseSha || task.branch
        ? { baseSha: task.baseSha ?? null, branch: task.branch ?? null }
        : null,
      // Provider-claimed verification is never authoritative: like the Codex and
      // Claude adapters, the Zero3 API executor reports none and the verification
      // collector derives the real evidence from the worktree.
      verification: [],
      knownIssues,
      blockers,
      recommendedAction: recommendedActionOf(structured?.recommendedAction) ?? (status === 'COMPLETE' || status === 'PARTIAL' ? 'GPT_REVIEW' : 'HUMAN_REVIEW'),
      usage: {
        inputTokens: turn.usage?.inputTokens ?? null,
        outputTokens: turn.usage?.outputTokens ?? null,
        totalTokens: turn.usage?.totalTokens ?? null,
        costUsd: null,
        model: turn.model || profile.model
      },
      timing: {
        queueLatencyMs: null,
        executionLatencyMs,
        totalLatencyMs: executionLatencyMs
      },
      failure: declaredCapabilityGap,
      completedAt: this.#now()
    }
  }

  async #safeProfiles(): Promise<readonly Zero3ApiProbeProfile[]> {
    try {
      return await this.#port.listProfiles()
    } catch {
      return []
    }
  }

  async #recordHealth(failure: Zero3ExecutionFailure, latencyMs: number): Promise<void> {
    const observation: Zero3ApiHealthObservation = {
      failureCode: failure.code,
      failureClass: failure.class,
      detail: failure.detail,
      latencyMs
    }
    try {
      await this.#probe.noteOutcome(observation)
    } catch {
      // Availability feedback must never break the adapter.
    }
  }

  #failureResult(
    task: Zero3TaskSpecV2,
    profileId: string | null,
    failure: Zero3ExecutionFailure,
    startedAtMs: number,
    turn?: Zero3Zero3ApiTurnResult
  ): Zero3ExecutionResultV2 {
    const latencyMs = this.#nowMs() - startedAtMs
    const status = resultStatusFor(failure)
    return {
      protocol: ZERO3_EXECUTION_RESULT_V2,
      taskId: task.taskId,
      executionId: task.executionId,
      projectId: task.projectId,
      provider: 'ZERO3_API',
      providerRuntime: 'ZERO3_API_SESSION',
      executorId: profileId ? `ZERO3_API:${profileId}` : 'ZERO3_API',
      status,
      contextVersion: task.contextVersion,
      conversationId: turn?.threadId ?? null,
      summary: failure.detail,
      output: turn ? { text: text(turn.text, MAX_OUTPUT_CHARS), structured: false } : null,
      changedFiles: [],
      artifacts: [],
      git: task.baseSha || task.branch
        ? { baseSha: task.baseSha ?? null, branch: task.branch ?? null }
        : null,
      verification: [],
      knownIssues: [],
      blockers: [failure.detail],
      recommendedAction: recommendedActionFor(failure),
      usage: {
        inputTokens: turn?.usage?.inputTokens ?? null,
        outputTokens: turn?.usage?.outputTokens ?? null,
        totalTokens: turn?.usage?.totalTokens ?? null,
        costUsd: null,
        model: turn?.model ?? null
      },
      timing: {
        queueLatencyMs: null,
        executionLatencyMs: latencyMs,
        totalLatencyMs: latencyMs
      },
      failure,
      completedAt: this.#now()
    }
  }
}

export function zero3ApiAvailabilityState(result: Zero3ApiProbeResult): Zero3ProviderAvailabilityState {
  return {
    available: result.available,
    authenticated: result.authenticated,
    status: result.status ?? null,
    detail: result.detail ?? null,
    latencyMs: result.latencyMs,
    observedAt: result.observedAt ?? null
  }
}

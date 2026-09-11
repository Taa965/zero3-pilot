import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { inspectZero3GptGpuHandoffPackage, ZERO3_GPT_GPU_HANDOFF_V1 } from './handoff-package.ts'
import type { WorkflowRemoteRenderPort, WorkflowRemoteRenderRequest, WorkflowRemoteRenderStatus } from './remote-render.ts'

const REQUEST_KEY = /^gptgpu:([0-9a-f]{64})$/u
const RUN_ID = /^[0-9a-f]{24}$/u
const JOB_ID = /^[A-Za-z0-9_.:-]{1,160}$/u
const MAX_UPLOAD_BYTES = 120 * 1024 * 1024
const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

export interface Zero3GptGpuRunnerPortOptions {
  baseUrl: string
  tokenFile: string
  fetchImpl?: typeof fetch
  maxUploadBytes?: number
  maxDownloadBytes?: number
}

type RunnerStatusPayload = {
  run_id?: string
  status?: string
  total?: number
  completed_or_skipped?: number
  failed?: number
  failures?: unknown[]
  error?: string
  updated_at?: string
}

function sha256Buffer(data: Buffer): string { return createHash('sha256').update(data).digest('hex') }

async function sha256File(file: string): Promise<string> {
  return sha256Buffer(await readFile(file))
}

function localPackagePath(request: WorkflowRemoteRenderRequest): string {
  if (request.inputArtifact.storage.provider !== 'LOCAL' || !request.inputArtifact.storage.path?.trim()) {
    throw new Error('GPT-GPU runner requires a materialized LOCAL handoff package')
  }
  return path.resolve(request.inputArtifact.storage.path)
}

function parseRequestKey(value: string): string {
  const match = REQUEST_KEY.exec(value.trim())
  if (!match) throw new Error('GPT-GPU runner request key is invalid')
  return match[1]
}

function runIdForDigest(digest: string): string { return digest.slice(0, 24) }

function validJobIds(manifest: Readonly<Record<string, unknown>>): string[] {
  const jobs = manifest.jobs
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 500) throw new Error('handoff manifest jobs must contain 1..500 items')
  const ids: string[] = []
  for (const [index, raw] of jobs.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`handoff jobs[${index}] must be an object`)
    const id = String((raw as Record<string, unknown>).id ?? '').trim()
    if (!JOB_ID.test(id)) throw new Error(`handoff jobs[${index}].id is invalid`)
    ids.push(id)
  }
  if (new Set(ids).size !== ids.length) throw new Error('handoff job ids contain duplicates')
  return ids
}

export class Zero3GptGpuRunnerPort implements WorkflowRemoteRenderPort {
  readonly provider = 'zero3-gpt-gpu-runner'
  private readonly baseUrl: string
  private readonly tokenFile: string
  private readonly fetchImpl: typeof fetch
  private readonly maxUploadBytes: number
  private readonly maxDownloadBytes: number

  constructor(options: Zero3GptGpuRunnerPortOptions) {
    const base = options.baseUrl.trim().replace(/\/$/u, '')
    let parsed: URL
    try { parsed = new URL(base) } catch { throw new Error('GPT-GPU runner base URL is invalid') }
    if (parsed.protocol !== 'https:') throw new Error('GPT-GPU runner base URL must use HTTPS')
    if (!path.isAbsolute(options.tokenFile)) throw new Error('GPT-GPU runner token file must be absolute')
    this.baseUrl = base
    this.tokenFile = options.tokenFile
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxUploadBytes = Math.min(MAX_UPLOAD_BYTES, Math.max(1, options.maxUploadBytes ?? MAX_UPLOAD_BYTES))
    this.maxDownloadBytes = Math.max(1, options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES)
  }

  private async token(): Promise<string> {
    const token = (await readFile(this.tokenFile, 'utf8')).trim()
    if (token.length < 32) throw new Error('GPT-GPU runner token is missing or too short')
    return token
  }

  private async request(relative: string, init: RequestInit = {}, allowNotFound = false): Promise<Response | null> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${await this.token()}`)
    headers.set('accept', headers.get('accept') ?? 'application/json')
    headers.set('user-agent', 'Zero3-Pilot-Workflow/1.0')
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${relative}`, { ...init, headers, redirect: 'error' })
    } catch (error) {
      throw new Error(`GPT-GPU runner network failure: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (allowNotFound && response.status === 404) return null
    if (!response.ok) {
      let detail = ''
      try {
        const body = await response.json() as { detail?: unknown; error?: unknown }
        detail = String(body.detail ?? body.error ?? '').slice(0, 1000)
      } catch {
        try { detail = (await response.text()).slice(0, 1000) } catch {}
      }
      throw new Error(`GPT-GPU runner HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return response
  }

  private async statusPayload(runId: string, allowNotFound = false): Promise<RunnerStatusPayload | null> {
    if (!RUN_ID.test(runId)) throw new Error('GPT-GPU runner run id is invalid')
    const response = await this.request(`/api/handoff/v1/runs/${runId}`, {}, allowNotFound)
    if (!response) return null
    const payload = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('GPT-GPU runner status payload is invalid')
    return payload as RunnerStatusPayload
  }

  private mapStatus(payload: RunnerStatusPayload, extra: Readonly<Record<string, unknown>> = {}): WorkflowRemoteRenderStatus {
    const externalId = String(payload.run_id ?? '').trim()
    if (!RUN_ID.test(externalId)) throw new Error('GPT-GPU runner response has invalid run_id')
    const status = String(payload.status ?? '').toLowerCase()
    const total = Number(payload.total ?? 0)
    const completed = Number(payload.completed_or_skipped ?? 0)
    const failed = Number(payload.failed ?? 0)
    const progress = total > 0 ? Math.max(0, Math.min(1, completed / total)) : undefined
    const metadata = {
      runId: externalId,
      ...(Number.isFinite(total) ? { total } : {}),
      ...(Number.isFinite(completed) ? { completedOrSkipped: completed } : {}),
      ...(Number.isFinite(failed) ? { failed } : {}),
      ...(Array.isArray(payload.failures) ? { failures: payload.failures.slice(0, 100) } : {}),
      ...extra
    }
    if (status === 'completed' && failed === 0) {
      return {
        externalId,
        state: 'SUCCEEDED',
        progress: 1,
        output: {
          logicalName: '云端视频结果集',
          kind: 'remote-video-set',
          storage: { provider: 'REMOTE_COMPUTE', uri: `zero3-gpt-gpu://run/${externalId}` }
        },
        metadata
      }
    }
    if (status === 'running') return { externalId, state: 'RUNNING', ...(progress == null ? {} : { progress }), metadata }
    if (status === 'staged') return { externalId, state: 'SUBMITTED', metadata }
    if (status === 'failed') return { externalId, state: 'FAILED', detail: String(payload.error ?? 'GPT-GPU runner failed'), metadata }
    return { externalId, state: 'OUTCOME_UNKNOWN', detail: `GPT-GPU runner returned status ${status || 'unknown'}`, metadata }
  }

  async requestKeyFor(request: WorkflowRemoteRenderRequest): Promise<string> {
    const packagePath = localPackagePath(request)
    const info = await stat(packagePath)
    if (!info.isFile() || info.size <= 0) throw new Error('GPT-GPU handoff package is missing or empty')
    if (info.size > this.maxUploadBytes) throw new Error(`GPT-GPU handoff package exceeds ${this.maxUploadBytes} byte upload limit`)
    const digest = request.inputArtifact.sha256?.trim().toLowerCase() || await sha256File(packagePath)
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error('GPT-GPU handoff package SHA256 is invalid')
    return `gptgpu:${digest}`
  }

  async submitIdempotent(request: WorkflowRemoteRenderRequest & { requestKey: string }): Promise<WorkflowRemoteRenderStatus> {
    const expectedDigest = parseRequestKey(request.requestKey)
    const packagePath = localPackagePath(request)
    const info = await stat(packagePath)
    if (!info.isFile() || info.size <= 0 || info.size > this.maxUploadBytes) throw new Error('GPT-GPU handoff package size is invalid')
    const data = await readFile(packagePath)
    const observedDigest = sha256Buffer(data)
    if (observedDigest !== expectedDigest) throw new Error('GPT-GPU handoff package changed after request intent was persisted')
    const inspected = await inspectZero3GptGpuHandoffPackage(packagePath, { workflowRunId: request.workflowRunId, workItemId: request.workItemId })
    if (String(inspected.manifest.schema ?? inspected.manifest.protocol ?? '') !== ZERO3_GPT_GPU_HANDOFF_V1) throw new Error('GPT-GPU handoff schema is invalid')
    const jobIds = validJobIds(inspected.manifest)
    const response = await this.request('/api/handoff/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: data
    })
    const payload = await response!.json() as RunnerStatusPayload
    const expectedRunId = runIdForDigest(expectedDigest)
    if (String(payload.run_id ?? '') !== expectedRunId) throw new Error('GPT-GPU runner returned a run id that does not match the package SHA256')
    return this.mapStatus(payload, { packageSha256: expectedDigest, jobIds, packageId: inspected.manifest.package_id ?? null, projectId: inspected.manifest.project_id ?? null })
  }

  async resolveByRequestKey(requestKey: string): Promise<WorkflowRemoteRenderStatus | null> {
    const digest = parseRequestKey(requestKey)
    const payload = await this.statusPayload(runIdForDigest(digest), true)
    if (!payload) return null
    const mapped = this.mapStatus(payload, { packageSha256: digest })
    // A staged package means bytes reached the server, but execution has not started.
    // It is safe to call the idempotent /runs endpoint again with the same package.
    if (mapped.state === 'SUBMITTED') return null
    return mapped
  }

  async getStatus(externalId: string): Promise<WorkflowRemoteRenderStatus> {
    const payload = await this.statusPayload(externalId)
    if (!payload) throw new Error('GPT-GPU runner status is missing')
    return this.mapStatus(payload)
  }

  async downloadResult(runId: string, jobId: string, target: string): Promise<{ path: string; sizeBytes: number; sha256: string }> {
    if (!RUN_ID.test(runId)) throw new Error('GPT-GPU runner run id is invalid')
    if (!JOB_ID.test(jobId)) throw new Error('GPT-GPU runner job id is invalid')
    const destination = path.resolve(target)
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.part`)
    const response = await this.request(`/api/handoff/v1/runs/${runId}/files/${encodeURIComponent(jobId)}`, { headers: { accept: 'video/mp4' } })
    if (!response?.body) throw new Error('GPT-GPU result download returned no body')
    const digest = createHash('sha256')
    let size = 0
    const maxDownloadBytes = this.maxDownloadBytes
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength
        if (size > maxDownloadBytes) { callback(new Error('GPT-GPU result exceeds download limit')); return }
        digest.update(chunk)
        callback(null, chunk)
      }
    })
    try {
      await pipeline(Readable.fromWeb(response.body as never), hasher, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
      if (size <= 0) throw new Error('GPT-GPU result is empty')
      await rename(temporary, destination)
      return { path: destination, sizeBytes: size, sha256: digest.digest('hex') }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

export function createZero3GptGpuRunnerPortFromEnv(env: NodeJS.ProcessEnv = process.env): Zero3GptGpuRunnerPort | null {
  const baseUrl = env.ZERO3_GPT_GPU_RUNNER_BASE_URL?.trim()
  const tokenFile = env.ZERO3_GPT_GPU_RUNNER_TOKEN_FILE?.trim()
  if (!baseUrl && !tokenFile) return null
  if (!baseUrl || !tokenFile) throw new Error('ZERO3_GPT_GPU_RUNNER_BASE_URL and ZERO3_GPT_GPU_RUNNER_TOKEN_FILE must be configured together')
  return new Zero3GptGpuRunnerPort({ baseUrl, tokenFile: path.resolve(tokenFile) })
}

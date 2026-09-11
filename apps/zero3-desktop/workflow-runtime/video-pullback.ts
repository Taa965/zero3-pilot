import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Zero3WorkflowRuntime } from './runtime.ts'

const execFileAsync = promisify(execFile)
const JOB_ID = /^[A-Za-z0-9_.:-]{1,160}$/u
const RUN_ID = /^[0-9a-f]{24}$/u

export interface WorkflowVideoQcResult {
  backend: string
  durationSeconds: number
  width: number
  height: number
  codec: string
  sizeBytes: number
}

export interface WorkflowVideoQcPort {
  inspect(file: string): Promise<WorkflowVideoQcResult>
}

export interface WorkflowGptGpuResultPort {
  readonly provider: string
  downloadResult(runId: string, jobId: string, target: string): Promise<{ path: string; sizeBytes: number; sha256: string }>
}

export class FfprobeWorkflowVideoQcPort implements WorkflowVideoQcPort {
  constructor(private readonly binary = process.env.ZERO3_FFPROBE_BIN?.trim() || 'ffprobe') {}

  async inspect(file: string): Promise<WorkflowVideoQcResult> {
    const info = await stat(file)
    if (!info.isFile() || info.size <= 0) throw new Error('downloaded video is missing or empty')
    let stdout: string
    try {
      const result = await execFileAsync(this.binary, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=codec_type,codec_name,width,height',
        '-of', 'json',
        path.resolve(file)
      ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
      stdout = result.stdout
    } catch (error) {
      throw new Error(`ffprobe technical QC failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    let parsed: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> }
    try { parsed = JSON.parse(stdout) } catch { throw new Error('ffprobe technical QC returned invalid JSON') }
    const video = parsed.streams?.find(stream => stream.codec_type === 'video')
    const duration = Number(parsed.format?.duration ?? 0)
    const width = Number(video?.width ?? 0)
    const height = Number(video?.height ?? 0)
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
      throw new Error('ffprobe technical QC found invalid duration or video dimensions')
    }
    return { backend: 'ffprobe', durationSeconds: duration, width, height, codec: String(video?.codec_name ?? ''), sizeBytes: info.size }
  }
}

export type WorkflowVideoPullbackResult = {
  workflowRunId: string
  stageRunId: string
  state: 'COMPLETED' | 'WAITING' | 'BLOCKED'
  videoCount?: number
  detail?: string
}

function manifestJobIds(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('local handoff Artifact has no manifest')
  const jobs = (manifest as Record<string, unknown>).jobs
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 500) throw new Error('local handoff manifest jobs are invalid')
  const ids = jobs.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`handoff job ${index} is invalid`)
    const id = String((raw as Record<string, unknown>).id ?? '').trim()
    if (!JOB_ID.test(id)) throw new Error(`handoff job ${index} id is invalid`)
    return id
  })
  if (new Set(ids).size !== ids.length) throw new Error('handoff job ids contain duplicates')
  return ids
}

function externalRunId(uri: string | undefined, metadata: Readonly<Record<string, unknown>>): string {
  const fromMetadata = String(metadata.externalId ?? metadata.runId ?? '').trim()
  if (RUN_ID.test(fromMetadata)) return fromMetadata
  const match = /^zero3-gpt-gpu:\/\/run\/([0-9a-f]{24})$/u.exec(uri?.trim() ?? '')
  if (!match) throw new Error('cloud-render Artifact has no valid GPT-GPU run id')
  return match[1]
}

function safeVideoName(jobId: string): string { return `${jobId.replace(/[^A-Za-z0-9_.:-]/gu, '-')}.mp4` }

export class Zero3WorkflowVideoPullbackService {
  constructor(
    private readonly runtime: Zero3WorkflowRuntime,
    private readonly remote: WorkflowGptGpuResultPort,
    private readonly qc: WorkflowVideoQcPort,
    private readonly outputRoot: string
  ) {}

  async pullback(runId: string, stageRunId: string): Promise<WorkflowVideoPullbackResult> {
    let snapshot = this.runtime.getRun(runId)
    let stage = snapshot.stages.find(value => value.stageRunId === stageRunId)
    if (!stage) throw new Error(`workflow stage not found: ${stageRunId}`)
    if (stage.stageId !== 'pullback' || stage.executor !== 'ZERO3') throw new Error('video pullback accepts only the pullback ZERO3 stage')
    if (stage.status === 'WAITING_DEPENDENCY') return { workflowRunId: runId, stageRunId, state: 'WAITING', detail: 'cloud-render is not complete' }
    if (stage.status === 'COMPLETED') return { workflowRunId: runId, stageRunId, state: 'COMPLETED' }

    try {
      if (stage.status === 'BLOCKED' || stage.status === 'WAITING_HUMAN') {
        this.runtime.resumeStage(runId, stageRunId)
        snapshot = this.runtime.getRun(runId)
        stage = snapshot.stages.find(value => value.stageRunId === stageRunId)!
      }
      const handoff = snapshot.artifacts.find(artifact => artifact.itemId === stage!.itemId && artifact.stageId === 'local-ingest' && artifact.logicalName === 'local-handoff' && ['AVAILABLE', 'VERIFIED'].includes(artifact.state))
      if (!handoff) throw new Error('pullback requires local-handoff Artifact')
      const remoteSet = snapshot.artifacts.find(artifact => artifact.itemId === stage!.itemId && artifact.stageId === 'cloud-render' && artifact.logicalName === '云端视频结果集' && ['AVAILABLE', 'VERIFIED'].includes(artifact.state))
      if (!remoteSet) throw new Error('pullback requires 云端视频结果集 Artifact')
      const manifest = handoff.metadata.manifest
      const jobIds = manifestJobIds(manifest)
      const remoteRunId = externalRunId(remoteSet.storage.uri, remoteSet.metadata)

      const summaryArtifact = snapshot.artifacts.find(artifact => artifact.itemId === stage!.itemId && artifact.stageId === 'pullback' && artifact.logicalName === '视频回传清单.json' && ['AVAILABLE', 'VERIFIED'].includes(artifact.state))
      if (stage.status === 'VERIFYING' && summaryArtifact) {
        this.runtime.gatePassed(runId, stageRunId, { remoteRunId, videoCount: jobIds.length, recoveredVerification: true })
        return { workflowRunId: runId, stageRunId, state: 'COMPLETED', videoCount: jobIds.length }
      }

      if (stage.status === 'READY' || stage.status === 'FIX_REQUIRED') this.runtime.claimStage(runId, stageRunId, 'zero3-video-pullback')
      const claimed = this.runtime.getRun(runId).stages.find(value => value.stageRunId === stageRunId)!
      if (claimed.status === 'CLAIMED') this.runtime.startStage(runId, stageRunId, 'zero3-video-pullback')

      const videoRoot = path.join(path.resolve(this.outputRoot), runId, stage.itemId, 'videos')
      await mkdir(videoRoot, { recursive: true })
      const results: Array<{ jobId: string; path: string; sizeBytes: number; sha256: string; qc: WorkflowVideoQcResult }> = []
      for (const jobId of jobIds) {
        snapshot = this.runtime.getRun(runId)
        const logicalName = `video:${jobId}`
        const existing = snapshot.artifacts.find(artifact => artifact.itemId === stage!.itemId && artifact.stageId === 'pullback' && artifact.logicalName === logicalName && artifact.state === 'VERIFIED' && artifact.storage.provider === 'LOCAL' && artifact.storage.path)
        if (existing?.storage.path) {
          const existingInfo = await stat(existing.storage.path).catch(() => null)
          if (existingInfo?.isFile() && existingInfo.size > 0 && existing.sha256 && existing.metadata.qc) {
            results.push({ jobId, path: existing.storage.path, sizeBytes: existing.sizeBytes ?? existingInfo.size, sha256: existing.sha256, qc: existing.metadata.qc as WorkflowVideoQcResult })
            continue
          }
        }
        const target = path.join(videoRoot, safeVideoName(jobId))
        const downloaded = await this.remote.downloadResult(remoteRunId, jobId, target)
        const qc = await this.qc.inspect(downloaded.path)
        this.runtime.registerArtifact(runId, stage.itemId, {
          stageId: 'pullback',
          logicalName,
          kind: 'video',
          mimeType: 'video/mp4',
          storage: { provider: 'LOCAL', path: downloaded.path },
          sha256: downloaded.sha256,
          sizeBytes: downloaded.sizeBytes,
          state: 'VERIFIED',
          metadata: { jobId, remoteRunId, qc }
        })
        results.push({ jobId, path: downloaded.path, sizeBytes: downloaded.sizeBytes, sha256: downloaded.sha256, qc })
        this.runtime.reportProgress(runId, stageRunId, Math.min(0.94, results.length / jobIds.length), `已拉取并 QC ${results.length}/${jobIds.length} 个视频`)
      }

      const manifestPath = path.join(path.resolve(this.outputRoot), runId, stage.itemId, 'video-results.json')
      await mkdir(path.dirname(manifestPath), { recursive: true })
      const temporary = `${manifestPath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ schema: 'zero3.workflow.video-pullback/1.0', workflowRunId: runId, workItemId: stage.itemId, remoteRunId, videos: results }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, manifestPath)
      const manifestInfo = await stat(manifestPath)
      this.runtime.requestVerification(runId, stageRunId, [{
        stageId: 'pullback',
        logicalName: '视频回传清单.json',
        kind: 'video-result-manifest',
        mimeType: 'application/json',
        storage: { provider: 'LOCAL', path: manifestPath },
        sizeBytes: manifestInfo.size,
        state: 'VERIFIED',
        metadata: { remoteRunId, videoCount: results.length }
      }])
      this.runtime.gatePassed(runId, stageRunId, { remoteRunId, videoCount: results.length, technicalQc: true })
      return { workflowRunId: runId, stageRunId, state: 'COMPLETED', videoCount: results.length }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        const current = this.runtime.getRun(runId).stages.find(value => value.stageRunId === stageRunId)
        if (current && !['COMPLETED', 'BLOCKED', 'WAITING_HUMAN'].includes(current.status)) this.runtime.blockStage(runId, stageRunId, detail, true)
      } catch {}
      return { workflowRunId: runId, stageRunId, state: 'BLOCKED', detail }
    }
  }
}

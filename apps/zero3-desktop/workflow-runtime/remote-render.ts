import type { WorkflowArtifactLocator, WorkflowExternalJobState, WorkflowRunSnapshot } from './contracts.ts'
import type { Zero3WorkflowRuntime } from './runtime.ts'

export type WorkflowRemoteRenderStatus = {
  externalId: string
  state: Exclude<WorkflowExternalJobState, 'PENDING'>
  progress?: number
  detail?: string
  output?: {
    logicalName?: string
    kind?: string
    mimeType?: string
    storage: WorkflowArtifactLocator
    sha256?: string
    sizeBytes?: number
  }
  metadata?: Readonly<Record<string, unknown>>
}

export interface WorkflowRemoteRenderPort {
  readonly provider: string
  /** Must treat requestKey as an idempotency key at the remote boundary. */
  submitIdempotent(request: {
    requestKey: string
    workflowRunId: string
    workItemId: string
    stageRunId: string
    inputArtifact: {
      artifactId: string
      logicalName: string
      storage: WorkflowArtifactLocator
      sha256: string | null
      sizeBytes: number | null
    }
    metadata: Readonly<Record<string, unknown>>
  }): Promise<WorkflowRemoteRenderStatus>
  resolveByRequestKey(requestKey: string): Promise<WorkflowRemoteRenderStatus | null>
  getStatus(externalId: string): Promise<WorkflowRemoteRenderStatus>
}

export type WorkflowRemoteRenderResult = {
  state: 'WAITING' | 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'OUTCOME_UNKNOWN'
  externalId?: string
  detail?: string
}

function cloudStage(snapshot: WorkflowRunSnapshot, stageRunId: string) {
  const stage = snapshot.stages.find(value => value.stageRunId === stageRunId)
  if (!stage) throw new Error(`workflow stage run not found: ${stageRunId}`)
  if (stage.stageId !== 'cloud-render' || stage.executor !== 'REMOTE_COMPUTE') throw new Error('remote render service accepts only REMOTE_COMPUTE cloud-render stages')
  return stage
}

function handoffArtifact(snapshot: WorkflowRunSnapshot, itemId: string) {
  return snapshot.artifacts.find(artifact =>
    artifact.itemId === itemId &&
    artifact.stageId === 'local-ingest' &&
    artifact.logicalName === 'local-handoff' &&
    ['AVAILABLE', 'VERIFIED'].includes(artifact.state)
  ) ?? null
}

function boundedProgress(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.1
  return Math.max(0.05, Math.min(0.94, Number(value)))
}

export class Zero3WorkflowRemoteRenderService {
  constructor(private readonly runtime: Zero3WorkflowRuntime, private readonly port: WorkflowRemoteRenderPort) {}

  async dispatchOrReconcile(runId: string, stageRunId: string): Promise<WorkflowRemoteRenderResult> {
    let snapshot = this.runtime.getRun(runId)
    let stage = cloudStage(snapshot, stageRunId)
    const handoff = handoffArtifact(snapshot, stage.itemId)
    if (!handoff) throw new Error('cloud-render requires verified local-handoff Artifact')

    if (stage.status === 'WAITING_DEPENDENCY') return { state: 'WAITING', detail: 'dependencies are not complete' }
    if (['COMPLETED', 'CANCELLED'].includes(stage.status)) return { state: stage.status === 'COMPLETED' ? 'COMPLETED' : 'BLOCKED' }

    if (stage.status === 'READY' || stage.status === 'FIX_REQUIRED') {
      this.runtime.claimStage(runId, stageRunId, `remote-${this.port.provider}`)
      snapshot = this.runtime.getRun(runId)
      stage = cloudStage(snapshot, stageRunId)
    }
    if (stage.status === 'CLAIMED') {
      this.runtime.startStage(runId, stageRunId, `remote-${this.port.provider}`)
      snapshot = this.runtime.getRun(runId)
      stage = cloudStage(snapshot, stageRunId)
    }
    if (stage.status === 'WAITING_HUMAN' || stage.status === 'BLOCKED') {
      const blockedJob = this.runtime.externalJob(runId, stageRunId)
      if (blockedJob?.state !== 'OUTCOME_UNKNOWN') return { state: 'BLOCKED', externalId: blockedJob?.externalId ?? undefined, detail: stage.currentActivity ?? undefined }
    }

    let job = this.runtime.externalJob(runId, stageRunId)
    if (!job || ['FAILED', 'CANCELLED'].includes(job.state)) {
      const requestKey = `${runId}:${stageRunId}:attempt-${Math.max(1, stage.attempt)}`
      job = this.runtime.ensureExternalJobIntent(runId, stageRunId, this.port.provider, requestKey, {
        inputArtifactId: handoff.artifactId,
        inputSha256: handoff.sha256
      })
    }

    let remote: WorkflowRemoteRenderStatus | null = null
    if (job.externalId) {
      remote = await this.port.getStatus(job.externalId)
    } else {
      remote = await this.port.resolveByRequestKey(job.requestKey)
      if (remote) {
        this.runtime.recordExternalJobSubmitted(runId, stageRunId, remote.externalId, { recoveredByRequestKey: true })
      } else if (job.state === 'OUTCOME_UNKNOWN') {
        return { state: 'OUTCOME_UNKNOWN', detail: 'remote submission outcome is still unknown; Zero3 will not resubmit blindly' }
      } else {
        try {
          remote = await this.port.submitIdempotent({
            requestKey: job.requestKey,
            workflowRunId: runId,
            workItemId: stage.itemId,
            stageRunId,
            inputArtifact: {
              artifactId: handoff.artifactId,
              logicalName: handoff.logicalName,
              storage: handoff.storage,
              sha256: handoff.sha256,
              sizeBytes: handoff.sizeBytes
            },
            metadata: stage.metadata
          })
          this.runtime.recordExternalJobSubmitted(runId, stageRunId, remote.externalId, remote.metadata ?? {})
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          this.runtime.updateExternalJobState(runId, stageRunId, 'OUTCOME_UNKNOWN', { reason: detail })
          const current = this.runtime.getRun(runId).stages.find(value => value.stageRunId === stageRunId)
          if (current && !['WAITING_HUMAN', 'BLOCKED'].includes(current.status)) this.runtime.blockStage(runId, stageRunId, `远端提交结果不确定：${detail}`, true)
          return { state: 'OUTCOME_UNKNOWN', detail }
        }
      }
    }

    if (!remote) return { state: 'WAITING' }
    return this.applyStatus(runId, stageRunId, remote)
  }

  private async applyStatus(runId: string, stageRunId: string, remote: WorkflowRemoteRenderStatus): Promise<WorkflowRemoteRenderResult> {
    if (remote.state === 'SUBMITTED' || remote.state === 'RUNNING') {
      this.runtime.updateExternalJobState(runId, stageRunId, remote.state, remote.metadata ?? {})
      const snapshot = this.runtime.getRun(runId)
      const stage = cloudStage(snapshot, stageRunId)
      if (['CLAIMED', 'RUNNING', 'FIX_REQUIRED'].includes(stage.status)) {
        this.runtime.reportProgress(runId, stageRunId, boundedProgress(remote.progress), remote.detail ?? `远端任务 ${remote.externalId} ${remote.state}`)
      }
      return { state: 'RUNNING', externalId: remote.externalId, detail: remote.detail }
    }

    if (remote.state === 'SUCCEEDED') {
      if (!remote.output) throw new Error('successful remote render did not return an output Artifact locator')
      this.runtime.updateExternalJobState(runId, stageRunId, 'SUCCEEDED', remote.metadata ?? {})
      const snapshot = this.runtime.getRun(runId)
      const stage = cloudStage(snapshot, stageRunId)
      if (!['RUNNING', 'CLAIMED', 'FIX_REQUIRED'].includes(stage.status)) throw new Error(`cloud-render cannot finalize while ${stage.status}`)
      this.runtime.requestVerification(runId, stageRunId, [{
        stageId: 'cloud-render',
        logicalName: remote.output.logicalName ?? '云端视频',
        kind: remote.output.kind ?? 'video',
        ...(remote.output.mimeType ? { mimeType: remote.output.mimeType } : {}),
        storage: remote.output.storage,
        ...(remote.output.sha256 ? { sha256: remote.output.sha256 } : {}),
        ...(remote.output.sizeBytes == null ? {} : { sizeBytes: remote.output.sizeBytes }),
        state: 'AVAILABLE',
        metadata: { externalId: remote.externalId, provider: this.port.provider }
      }])
      this.runtime.gatePassed(runId, stageRunId, { externalId: remote.externalId, provider: this.port.provider })
      return { state: 'COMPLETED', externalId: remote.externalId }
    }

    const detail = remote.detail ?? `remote render ended in ${remote.state}`
    this.runtime.updateExternalJobState(runId, stageRunId, remote.state, { ...(remote.metadata ?? {}), detail })
    const current = this.runtime.getRun(runId).stages.find(value => value.stageRunId === stageRunId)
    if (current && !['BLOCKED', 'WAITING_HUMAN'].includes(current.status)) {
      this.runtime.blockStage(runId, stageRunId, detail, remote.state === 'OUTCOME_UNKNOWN')
    }
    return {
      state: remote.state === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'BLOCKED',
      externalId: remote.externalId,
      detail
    }
  }
}

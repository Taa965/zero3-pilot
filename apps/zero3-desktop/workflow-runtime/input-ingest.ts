import path from 'node:path'

import type { WorkflowArtifactRecord, WorkflowRunSnapshot, WorkflowStageRunRecord } from './contracts.ts'
import type { GoogleDriveWritableArtifactPort } from './artifact-router.ts'
import type { Zero3WorkflowRuntime } from './runtime.ts'

export interface WorkflowInputIngestResult {
  workflowRunId: string
  ingestedStageRunIds: readonly string[]
  skippedStageRunIds: readonly string[]
  failed: readonly { stageRunId: string; reason: string }[]
}

function driveSegments(snapshot: WorkflowRunSnapshot, artifact: WorkflowArtifactRecord): string[] {
  const configured = artifact.metadata.drivePathSegments
  if (Array.isArray(configured) && configured.every(value => typeof value === 'string' && value.trim())) {
    return configured.map(value => String(value).trim())
  }
  return ['Zero3', 'runs', snapshot.run.workflowRunId, artifact.itemId, '00_input']
}

function inputArtifact(snapshot: WorkflowRunSnapshot, stage: WorkflowStageRunRecord): WorkflowArtifactRecord | null {
  const candidates = snapshot.artifacts.filter(artifact => artifact.itemId === stage.itemId && artifact.stageId === stage.stageId && artifact.logicalName === '原始脚本')
  return candidates.find(artifact => artifact.storage.provider === 'GOOGLE_DRIVE')
    ?? candidates.find(artifact => artifact.storage.provider === 'LOCAL')
    ?? candidates[0]
    ?? null
}

export class Zero3WorkflowInputIngestService {
  constructor(private readonly runtime: Zero3WorkflowRuntime, private readonly drive: GoogleDriveWritableArtifactPort) {}

  async ingestRun(runId: string, options: { recoverBlocked?: boolean } = {}): Promise<WorkflowInputIngestResult> {
    const ingested: string[] = []
    const skipped: string[] = []
    const failed: { stageRunId: string; reason: string }[] = []
    let snapshot = this.runtime.getRun(runId)
    const eligible = options.recoverBlocked ? ['READY', 'FIX_REQUIRED', 'BLOCKED', 'WAITING_HUMAN'] : ['READY', 'FIX_REQUIRED']
    const stages = snapshot.stages.filter(stage => stage.stageId === 'input-ingest' && eligible.includes(stage.status))
    for (const originalStage of stages) {
      try {
        snapshot = this.runtime.getRun(runId)
        let stage = snapshot.stages.find(value => value.stageRunId === originalStage.stageRunId)
        if (!stage || stage.status === 'COMPLETED') { skipped.push(originalStage.stageRunId); continue }
        if (options.recoverBlocked && (stage.status === 'BLOCKED' || stage.status === 'WAITING_HUMAN')) {
          this.runtime.resumeStage(runId, stage.stageRunId)
          snapshot = this.runtime.getRun(runId)
          stage = snapshot.stages.find(value => value.stageRunId === originalStage.stageRunId)!
        }
        let artifact = inputArtifact(snapshot, stage)
        if (!artifact) throw new Error('input-ingest has no 原始脚本 Artifact')

        if (stage.status === 'READY' || stage.status === 'FIX_REQUIRED') this.runtime.claimStage(runId, stage.stageRunId, 'zero3-input-ingest')
        const current = this.runtime.getRun(runId).stages.find(value => value.stageRunId === stage.stageRunId)
        if (current && ['CLAIMED', 'READY', 'FIX_REQUIRED'].includes(current.status)) this.runtime.startStage(runId, stage.stageRunId, 'zero3-input-ingest')

        if (artifact.storage.provider === 'LOCAL') {
          const sourcePath = artifact.storage.path?.trim()
          if (!sourcePath) throw new Error('local input artifact has no path')
          const rootFolderId = typeof snapshot.plan.metadata.driveRootFolderId === 'string' && snapshot.plan.metadata.driveRootFolderId.trim()
            ? snapshot.plan.metadata.driveRootFolderId.trim()
            : null
          const folder = await this.drive.ensureFolderPath(rootFolderId, driveSegments(snapshot, artifact), `${runId}:${artifact.itemId}`)
          const upload = await this.drive.uploadFile({
            sourcePath,
            artifactId: artifact.artifactId,
            fileName: path.basename(sourcePath),
            parentFolderId: folder.fileId,
            appProperties: {
              zero3WorkflowRunId: runId,
              zero3WorkItemId: artifact.itemId,
              zero3StageId: artifact.stageId
            }
          })
          artifact = this.runtime.relocateArtifact(runId, artifact.artifactId, {
            storage: {
              provider: 'GOOGLE_DRIVE',
              fileId: upload.fileId,
              ...(upload.webUrl ? { webUrl: upload.webUrl } : {}),
              parentFolderId: folder.fileId
            },
            sha256: upload.sha256,
            sizeBytes: upload.sizeBytes,
            state: 'AVAILABLE',
            metadataPatch: { inputIngestedBy: 'zero3-input-ingest', uploadReused: upload.reused }
          })
        }

        if (artifact.storage.provider !== 'GOOGLE_DRIVE' || !artifact.storage.fileId) throw new Error('input artifact did not resolve to Google Drive')
        if (!await this.drive.verifyFile(artifact.storage.fileId)) throw new Error('Google Drive upload could not be verified')
        this.runtime.relocateArtifact(runId, artifact.artifactId, { storage: artifact.storage, state: 'VERIFIED' })
        const afterRelocation = this.runtime.getRun(runId).stages.find(value => value.stageRunId === stage.stageRunId)
        if (afterRelocation?.status !== 'VERIFYING') this.runtime.requestVerification(runId, stage.stageRunId)
        this.runtime.gatePassed(runId, stage.stageRunId, { driveFileId: artifact.storage.fileId, verified: true })
        ingested.push(stage.stageRunId)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failed.push({ stageRunId: originalStage.stageRunId, reason })
        try {
          const current = this.runtime.getRun(runId).stages.find(stage => stage.stageRunId === originalStage.stageRunId)
          if (current && !['COMPLETED', 'BLOCKED', 'WAITING_HUMAN'].includes(current.status)) this.runtime.blockStage(runId, originalStage.stageRunId, reason, true)
        } catch {}
      }
    }
    return { workflowRunId: runId, ingestedStageRunIds: ingested, skippedStageRunIds: skipped, failed }
  }
}

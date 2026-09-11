import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import type { GoogleDriveArtifactPort } from './artifact-router.ts'
import { inspectZero3GptGpuHandoffPackage, type Zero3HandoffPackageInspection } from './handoff-package.ts'
import type { Zero3WorkflowRuntime } from './runtime.ts'

export interface LocalHandoffIngestResult {
  workflowRunId: string
  completedStageRunIds: readonly string[]
  failed: readonly { stageRunId: string; reason: string }[]
}

export class Zero3LocalHandoffIngestService {
  constructor(
    private readonly runtime: Zero3WorkflowRuntime,
    private readonly drive: GoogleDriveArtifactPort,
    private readonly cacheRoot: string,
    private readonly inspect: typeof inspectZero3GptGpuHandoffPackage = inspectZero3GptGpuHandoffPackage
  ) {}

  async ingestReady(runId: string, options: { recoverBlocked?: boolean } = {}): Promise<LocalHandoffIngestResult> {
    const completed: string[] = []
    const failed: { stageRunId: string; reason: string }[] = []
    let snapshot = this.runtime.getRun(runId)
    const eligible = options.recoverBlocked ? ['READY', 'FIX_REQUIRED', 'BLOCKED', 'WAITING_HUMAN'] : ['READY', 'FIX_REQUIRED']
    const candidates = snapshot.stages.filter(stage => stage.stageId === 'local-ingest' && eligible.includes(stage.status))
    for (const candidate of candidates) {
      try {
        snapshot = this.runtime.getRun(runId)
        let stage = snapshot.stages.find(value => value.stageRunId === candidate.stageRunId)
        if (!stage) continue
        if (options.recoverBlocked && (stage.status === 'BLOCKED' || stage.status === 'WAITING_HUMAN')) {
          this.runtime.resumeStage(runId, stage.stageRunId)
          snapshot = this.runtime.getRun(runId)
          stage = snapshot.stages.find(value => value.stageRunId === candidate.stageRunId)!
        }
        const packageArtifact = snapshot.artifacts.find(artifact =>
          artifact.itemId === stage!.itemId &&
          artifact.stageId === 'image-production' &&
          artifact.logicalName === '交接包.zip' &&
          ['AVAILABLE', 'VERIFIED'].includes(artifact.state)
        )
        if (!packageArtifact) throw new Error('local-ingest is missing 交接包.zip Artifact')
        if (packageArtifact.storage.provider !== 'GOOGLE_DRIVE' || !packageArtifact.storage.fileId?.trim()) {
          throw new Error('交接包.zip must be a Google Drive Artifact with fileId')
        }
        if (!await this.drive.verifyFile(packageArtifact.storage.fileId)) throw new Error('Google Drive handoff package could not be verified')

        if (stage.status === 'READY' || stage.status === 'FIX_REQUIRED') this.runtime.claimStage(runId, stage.stageRunId, 'zero3-local-handoff')
        const active = this.runtime.getRun(runId).stages.find(value => value.stageRunId === stage!.stageRunId)!
        if (active.status === 'CLAIMED') this.runtime.startStage(runId, active.stageRunId, 'zero3-local-handoff')

        const targetRoot = path.join(path.resolve(this.cacheRoot), runId, stage.itemId)
        await mkdir(targetRoot, { recursive: true })
        const materialized = await this.drive.downloadFile(packageArtifact.storage.fileId, targetRoot)
        const inspection: Zero3HandoffPackageInspection = await this.inspect(materialized.path, { workflowRunId: runId, workItemId: stage.itemId })
        this.runtime.requestVerification(runId, stage.stageRunId, [{
          stageId: 'local-ingest',
          logicalName: 'local-handoff',
          kind: 'local-package',
          mimeType: 'application/zip',
          storage: { provider: 'LOCAL', path: materialized.path },
          sha256: inspection.packageSha256,
          sizeBytes: inspection.packageSizeBytes,
          state: 'VERIFIED',
          metadata: {
            sourceArtifactId: packageArtifact.artifactId,
            handoffProtocol: inspection.protocol,
            manifest: inspection.manifest
          }
        }])
        this.runtime.gatePassed(runId, stage.stageRunId, { handoffProtocol: inspection.protocol, sourceArtifactId: packageArtifact.artifactId })
        completed.push(stage.stageRunId)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failed.push({ stageRunId: candidate.stageRunId, reason })
        try {
          const current = this.runtime.getRun(runId).stages.find(stage => stage.stageRunId === candidate.stageRunId)
          if (current && !['COMPLETED', 'BLOCKED', 'WAITING_HUMAN'].includes(current.status)) this.runtime.blockStage(runId, candidate.stageRunId, reason, true)
        } catch {}
      }
    }
    return { workflowRunId: runId, completedStageRunIds: completed, failed }
  }
}

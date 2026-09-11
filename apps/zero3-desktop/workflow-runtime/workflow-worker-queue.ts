import { stat } from 'node:fs/promises'

import type {
  WorkflowArtifactRef,
  WorkflowWorkUnit,
  WorkflowWorkerBinding
} from '../worker-runtime/v2/contracts.ts'
import type { GoogleDriveArtifactPort } from './artifact-router.ts'
import type { WorkflowArtifactSeed, WorkflowStageRunRecord } from './contracts.ts'
import type { Zero3WorkflowRuntime } from './runtime.ts'
import { buildWorkflowWorkUnit, buildWorkflowWorkerBindings } from './worker-v2-adapter.ts'

const ID = /^[A-Za-z0-9._:-]{1,256}$/u

function requireId(value: string, label: string): string {
  const text = value.trim()
  if (!ID.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function sameBinding(expected: WorkflowWorkerBinding, actual: WorkflowWorkerBinding): boolean {
  return expected.workflowRunId === actual.workflowRunId &&
    expected.moduleId === actual.moduleId &&
    expected.moduleVersion === actual.moduleVersion &&
    expected.workerDefinitionId === actual.workerDefinitionId &&
    expected.workerSlotId === actual.workerSlotId &&
    expected.provider === actual.provider
}

export interface WorkflowWorkerArtifactVerifier {
  verify(artifact: WorkflowArtifactRef): Promise<boolean>
}

export class DefaultWorkflowWorkerArtifactVerifier implements WorkflowWorkerArtifactVerifier {
  constructor(private readonly drive: Pick<GoogleDriveArtifactPort, 'verifyFile'> | null = null) {}

  async verify(artifact: WorkflowArtifactRef): Promise<boolean> {
    if (artifact.storage.provider === 'GOOGLE_DRIVE') {
      const fileId = artifact.storage.fileId?.trim()
      return Boolean(fileId && this.drive && await this.drive.verifyFile(fileId))
    }
    if (artifact.storage.provider === 'LOCAL') {
      const file = artifact.storage.path?.trim()
      if (!file) return false
      const info = await stat(file).catch(() => null)
      return Boolean(info?.isFile() && info.size > 0)
    }
    return false
  }
}

export type WorkflowWorkerClaimResult =
  | { state: 'CLAIMED'; stage: WorkflowStageRunRecord; workUnit: WorkflowWorkUnit }
  | { state: 'NO_WORK_AVAILABLE' }

export type WorkflowWorkerStageCommitResult = {
  state: 'COMPLETED' | 'FIX_REQUIRED'
  replayed: boolean
}

export type WorkflowWorkerCommitResult = WorkflowWorkerStageCommitResult & {
  next: WorkflowWorkerClaimResult
}

export class Zero3WorkflowWorkerQueueService {
  constructor(
    private readonly runtime: Zero3WorkflowRuntime,
    private readonly verifier: WorkflowWorkerArtifactVerifier
  ) {}

  private validateBinding(binding: WorkflowWorkerBinding): void {
    const snapshot = this.runtime.getRun(binding.workflowRunId)
    const current = buildWorkflowWorkerBindings(snapshot).find(value => value.workerSlotId === binding.workerSlotId)
    if (!current || !sameBinding(current, binding)) throw new Error('workflow worker binding does not match the frozen run plan')
  }

  private stageFor(binding: WorkflowWorkerBinding, stageRunId: string): WorkflowStageRunRecord {
    const snapshot = this.runtime.getRun(binding.workflowRunId)
    const stage = snapshot.stages.find(value => value.stageRunId === stageRunId)
    if (!stage) throw new Error(`workflow StageRun not found: ${stageRunId}`)
    if (stage.workerDefinitionId !== binding.workerDefinitionId) throw new Error('workflow StageRun belongs to a different WorkerDefinition')
    return stage
  }

  claimNext(binding: WorkflowWorkerBinding, workerSessionIdValue: string): WorkflowWorkerClaimResult {
    this.validateBinding(binding)
    requireId(workerSessionIdValue, 'workerSessionId')
    const stage = this.runtime.claimNextStage(binding.workflowRunId, binding.workerDefinitionId, binding.workerSlotId)
    if (!stage) return { state: 'NO_WORK_AVAILABLE' }
    const snapshot = this.runtime.getRun(binding.workflowRunId)
    return { state: 'CLAIMED', stage, workUnit: buildWorkflowWorkUnit(snapshot, stage.stageRunId) }
  }

  reportProgress(
    binding: WorkflowWorkerBinding,
    workerSessionIdValue: string,
    stageRunId: string,
    progress: number,
    currentActivity?: string | null
  ): WorkflowStageRunRecord {
    this.validateBinding(binding)
    requireId(workerSessionIdValue, 'workerSessionId')
    const stage = this.stageFor(binding, stageRunId)
    if (stage.claimOwnerId !== binding.workerSlotId) throw new Error('workflow StageRun claim owner does not match WorkerSlot')
    return this.runtime.reportProgress(binding.workflowRunId, stageRunId, progress, currentActivity)
  }

  async commitStage(
    binding: WorkflowWorkerBinding,
    workerSessionIdValue: string,
    stageRunIdValue: string,
    artifacts: readonly WorkflowArtifactRef[]
  ): Promise<WorkflowWorkerStageCommitResult> {
    this.validateBinding(binding)
    const workerSessionId = requireId(workerSessionIdValue, 'workerSessionId')
    const stageRunId = requireId(stageRunIdValue, 'stageRunId')
    let stage = this.stageFor(binding, stageRunId)

    if (stage.status === 'COMPLETED') return { state: 'COMPLETED', replayed: true }
    if (stage.status === 'READY' || stage.status === 'FIX_REQUIRED') {
      this.runtime.claimStage(binding.workflowRunId, stageRunId, binding.workerSlotId)
      stage = this.stageFor(binding, stageRunId)
    }
    if (!['CLAIMED', 'RUNNING'].includes(stage.status)) throw new Error(`workflow StageRun cannot be committed while ${stage.status}`)
    if (stage.claimOwnerId !== binding.workerSlotId) throw new Error('workflow StageRun claim owner does not match WorkerSlot')

    for (const artifact of artifacts) {
      if (artifact.workflowRunId !== binding.workflowRunId || artifact.workItemId !== stage.itemId || artifact.stageRunId !== stageRunId) {
        throw new Error('worker Artifact scope does not match the current WorkUnit')
      }
      if (artifact.producer.workerDefinitionId !== binding.workerDefinitionId || artifact.producer.workerSlotId !== binding.workerSlotId || artifact.producer.workerSessionId !== workerSessionId) {
        throw new Error('worker Artifact producer does not match the active worker binding')
      }
    }

    const verification = await Promise.all(artifacts.map(artifact => this.verifier.verify(artifact)))
    if (verification.some(value => !value)) {
      this.runtime.requestVerification(binding.workflowRunId, stageRunId, [])
      this.runtime.gateFailed(binding.workflowRunId, stageRunId, 'worker Artifact verification failed')
      return { state: 'FIX_REQUIRED', replayed: false }
    }

    const seeds: WorkflowArtifactSeed[] = artifacts.map(artifact => ({
      artifactId: artifact.artifactId,
      stageId: stage.stageId,
      logicalName: artifact.logicalName,
      kind: artifact.kind,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      storage: { ...artifact.storage },
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      ...(artifact.sizeBytes == null ? {} : { sizeBytes: artifact.sizeBytes }),
      state: 'VERIFIED',
      metadata: { producer: { ...artifact.producer } }
    }))
    this.runtime.requestVerification(binding.workflowRunId, stageRunId, seeds)
    this.runtime.gatePassed(binding.workflowRunId, stageRunId, {
      workerDefinitionId: binding.workerDefinitionId,
      workerSlotId: binding.workerSlotId,
      workerSessionId,
      artifactCount: seeds.length
    })
    stage = this.stageFor(binding, stageRunId)
    if (stage.status !== 'COMPLETED') throw new Error('worker StageRun did not complete after gate pass')
    return { state: 'COMPLETED', replayed: false }
  }

  async commitAndClaimNext(
    binding: WorkflowWorkerBinding,
    workerSessionIdValue: string,
    stageRunIdValue: string,
    artifacts: readonly WorkflowArtifactRef[]
  ): Promise<WorkflowWorkerCommitResult> {
    const workerSessionId = requireId(workerSessionIdValue, 'workerSessionId')
    const committed = await this.commitStage(binding, workerSessionId, stageRunIdValue, artifacts)
    return {
      ...committed,
      next: committed.state === 'COMPLETED'
        ? this.claimNext(binding, workerSessionId)
        : { state: 'NO_WORK_AVAILABLE' }
    }
  }
}

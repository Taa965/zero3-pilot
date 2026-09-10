import type {
  WorkflowArtifactRef as WorkerArtifactRef,
  WorkflowWorkUnit,
  WorkflowWorkerBinding
} from '../worker-runtime/v2/contracts.ts'
import type { WorkflowArtifactRecord, WorkflowRunSnapshot, WorkflowStageRunRecord, WorkflowWorkerDefinition } from './contracts.ts'

function workerFor(snapshot: WorkflowRunSnapshot, workerDefinitionId: string): WorkflowWorkerDefinition {
  const worker = snapshot.plan.workers.find(value => value.workerDefinitionId === workerDefinitionId)
  if (!worker) throw new Error(`workflow worker definition not found: ${workerDefinitionId}`)
  if (worker.executor !== 'GPT_WEB') throw new Error(`worker ${workerDefinitionId} is not a GPT_WEB worker`)
  return worker
}

function slotId(runId: string, workerDefinitionId: string, index: number): string {
  return `${runId}:${workerDefinitionId}:${String(index + 1).padStart(2, '0')}`
}

export function buildWorkflowWorkerBindings(snapshot: WorkflowRunSnapshot): WorkflowWorkerBinding[] {
  const bindings: WorkflowWorkerBinding[] = []
  for (const worker of snapshot.plan.workers) {
    if (worker.executor !== 'GPT_WEB') continue
    for (let index = 0; index < worker.concurrency; index += 1) {
      bindings.push({
        workflowRunId: snapshot.run.workflowRunId,
        moduleId: snapshot.run.moduleId,
        moduleVersion: snapshot.run.moduleVersion,
        workerDefinitionId: worker.workerDefinitionId,
        workerSlotId: slotId(snapshot.run.workflowRunId, worker.workerDefinitionId, index),
        provider: 'GPT_WEB',
        requiredCapabilities: [worker.capability],
        maxBatchSize: Number(worker.metadata?.maxWorkItemsPerClaim ?? 1),
        sessionPolicy: {
          maxItemsPerPhysicalSession: worker.maxItemsPerPhysicalSession ?? null,
          rotateOnContextRisk: worker.rotateOnContextRisk !== false,
          rotateOnStall: worker.rotateOnStall !== false
        }
      })
    }
  }
  return bindings
}

function producerFor(artifact: WorkflowArtifactRecord): WorkerArtifactRef['producer'] {
  const producer = artifact.metadata.producer
  if (producer && typeof producer === 'object' && !Array.isArray(producer)) {
    const value = producer as Record<string, unknown>
    if (typeof value.workerDefinitionId === 'string' && typeof value.workerSlotId === 'string' && typeof value.workerSessionId === 'string') {
      return {
        workerDefinitionId: value.workerDefinitionId,
        workerSlotId: value.workerSlotId,
        workerSessionId: value.workerSessionId
      }
    }
  }
  return { workerDefinitionId: 'zero3-system', workerSlotId: 'zero3-system', workerSessionId: 'zero3-system' }
}

function inputArtifacts(snapshot: WorkflowRunSnapshot, stage: WorkflowStageRunRecord): WorkerArtifactRef[] {
  const definition = snapshot.plan.stages.find(value => value.stageId === stage.stageId)
  if (!definition) throw new Error(`workflow stage definition not found: ${stage.stageId}`)
  const dependencyIds = new Set(definition.dependsOn)
  return snapshot.artifacts
    .filter(artifact => artifact.itemId === stage.itemId && dependencyIds.has(artifact.stageId) && ['AVAILABLE', 'VERIFIED'].includes(artifact.state))
    .map(artifact => ({
      artifactId: artifact.artifactId,
      workflowRunId: artifact.workflowRunId,
      workItemId: artifact.itemId,
      stageRunId: artifact.stageRunId,
      logicalName: artifact.logicalName,
      kind: artifact.kind,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      storage: {
        provider: artifact.storage.provider,
        ...(artifact.storage.fileId ? { fileId: artifact.storage.fileId } : {}),
        ...(artifact.storage.path ? { path: artifact.storage.path } : {}),
        ...(artifact.storage.uri ? { uri: artifact.storage.uri } : {}),
        ...(artifact.storage.webUrl ? { webUrl: artifact.storage.webUrl } : {})
      },
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      ...(artifact.sizeBytes == null ? {} : { sizeBytes: artifact.sizeBytes }),
      producer: producerFor(artifact)
    }))
}

export function buildWorkflowWorkUnit(snapshot: WorkflowRunSnapshot, stageRunId: string): WorkflowWorkUnit {
  const stage = snapshot.stages.find(value => value.stageRunId === stageRunId)
  if (!stage) throw new Error(`workflow StageRun not found: ${stageRunId}`)
  if (!stage.workerDefinitionId) throw new Error(`workflow StageRun is not assigned to a WorkerDefinition: ${stageRunId}`)
  const worker = workerFor(snapshot, stage.workerDefinitionId)
  const definition = snapshot.plan.stages.find(value => value.stageId === stage.stageId)
  const item = snapshot.items.find(value => value.itemId === stage.itemId)
  if (!definition || !item) throw new Error(`workflow StageRun context is incomplete: ${stageRunId}`)
  return {
    workItemId: item.itemId,
    stageRunId: stage.stageRunId,
    title: item.title,
    instruction: String(definition.metadata?.instruction ?? `执行“${definition.title}”，严格按照当前工位固定 Prompt 与 Workflow Module 要求交付。`),
    ...(worker.skillId ? { skill: { id: worker.skillId } } : {}),
    inputs: inputArtifacts(snapshot, stage),
    expectedOutputs: definition.expectedOutputs.map(output => ({
      logicalName: output.logicalName,
      kind: output.kind,
      ...(output.mimeType ? { mimeType: output.mimeType } : {}),
      required: output.required
    })),
    policy: {
      maxAttempts: definition.maxAttempts,
      leaseSeconds: Number(definition.metadata?.leaseSeconds ?? 1800)
    },
    metadata: {
      workflowRunId: snapshot.run.workflowRunId,
      moduleId: snapshot.run.moduleId,
      moduleVersion: snapshot.run.moduleVersion,
      stageId: stage.stageId,
      workerDefinitionId: worker.workerDefinitionId,
      promptRevision: worker.promptRevision,
      artifactTransport: snapshot.plan.metadata.artifactTransport ?? null,
      driveRootFolderId: snapshot.plan.metadata.driveRootFolderId ?? null,
      ...definition.metadata
    }
  }
}

export function listReadyWorkflowWorkUnits(snapshot: WorkflowRunSnapshot, workerDefinitionId: string): WorkflowWorkUnit[] {
  workerFor(snapshot, workerDefinitionId)
  return snapshot.stages
    .filter(stage => stage.workerDefinitionId === workerDefinitionId && ['READY', 'FIX_REQUIRED'].includes(stage.status))
    .map(stage => buildWorkflowWorkUnit(snapshot, stage.stageRunId))
}

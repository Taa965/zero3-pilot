import { createHash } from 'node:crypto'

import {
  normalizeWorkflowArtifactRef,
  type WorkflowArtifactRef,
  type WorkflowWorkerBinding
} from '../worker-runtime/v2/contracts.ts'
import type { WorkflowRunSnapshot, WorkflowStageRunRecord } from './contracts.ts'
import type { Zero3WorkflowRuntime } from './runtime.ts'
import { buildWorkflowWorkUnit, buildWorkflowWorkerBindings } from './worker-v2-adapter.ts'
import { Zero3WorkflowWorkerQueueService } from './workflow-worker-queue.ts'

export interface WorkflowWorkerAdminPort {
  ensureWorkflowRun(input: Record<string, unknown>): unknown
  ensureWorkerBinding(input: Record<string, unknown>): unknown
  addWorkItems(input: Record<string, unknown>): unknown
  workflowSnapshot(workflowRunId: string): unknown
}

type WorkerMirrorStage = {
  stageRunId: string
  status: string
  metadata: Record<string, unknown>
  artifacts: unknown[]
  lastError: string | null
}

type WorkerMirrorSnapshot = {
  stages: WorkerMirrorStage[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function workerSnapshot(value: unknown): WorkerMirrorSnapshot {
  const root = record(value)
  const stages = Array.isArray(root.stages) ? root.stages.map(value => {
    const stage = record(value)
    return {
      stageRunId: String(stage.stageRunId ?? ''),
      status: String(stage.status ?? ''),
      metadata: record(stage.metadata),
      artifacts: Array.isArray(stage.artifacts) ? stage.artifacts : [],
      lastError: stage.lastError == null ? null : String(stage.lastError)
    }
  }).filter(stage => stage.stageRunId) : []
  return { stages }
}

function hashId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function authoritativeStageId(stage: WorkerMirrorStage): string | null {
  const value = stage.metadata.authoritativeStageRunId
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function authoritativeAttempt(stage: WorkerMirrorStage): number | null {
  const value = Number(stage.metadata.authoritativeAttempt)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function bindingForProducer(snapshot: WorkflowRunSnapshot, stage: WorkflowStageRunRecord, artifacts: WorkflowArtifactRef[]): WorkflowWorkerBinding {
  const producer = artifacts[0]?.producer
  if (!producer) throw new Error(`completed worker mirror ${stage.stageRunId} has no produced Artifact`)
  const binding = buildWorkflowWorkerBindings(snapshot).find(value =>
    value.workerDefinitionId === stage.workerDefinitionId && value.workerSlotId === producer.workerSlotId
  )
  if (!binding) throw new Error(`worker Artifact producer slot is not part of the frozen Workflow Run: ${producer.workerSlotId}`)
  return binding
}

export type WorkflowWorkerProjectionResult = {
  workflowRunId: string
  seededStageRunIds: string[]
  reconciledStageRunIds: string[]
  blockedStageRunIds: string[]
}

export class Zero3WorkflowWorkerProjectionService {
  constructor(
    private readonly runtime: Zero3WorkflowRuntime,
    private readonly workers: WorkflowWorkerAdminPort,
    private readonly queue: Zero3WorkflowWorkerQueueService
  ) {}

  private ensureScaffold(snapshot: WorkflowRunSnapshot): void {
    this.workers.ensureWorkflowRun({
      workflowRunId: snapshot.run.workflowRunId,
      taskId: snapshot.run.workflowRunId,
      moduleId: snapshot.run.moduleId,
      moduleVersion: snapshot.run.moduleVersion,
      metadata: {
        projectId: snapshot.run.projectId,
        title: snapshot.run.title,
        authority: 'zero3-workflow-runtime'
      }
    })
    const bindings = buildWorkflowWorkerBindings(snapshot)
    for (const binding of bindings) {
      const definition = snapshot.plan.workers.find(value => value.workerDefinitionId === binding.workerDefinitionId)
      if (!definition) continue
      this.workers.ensureWorkerBinding({
        binding,
        role: definition.name,
        promptRevision: definition.promptRevision,
        metadata: { authority: 'zero3-workflow-runtime' }
      })
    }
  }

  private mirrorId(stage: WorkflowStageRunRecord): string {
    return hashId('mirror', `${stage.stageRunId}:attempt:${stage.attempt}`)
  }

  private publishReady(snapshot: WorkflowRunSnapshot, mirror: WorkerMirrorSnapshot): string[] {
    const existing = new Set(mirror.stages.map(stage => stage.stageRunId))
    const seeded: string[] = []
    for (const stage of snapshot.stages) {
      if (stage.executor !== 'GPT_WEB' || !stage.workerDefinitionId) continue
      if (!['READY', 'FIX_REQUIRED'].includes(stage.status)) continue
      const worker = snapshot.plan.workers.find(value => value.workerDefinitionId === stage.workerDefinitionId)
      if (!worker) throw new Error(`WorkerDefinition not found for ${stage.stageRunId}`)
      const mirrorStageRunId = this.mirrorId(stage)
      if (existing.has(mirrorStageRunId)) continue
      const workUnit = buildWorkflowWorkUnit(snapshot, stage.stageRunId)
      const mirrorWorkItemId = hashId('mirror-item', `${stage.stageRunId}:attempt:${stage.attempt}`)
      this.workers.addWorkItems({
        workflowRunId: snapshot.run.workflowRunId,
        idempotencyKey: hashId('seed', mirrorStageRunId),
        items: [{
          workItemId: mirrorWorkItemId,
          title: `${workUnit.title} · ${stage.title}`,
          metadata: {
            authoritativeWorkItemId: stage.itemId,
            authoritativeStageRunId: stage.stageRunId,
            authoritativeAttempt: stage.attempt
          },
          stages: [{
            ...workUnit,
            workItemId: mirrorWorkItemId,
            stageRunId: mirrorStageRunId,
            stageKey: stage.stageId,
            workerDefinitionId: stage.workerDefinitionId,
            requiredCapability: worker.capability,
            dependsOn: [],
            metadata: {
              ...workUnit.metadata,
              authoritativeWorkItemId: stage.itemId,
              authoritativeStageRunId: stage.stageRunId,
              authoritativeAttempt: stage.attempt
            }
          }]
        }]
      })
      existing.add(mirrorStageRunId)
      seeded.push(stage.stageRunId)
    }
    return seeded
  }

  private async reconcileCompleted(snapshot: WorkflowRunSnapshot, mirror: WorkerMirrorSnapshot): Promise<{ reconciled: string[]; blocked: string[] }> {
    const reconciled: string[] = []
    const blocked: string[] = []
    for (const mirrorStage of mirror.stages) {
      const stageRunId = authoritativeStageId(mirrorStage)
      if (!stageRunId) continue
      const taskStage = snapshot.stages.find(value => value.stageRunId === stageRunId)
      if (!taskStage || taskStage.executor !== 'GPT_WEB' || !taskStage.workerDefinitionId) continue
      if (authoritativeAttempt(mirrorStage) !== taskStage.attempt) continue
      if (taskStage.status === 'COMPLETED') continue

      if (mirrorStage.status === 'FAILED') {
        if (!['BLOCKED', 'WAITING_HUMAN', 'COMPLETED'].includes(taskStage.status)) {
          this.runtime.blockStage(snapshot.run.workflowRunId, stageRunId, mirrorStage.lastError ?? 'GPT Worker exhausted its retry budget', true)
          blocked.push(stageRunId)
        }
        continue
      }
      if (mirrorStage.status !== 'COMPLETED') continue

      const rawArtifacts = mirrorStage.artifacts.map(normalizeWorkflowArtifactRef)
      const translated = rawArtifacts.map(artifact => ({
        ...artifact,
        workflowRunId: snapshot.run.workflowRunId,
        workItemId: taskStage.itemId,
        stageRunId: taskStage.stageRunId
      }))
      const binding = bindingForProducer(snapshot, taskStage, translated)
      const workerSessionId = translated[0].producer.workerSessionId
      const result = await this.queue.commitStage(binding, workerSessionId, taskStage.stageRunId, translated)
      if (result.state === 'COMPLETED') reconciled.push(stageRunId)
      else blocked.push(stageRunId)
    }
    return { reconciled, blocked }
  }

  async syncRun(runId: string): Promise<WorkflowWorkerProjectionResult> {
    let snapshot = this.runtime.getRun(runId)
    this.ensureScaffold(snapshot)
    let mirror = workerSnapshot(this.workers.workflowSnapshot(runId))
    const first = await this.reconcileCompleted(snapshot, mirror)
    snapshot = this.runtime.getRun(runId)
    mirror = workerSnapshot(this.workers.workflowSnapshot(runId))
    const seeded = this.publishReady(snapshot, mirror)
    return {
      workflowRunId: runId,
      seededStageRunIds: seeded,
      reconciledStageRunIds: first.reconciled,
      blockedStageRunIds: first.blocked
    }
  }
}

import type { WorkflowArtifactRelocation, WorkflowArtifactSeed, WorkflowExternalJobState, WorkflowRunSnapshot, WorkflowValidationResult } from './contracts.ts'
import { Zero3WorkflowRegistry } from './registry.ts'
import { Zero3WorkflowStore } from './store.ts'

export interface CreateWorkflowRunRequest {
  moduleId: string
  moduleVersion?: string | null
  input: unknown
  start?: boolean
}

export class Zero3WorkflowRuntime {
  constructor(readonly store: Zero3WorkflowStore, readonly registry: Zero3WorkflowRegistry) {}

  listModules() { return this.registry.list() }
  validateCreateInput(moduleId: string, input: unknown, moduleVersion?: string | null): WorkflowValidationResult {
    return this.registry.validate(moduleId, input, moduleVersion)
  }

  createRun(request: CreateWorkflowRunRequest): WorkflowRunSnapshot {
    const plan = this.registry.createRun(request.moduleId, request.input, request.moduleVersion)
    const created = this.store.createRun(plan)
    return request.start === false ? created : this.store.startRun(plan.workflowRunId)
  }

  listRuns() { return this.store.listRuns() }
  getRun(runId: string) { return this.store.snapshot(runId) }
  startRun(runId: string) { return this.store.startRun(runId) }
  readyStages(runId: string, workerDefinitionId?: string | null) { return this.store.readyStages(runId, workerDefinitionId) }
  claimStage(runId: string, stageRunId: string, ownerId: string) { return this.store.claimStage(runId, stageRunId, ownerId) }
  startStage(runId: string, stageRunId: string, ownerId?: string | null) { return this.store.startStage(runId, stageRunId, ownerId) }
  reportProgress(runId: string, stageRunId: string, progress: number, currentActivity?: string | null) {
    return this.store.reportProgress(runId, stageRunId, progress, currentActivity)
  }
  requestVerification(runId: string, stageRunId: string, artifacts: readonly WorkflowArtifactSeed[] = []) {
    return this.store.requestVerification(runId, stageRunId, artifacts)
  }
  gatePassed(runId: string, stageRunId: string, evidence: Readonly<Record<string, unknown>> = {}) {
    return this.store.gatePassed(runId, stageRunId, evidence)
  }
  gateFailed(runId: string, stageRunId: string, reason: string) { return this.store.gateFailed(runId, stageRunId, reason) }
  blockStage(runId: string, stageRunId: string, reason: string, waitingHuman = false) {
    return this.store.blockStage(runId, stageRunId, reason, waitingHuman)
  }
  resumeStage(runId: string, stageRunId: string) { return this.store.resumeStage(runId, stageRunId) }
  registerArtifact(runId: string, itemId: string, artifact: WorkflowArtifactSeed) {
    return this.store.registerArtifact(runId, itemId, artifact)
  }
  relocateArtifact(runId: string, artifactId: string, relocation: WorkflowArtifactRelocation) {
    return this.store.relocateArtifact(runId, artifactId, relocation)
  }
  ensureExternalJobIntent(runId: string, stageRunId: string, provider: string, requestKey: string, metadata: Readonly<Record<string, unknown>> = {}) {
    return this.store.ensureExternalJobIntent(runId, stageRunId, provider, requestKey, metadata)
  }
  recordExternalJobSubmitted(runId: string, stageRunId: string, externalId: string, metadataPatch: Readonly<Record<string, unknown>> = {}) {
    return this.store.recordExternalJobSubmitted(runId, stageRunId, externalId, metadataPatch)
  }
  updateExternalJobState(runId: string, stageRunId: string, state: WorkflowExternalJobState, metadataPatch: Readonly<Record<string, unknown>> = {}) {
    return this.store.updateExternalJobState(runId, stageRunId, state, metadataPatch)
  }
  externalJob(runId: string, stageRunId: string) { return this.store.externalJob(runId, stageRunId) }
  listExternalJobs(runId: string) { return this.store.listExternalJobs(runId) }
}

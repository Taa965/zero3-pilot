import path from 'node:path'

import type { WorkflowArtifactSeed } from '../contracts.ts'
import { Zero3WorkflowRuntime, type CreateWorkflowRunRequest } from '../runtime.ts'
import { createGoogleDriveArtifactPortFromEnv } from '../google-drive-rest.ts'
import { Zero3WorkflowInputIngestService } from '../input-ingest.ts'
import { Zero3LocalHandoffIngestService } from '../local-handoff-ingest.ts'
import { Zero3WorkflowStore } from '../store.ts'
import { createBuiltinWorkflowRegistry } from '../../workflow-modules/index.ts'
import type { WorkflowDesktopPort } from './desktop-port.ts'

export class Zero3WorkflowDesktopRuntime implements WorkflowDesktopPort {
  readonly root: string
  readonly store: Zero3WorkflowStore
  readonly runtime: Zero3WorkflowRuntime
  readonly drivePort = createGoogleDriveArtifactPortFromEnv()
  readonly inputIngest: Zero3WorkflowInputIngestService | null
  readonly handoffIngest: Zero3LocalHandoffIngestService | null

  constructor(root: string) {
    const absolute = path.resolve(root)
    this.root = absolute
    this.store = new Zero3WorkflowStore(path.join(absolute, 'workflow-runtime.sqlite3'))
    this.runtime = new Zero3WorkflowRuntime(this.store, createBuiltinWorkflowRegistry())
    this.inputIngest = this.drivePort ? new Zero3WorkflowInputIngestService(this.runtime, this.drivePort) : null
    this.handoffIngest = this.drivePort ? new Zero3LocalHandoffIngestService(this.runtime, this.drivePort, path.join(this.root, 'handoff-cache')) : null
  }

  runtimeCapabilities() {
    return {
      protocol: 'zero3.pilot.workflow-runtime.v1',
      artifactProviders: {
        GOOGLE_DRIVE: { configured: Boolean(this.drivePort), mode: this.drivePort ? 'direct-oauth' : 'unconfigured' },
        LOCAL: { configured: true },
        REMOTE_COMPUTE: { configured: false }
      },
      automaticInputIngest: Boolean(this.inputIngest),
      handoffMaterialization: Boolean(this.handoffIngest)
    }
  }
  listModules() { return this.runtime.listModules() }
  validateCreateInput(moduleId: string, input: unknown, moduleVersion?: string | null) {
    return this.runtime.validateCreateInput(moduleId, input, moduleVersion)
  }
  listRuns() { return this.runtime.listRuns() }
  getRun(runId: string) { return this.runtime.getRun(runId) }
  async createRun(request: CreateWorkflowRunRequest) {
    const created = this.runtime.createRun(request)
    if (request.start !== false && this.inputIngest) {
      await this.inputIngest.ingestRun(created.run.workflowRunId)
      return this.runtime.getRun(created.run.workflowRunId)
    }
    return created
  }
  startRun(runId: string) { return this.runtime.startRun(runId) }
  readyStages(runId: string, workerDefinitionId?: string | null) { return this.runtime.readyStages(runId, workerDefinitionId) }
  claimStage(runId: string, stageRunId: string, ownerId: string) { return this.runtime.claimStage(runId, stageRunId, ownerId) }
  startStage(runId: string, stageRunId: string, ownerId?: string | null) { return this.runtime.startStage(runId, stageRunId, ownerId) }
  reportProgress(runId: string, stageRunId: string, progress: number, activity?: string | null) {
    return this.runtime.reportProgress(runId, stageRunId, progress, activity)
  }
  requestVerification(runId: string, stageRunId: string, artifacts: readonly WorkflowArtifactSeed[] = []) {
    return this.runtime.requestVerification(runId, stageRunId, artifacts)
  }
  gatePassed(runId: string, stageRunId: string, evidence: Readonly<Record<string, unknown>> = {}) {
    return this.runtime.gatePassed(runId, stageRunId, evidence)
  }
  gateFailed(runId: string, stageRunId: string, reason: string) { return this.runtime.gateFailed(runId, stageRunId, reason) }
  blockStage(runId: string, stageRunId: string, reason: string, waitingHuman = false) {
    return this.runtime.blockStage(runId, stageRunId, reason, waitingHuman)
  }
  resumeStage(runId: string, stageRunId: string) { return this.runtime.resumeStage(runId, stageRunId) }
  async ingestInputs(runId: string) {
    if (!this.inputIngest) throw new Error('Google Drive direct provider is not configured in Zero3 Desktop')
    await this.inputIngest.ingestRun(runId)
    return this.runtime.getRun(runId)
  }
  async ingestHandoffs(runId: string) {
    if (!this.handoffIngest) throw new Error('Google Drive direct provider is not configured in Zero3 Desktop')
    await this.handoffIngest.ingestReady(runId)
    return this.runtime.getRun(runId)
  }

  close(): void { this.store.close() }
}

export function createWorkflowDesktopRuntime(root: string): Zero3WorkflowDesktopRuntime {
  return new Zero3WorkflowDesktopRuntime(root)
}

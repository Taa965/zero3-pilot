import path from 'node:path'

import type { WorkflowArtifactSeed } from '../contracts.ts'
import { Zero3WorkflowRuntime, type CreateWorkflowRunRequest } from '../runtime.ts'
import { Zero3WorkflowStore } from '../store.ts'
import { createBuiltinWorkflowRegistry } from '../../workflow-modules/index.ts'
import type { WorkflowDesktopPort } from './desktop-port.ts'

export class Zero3WorkflowDesktopRuntime implements WorkflowDesktopPort {
  readonly store: Zero3WorkflowStore
  readonly runtime: Zero3WorkflowRuntime

  constructor(root: string) {
    const absolute = path.resolve(root)
    this.store = new Zero3WorkflowStore(path.join(absolute, 'workflow-runtime.sqlite3'))
    this.runtime = new Zero3WorkflowRuntime(this.store, createBuiltinWorkflowRegistry())
  }

  listModules() { return this.runtime.listModules() }
  validateCreateInput(moduleId: string, input: unknown, moduleVersion?: string | null) {
    return this.runtime.validateCreateInput(moduleId, input, moduleVersion)
  }
  listRuns() { return this.runtime.listRuns() }
  getRun(runId: string) { return this.runtime.getRun(runId) }
  createRun(request: CreateWorkflowRunRequest) { return this.runtime.createRun(request) }
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

  close(): void { this.store.close() }
}

export function createWorkflowDesktopRuntime(root: string): Zero3WorkflowDesktopRuntime {
  return new Zero3WorkflowDesktopRuntime(root)
}

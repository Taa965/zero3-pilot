import type { WorkflowArtifactSeed } from '../contracts.ts'
import type { CreateWorkflowRunRequest } from '../runtime.ts'

export interface WorkflowDesktopPort {
  runtimeCapabilities(): Promise<unknown> | unknown
  listModules(): Promise<unknown> | unknown
  validateCreateInput(moduleId: string, input: unknown, moduleVersion?: string | null): Promise<unknown> | unknown
  listRuns(): Promise<unknown> | unknown
  getRun(runId: string): Promise<unknown> | unknown
  createRun(request: CreateWorkflowRunRequest): Promise<unknown> | unknown
  startRun(runId: string): Promise<unknown> | unknown
  readyStages(runId: string, workerDefinitionId?: string | null): Promise<unknown> | unknown
  claimStage(runId: string, stageRunId: string, ownerId: string): Promise<unknown> | unknown
  startStage(runId: string, stageRunId: string, ownerId?: string | null): Promise<unknown> | unknown
  reportProgress(runId: string, stageRunId: string, progress: number, activity?: string | null): Promise<unknown> | unknown
  requestVerification(runId: string, stageRunId: string, artifacts?: readonly WorkflowArtifactSeed[]): Promise<unknown> | unknown
  gatePassed(runId: string, stageRunId: string, evidence?: Readonly<Record<string, unknown>>): Promise<unknown> | unknown
  gateFailed(runId: string, stageRunId: string, reason: string): Promise<unknown> | unknown
  blockStage(runId: string, stageRunId: string, reason: string, waitingHuman?: boolean): Promise<unknown> | unknown
  resumeStage(runId: string, stageRunId: string): Promise<unknown> | unknown
  ingestInputs(runId: string): Promise<unknown> | unknown
  ingestHandoffs(runId: string): Promise<unknown> | unknown
}

export const WORKFLOW_DESKTOP_CHANNELS = {
  runtimeCapabilities: 'zero3:workflow:runtime-capabilities',
  listModules: 'zero3:workflow:list-modules',
  validateCreateInput: 'zero3:workflow:validate-create-input',
  listRuns: 'zero3:workflow:list-runs',
  getRun: 'zero3:workflow:get-run',
  createRun: 'zero3:workflow:create-run',
  startRun: 'zero3:workflow:start-run',
  readyStages: 'zero3:workflow:ready-stages',
  claimStage: 'zero3:workflow:claim-stage',
  startStage: 'zero3:workflow:start-stage',
  reportProgress: 'zero3:workflow:report-progress',
  requestVerification: 'zero3:workflow:request-verification',
  gatePassed: 'zero3:workflow:gate-passed',
  gateFailed: 'zero3:workflow:gate-failed',
  blockStage: 'zero3:workflow:block-stage',
  resumeStage: 'zero3:workflow:resume-stage',
  pickInputFiles: 'zero3:workflow:pick-input-files',
  ingestInputs: 'zero3:workflow:ingest-inputs',
  ingestHandoffs: 'zero3:workflow:ingest-handoffs'
} as const

import type { Zero3WorkflowInputIngestService } from './input-ingest.ts'
import type { Zero3LocalHandoffIngestService } from './local-handoff-ingest.ts'
import type { Zero3WorkflowRemoteRenderService } from './remote-render.ts'
import type { Zero3WorkflowRuntime } from './runtime.ts'
import type { Zero3WorkflowVideoPullbackService } from './video-pullback.ts'

export interface WorkflowAutomationServices {
  inputIngest?: Zero3WorkflowInputIngestService | null
  handoffIngest?: Zero3LocalHandoffIngestService | null
  remoteRender?: Zero3WorkflowRemoteRenderService | null
  videoPullback?: Zero3WorkflowVideoPullbackService | null
}

export interface WorkflowAutomationTickResult {
  processedRuns: readonly string[]
  actions: number
  errors: readonly { workflowRunId: string; action: string; error: string }[]
}

export class Zero3WorkflowAutomationController {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly intervalMs: number

  constructor(
    private readonly runtime: Zero3WorkflowRuntime,
    private readonly services: WorkflowAutomationServices,
    intervalMs = Number(process.env.ZERO3_WORKFLOW_AUTOMATION_INTERVAL_MS || 5000)
  ) {
    this.intervalMs = Number.isFinite(intervalMs) ? Math.max(2000, Math.min(60_000, Math.round(intervalMs))) : 5000
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tickOnce().catch(error => console.warn('[Zero3 Workflow] automation tick failed', error)) }, this.intervalMs)
    this.timer.unref?.()
    void this.tickOnce().catch(error => console.warn('[Zero3 Workflow] initial automation tick failed', error))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tickOnce(): Promise<WorkflowAutomationTickResult> {
    if (this.ticking) return { processedRuns: [], actions: 0, errors: [] }
    this.ticking = true
    const processedRuns: string[] = []
    const errors: { workflowRunId: string; action: string; error: string }[] = []
    let actions = 0
    try {
      const runs = this.runtime.listRuns().filter(run => !['COMPLETED', 'FAILED', 'CANCELLED', 'DRAFT'].includes(run.status))
      for (const run of runs) {
        const runId = run.workflowRunId
        processedRuns.push(runId)
        const attempt = async (action: string, execute: () => Promise<unknown>) => {
          try { await execute(); actions += 1 }
          catch (error) { errors.push({ workflowRunId: runId, action, error: error instanceof Error ? error.message : String(error) }) }
        }

        let snapshot = this.runtime.getRun(runId)
        if (this.services.inputIngest && snapshot.stages.some(stage => stage.stageId === 'input-ingest' && ['READY', 'FIX_REQUIRED'].includes(stage.status))) {
          await attempt('input-ingest', () => this.services.inputIngest!.ingestRun(runId))
          snapshot = this.runtime.getRun(runId)
        }
        if (this.services.handoffIngest && snapshot.stages.some(stage => stage.stageId === 'local-ingest' && ['READY', 'FIX_REQUIRED'].includes(stage.status))) {
          await attempt('local-ingest', () => this.services.handoffIngest!.ingestReady(runId))
          snapshot = this.runtime.getRun(runId)
        }
        if (this.services.remoteRender) {
          const candidates = snapshot.stages.filter(stage => {
            if (stage.stageId !== 'cloud-render') return false
            if (['READY', 'CLAIMED', 'RUNNING', 'FIX_REQUIRED'].includes(stage.status)) return true
            if (stage.status !== 'WAITING_HUMAN') return false
            return this.runtime.externalJob(runId, stage.stageRunId)?.state === 'OUTCOME_UNKNOWN'
          })
          for (const stage of candidates) await attempt('cloud-render', () => this.services.remoteRender!.dispatchOrReconcile(runId, stage.stageRunId))
          snapshot = this.runtime.getRun(runId)
        }
        if (this.services.videoPullback) {
          const candidates = snapshot.stages.filter(stage => stage.stageId === 'pullback' && ['READY', 'FIX_REQUIRED', 'VERIFYING'].includes(stage.status))
          for (const stage of candidates) await attempt('pullback', () => this.services.videoPullback!.pullback(runId, stage.stageRunId))
        }
      }
      return { processedRuns, actions, errors }
    } finally {
      this.ticking = false
    }
  }
}

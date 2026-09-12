import fs from 'node:fs'
import { createHash } from 'node:crypto'

import type { ExecutionTaskSnapshot } from '../execution-runtime/contracts.ts'
import type { WorkflowArtifactRef } from '../worker-runtime/v2/contracts.ts'
import { VIDEO_GENERATION_WORKFLOW_ID } from '../execution-runtime/workflows/video-generation.ts'
import { installVideoGenerationWorkflow, materializeVideoGenerationProductionPlan } from './video-generation-module.ts'

export const VIDEO_GENERATION_TASK_BRIDGE = 'zero3.pilot.video-generation-task-bridge.v1' as const
export const VIDEO_PRODUCTION_INPUTS_SCHEMA = 'zero3.video-production-inputs.v1' as const
export const VIDEO_PRODUCTION_MANIFEST_SCHEMA = 'zero3.video-production-manifest.v1' as const
export const BLOCKED_BY_EXTERNAL_CAPABILITY = 'BLOCKED_BY_EXTERNAL_CAPABILITY'
const BRIDGE_EXECUTOR_ID = 'video-generation-task-bridge'
const BRIDGE_SESSION_PREFIX = 'workflow-worker:'

// These are the authoritative video-generation-v1 step phases. The bridge drives every
// ZERO3 phase; the HUMAN intake phase stays under operator control via the Task Board.
const BRIDGE_PHASES = ['rewrite', 'visual', 'production-plan', 'image-production', 'cloud-production', 'jianying', 'final-verification'] as const
type BridgePhase = (typeof BRIDGE_PHASES)[number]
const WORKER_PHASES: readonly BridgePhase[] = ['rewrite', 'visual', 'image-production']
const WORKER_STAGE_KEYS: Readonly<Partial<Record<(typeof WORKER_PHASES)[number], readonly string[]>>> = {
  rewrite: ['script-rewrite'],
  visual: ['visual-plan'],
  'image-production': ['image-batch', 'image-package']
}
const HOST_PHASES: readonly ('cloud-production' | 'jianying')[] = ['cloud-production', 'jianying']

export type VideoGenerationBridgeExecutionPort = {
  getTask(taskId: string): Promise<ExecutionTaskSnapshot>
  createAssignment(taskId: string, stepId: string, executor: 'ZERO3', executorId: string | null): Promise<{ assignmentId: string }>
  bindSession(assignmentId: string, input: { logicalSessionId: string; state: 'active'; metadata: Record<string, unknown> }): Promise<unknown>
  recordProgress(taskId: string, stepId: string, progress: number, activity: string | null): Promise<unknown>
  recordArtifact(taskId: string, stepId: string, artifact: Record<string, unknown>, identity?: { eventId: string }): Promise<unknown>
  requestCompletion(taskId: string, stepId: string): Promise<unknown>
  gatePassed(taskId: string, stepId: string, evidence: Record<string, unknown>): Promise<unknown>
  gateFailed(taskId: string, stepId: string, reason: string): Promise<unknown>
  transitionStep(taskId: string, stepId: string, status: 'blocked' | 'waiting_human', reason: string): Promise<unknown>
}

export type VideoGenerationBridgeWorkerPort = {
  workflowSnapshot(workflowRunId: string): unknown
  ensureWorkflowRun(input: Record<string, unknown>): unknown
  ensureWorkerBinding(input: Record<string, unknown>): unknown
  addWorkItems(input: Record<string, unknown>): unknown
}

export type VideoGenerationArtifactContentPort = {
  read(artifact: Record<string, unknown>): Promise<string | null>
}

export type VideoGenerationHostCapabilityPort = {
  run(input: { capability: 'cloud-production' | 'jianying'; taskId: string; projectId: string; manifest: Record<string, unknown> }):
    Promise<{ ok: true; manifest: Record<string, unknown>; detail?: Record<string, unknown> } | { ok: false; reason: string; externalCapability?: boolean }>
}

export type VideoGenerationProductionProfilePort = {
  get(projectId: string): Promise<{ driveFolderId: string; imageBatchSize: number; revision: number } | null>
}

export type Zero3VideoGenerationTaskBridgeOptions = {
  clock?: () => Date
}

type StepView = {
  stepId: string
  maxAttempts: number
  humanGate: boolean
  requiredOutputs: readonly { logicalName: string; minCount?: number }[]
  status: string
  attempt: number
  assignmentId: string | null
}

type WorkerStageView = {
  stageRunId: string
  stageKey: string
  status: string
  workItemId: string
  lastError: string | null
  artifacts: WorkflowArtifactRef[]
  metadata: Record<string, unknown>
}

type ScriptWorkItem = { workItemId: string; scriptName: string; productionDate: string }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hashId(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

function stageTerminal(stage: WorkerStageView): boolean {
  return stage.status === 'BLOCKED' || stage.status === 'FAILED'
}

// A deterministic artifact reference recorded by the bridge on behalf of a completed
// workflow-worker stage. storage stays whatever the worker reported, so the manifest is
// a faithful index of real stage artifacts rather than a second copy.
function stageArtifactRef(stage: WorkerStageView, artifact: WorkflowArtifactRef): Record<string, unknown> {
  return {
    artifactId: artifact.artifactId,
    logicalName: artifact.logicalName,
    kind: artifact.kind,
    mimeType: artifact.mimeType ?? null,
    storage: record(artifact.storage),
    stageRunId: stage.stageRunId,
    workItemId: stage.workItemId,
    producer: record(artifact.producer)
  }
}

export function createLocalArtifactContentReader(): VideoGenerationArtifactContentPort {
  return {
    async read(artifact) {
      const inline = artifact.content
      if (typeof inline === 'string' && inline.trim()) return inline
      const storage = record(artifact.storage)
      if (storage.provider === 'LOCAL' && typeof storage.path === 'string' && storage.path.trim()) {
        try { return await fs.promises.readFile(storage.path.trim(), 'utf8') } catch { return null }
      }
      return null
    }
  }
}

export class Zero3VideoGenerationTaskBridge {
  private readonly taskTails = new Map<string, Promise<Record<string, unknown> | void>>()

  constructor(
    private readonly ports: {
      execution: VideoGenerationBridgeExecutionPort
      worker: VideoGenerationBridgeWorkerPort
      artifactContent: VideoGenerationArtifactContentPort
      hostCapability: VideoGenerationHostCapabilityPort
      productionProfiles: VideoGenerationProductionProfilePort
    },
    private readonly options: Zero3VideoGenerationTaskBridgeOptions = {}
  ) {}

  status(): { bridge: typeof VIDEO_GENERATION_TASK_BRIDGE; tasks: number } {
    return { bridge: VIDEO_GENERATION_TASK_BRIDGE, tasks: this.taskTails.size }
  }

  reconcileTask(snapshot: ExecutionTaskSnapshot): Promise<Record<string, unknown>> {
    const taskId = snapshot.definition.task.taskId
    const previous = this.taskTails.get(taskId) ?? Promise.resolve()
    let resolveResult!: (value: Record<string, unknown>) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<Record<string, unknown>>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const current = previous.then(async () => {
      try { resolveResult(await this.#reconcileTask(taskId)) } catch (error) { rejectResult(error) }
    })
    this.taskTails.set(taskId, current)
    void current.finally(() => { if (this.taskTails.get(taskId) === current) this.taskTails.delete(taskId) })
    return result
  }

  reconcileTasks(tasks: readonly ExecutionTaskSnapshot[]): Promise<Record<string, unknown>[]> {
    const targets = tasks.filter(snapshot =>
      snapshot.definition.task.workflowId === VIDEO_GENERATION_WORKFLOW_ID && snapshot.archived !== true)
    return Promise.all(targets.map(snapshot => this.reconcileTask(snapshot).catch(error => ({
      taskId: snapshot.definition.task.taskId,
      error: error instanceof Error ? error.message : String(error)
    }))))
  }

  async #reconcileTask(taskId: string): Promise<Record<string, unknown>> {
    let view = await this.ports.execution.getTask(taskId)
    const task = view.definition.task
    if (task.workflowId !== VIDEO_GENERATION_WORKFLOW_ID) return { taskId, skipped: 'not-video-generation' }
    if (view.archived === true) return { taskId, skipped: 'archived' }
    if (['completed', 'cancelled', 'failed'].includes(view.runtime.task.status)) return { taskId, skipped: `task-${view.runtime.task.status}` }

    const actions: string[] = []
    const errors: string[] = []
    const step = (phase: BridgePhase): { stepId: string; view: StepView } | null => {
      const definition = view.definition.steps.find(item => record(item.metadata).workflowPhase === phase)
      const runtime = definition ? view.runtime.steps.find(item => item.stepId === definition.stepId) : undefined
      if (!definition || !runtime) return null
      return {
        stepId: definition.stepId,
        view: {
          stepId: definition.stepId,
          maxAttempts: definition.maxAttempts,
          humanGate: definition.completionGate.includes('human_review'),
          requiredOutputs: definition.expectedOutputs.filter(output => output.required),
          status: runtime.status,
          attempt: runtime.attempt,
          assignmentId: runtime.assignmentId
        }
      }
    }
    const refresh = async (): Promise<void> => { view = await this.ports.execution.getTask(taskId) }
    const blockStep = async (stepId: string, reason: string): Promise<void> => {
      await this.ports.execution.transitionStep(taskId, stepId, 'blocked', reason)
      actions.push(`blocked:${stepId}`)
      await refresh()
    }

    // A. Dispatch every ready ZERO3 phase. Assignment + session binding are always
    // written through the Execution Runtime so the board shows the real attempt.
    for (const phase of BRIDGE_PHASES) {
      const entry = step(phase)
      if (!entry || entry.view.assignmentId || !['ready', 'fix_required'].includes(entry.view.status)) continue
      if (entry.view.attempt >= entry.view.maxAttempts) {
        if (entry.view.status === 'fix_required') {
          await this.ports.execution.transitionStep(taskId, entry.stepId, 'waiting_human',
            `步骤尝试预算已用尽（${entry.view.attempt}/${entry.view.maxAttempts}），需要人工处理。`)
          actions.push(`waiting_human:${entry.stepId}`)
          await refresh()
        }
        continue
      }
      const assignment = await this.ports.execution.createAssignment(taskId, entry.stepId, 'ZERO3', BRIDGE_EXECUTOR_ID) as { assignmentId: string }
      await this.ports.execution.bindSession(assignment.assignmentId, {
        logicalSessionId: `${BRIDGE_SESSION_PREFIX}${taskId}`,
        state: 'active',
        metadata: { bridge: VIDEO_GENERATION_TASK_BRIDGE, workflowRunId: taskId, workflowPhase: phase }
      })
      actions.push(`dispatch:${entry.stepId}`)
      await refresh()
    }

    // B. Install the Worker v2 run as soon as the rewrite step owns an assignment.
    // installVideoGenerationWorkflow is idempotent, so replays and restarts are safe.
    const rewrite = step('rewrite')
    if (rewrite && rewrite.view.assignmentId && !this.#workerRun(taskId)) {
      try {
        await this.#installRun(view, taskId)
        actions.push(`installed:${taskId}`)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        if (rewrite.view.status !== 'blocked') {
          await blockStep(rewrite.stepId, `生产运行安装失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    await refresh()

    const run = record(this.#workerRun(taskId))
    const stages = (Array.isArray(run.stages) ? run.stages : []) as unknown as WorkerStageView[]
    const scripts: ScriptWorkItem[] = (Array.isArray(run.items) ? run.items : [])
      .map(item => record(item))
      .filter(item => record(item.metadata).phase === 'rewrite_visual' && typeof item.workItemId === 'string')
      .map(item => ({
        workItemId: String(item.workItemId),
        scriptName: String(record(item.metadata).scriptName ?? ''),
        productionDate: String(record(item.metadata).productionDate ?? '')
      }))

    // C. Monitor worker-backed phases: progress in, artifacts out, gates closed.
    for (const phase of WORKER_PHASES) {
      const entry = step(phase)
      if (!entry || !entry.view.assignmentId) continue
      if (!['dispatching', 'running', 'waiting_report', 'verifying', 'fix_required'].includes(entry.view.status)) continue
      const keys = WORKER_STAGE_KEYS[phase]
      const phaseStages = stages.filter(item => keys.includes(item.stageKey))
      const completed = phaseStages.filter(item => item.status === 'COMPLETED')
      const failed = phaseStages.filter(stageTerminal)
      try {
        if (phaseStages.length === 0) {
          if (['dispatching', 'running'].includes(entry.view.status)) {
            await this.ports.execution.recordProgress(taskId, entry.stepId, 0, '等待生产运行阶段生成…')
          }
          continue
        }
        if (failed.length > 0) {
          if (entry.view.status !== 'blocked') {
            const reason = failed.map(item => `${item.stageRunId}: ${item.lastError ?? '工位阻塞'}`).join('；')
            await this.ports.execution.transitionStep(taskId, entry.stepId, 'blocked', `Workflow Worker 工位阻塞：${reason}`)
            actions.push(`blocked:${entry.stepId}`)
            await refresh()
          }
          continue
        }
        if (completed.length < phaseStages.length) {
          if (['dispatching', 'running'].includes(entry.view.status)) {
            await this.ports.execution.recordProgress(taskId, entry.stepId, completed.length / phaseStages.length,
              `工位进度 ${completed.length}/${phaseStages.length}`)
          }
          continue
        }
        await this.#completeFromStages(taskId, entry, completed)
        actions.push(`worker-complete:${entry.stepId}`)
        await refresh()
      } catch (error) {
        errors.push(`${entry.stepId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // D. plan-production: local, deterministic materialization of the verified visual plan.
    const plan = step('production-plan')
    if (plan && plan.view.assignmentId && ['dispatching', 'running', 'waiting_report'].includes(plan.view.status)) {
      try {
        const summaries: Record<string, unknown>[] = []
        let pending = false
        for (const script of scripts) {
          const visualStage = stages.find(item => item.stageRunId === `${script.workItemId}:visual`)
          if (!visualStage || visualStage.status !== 'COMPLETED') { pending = true; continue }
          const planArtifact = visualStage.artifacts.find(item => item.kind === 'json') ?? null
          const raw = planArtifact ? await this.ports.artifactContent.read(planArtifact as unknown as Record<string, unknown>) : null
          if (raw == null) {
            await blockStep(plan.stepId, `${BLOCKED_BY_EXTERNAL_CAPABILITY}: 视觉计划 ${planArtifact?.logicalName ?? script.workItemId} 无法本地读取（storage=${planArtifact ? record(planArtifact.storage).provider ?? 'unknown' : 'missing'}），需要可读的 LOCAL 产物或缓存。`)
            pending = false
            break
          }
          const materialized = materializeVideoGenerationProductionPlan(this.ports.worker as never, {
            workflowRunId: taskId, workItemId: script.workItemId, scriptName: script.scriptName,
            productionDate: script.productionDate, visualPlan: raw, idempotencyKey: `${taskId}:materialize:${script.workItemId}`
          }) as { summary: Record<string, unknown>; batches: { batchId: string; shotIds: string[] }[] }
          summaries.push({ workItemId: script.workItemId, scriptName: script.scriptName, productionDate: script.productionDate, ...materialized.summary, batches: materialized.batches })
        }
        if (!pending && scripts.length > 0 && summaries.length === scripts.length) {
          await this.#finishStep(taskId, plan, {
            logicalName: plan.view.requiredOutputs[0]?.logicalName ?? 'production-plan.json',
            manifest: { schema: VIDEO_PRODUCTION_MANIFEST_SCHEMA, taskId, phase: 'production-plan', scripts: summaries, generatedAt: this.now() }
          })
          actions.push(`plan-complete:${plan.stepId}`)
          await refresh()
        }
      } catch (error) {
        errors.push(`${plan.stepId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // E. host-capability phases fail closed unless a real capability answers.
    for (const phase of HOST_PHASES) {
      const entry = step(phase)
      if (!entry || !entry.view.assignmentId || !['dispatching', 'running', 'waiting_report'].includes(entry.view.status)) continue
      try {
        const dependsOnPhase: BridgePhase = phase === 'cloud-production' ? 'image-production' : 'cloud-production'
        const upstream = step(dependsOnPhase)
        const upstreamManifest = upstream ? this.#latestManifestArtifact(view, upstream.stepId) : null
        if (!upstreamManifest) {
          await this.ports.execution.recordProgress(taskId, entry.stepId, 0.05, `等待 ${dependsOnPhase} 产物清单…`)
          continue
        }
        const outcome = await this.ports.hostCapability.run({
          capability: phase, taskId, projectId: task.projectId ?? 'unknown', manifest: upstreamManifest
        })
        if (outcome.ok === false) {
          const reason = outcome.externalCapability
            ? `${BLOCKED_BY_EXTERNAL_CAPABILITY}: ${outcome.reason}`
            : `${phase} 执行失败：${outcome.reason}`
          if (entry.view.status !== 'blocked') await blockStep(entry.stepId, reason)
          continue
        }
        await this.#finishStep(taskId, entry, {
          logicalName: entry.view.requiredOutputs[0]?.logicalName ?? `${phase}-manifest.json`,
          manifest: { schema: VIDEO_PRODUCTION_MANIFEST_SCHEMA, taskId, phase, capability: phase, ...outcome.manifest, generatedAt: this.now() }
        })
        actions.push(`host-complete:${entry.stepId}`)
        await refresh()
      } catch (error) {
        errors.push(`${entry.stepId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // F. final verification: aggregate real artifacts, then leave the human gate to the board.
    const verify = step('final-verification')
    if (verify && verify.view.assignmentId && ['dispatching', 'running', 'waiting_report'].includes(verify.view.status)) {
      try {
        const predecessorPhases: readonly BridgePhase[] = ['rewrite', 'visual', 'production-plan', 'image-production', 'cloud-production', 'jianying']
        const checks: Record<string, unknown>[] = []
        const artifactIndex: Record<string, unknown>[] = []
        for (const phase of predecessorPhases) {
          const predecessor = step(phase)
          const manifest = predecessor ? this.#latestManifestArtifact(view, predecessor.stepId) : null
          checks.push({ phase, stepId: predecessor?.stepId ?? null, status: manifest ? 'passed' : 'missing', manifest: manifest ? record(manifest).logicalName ?? null : null })
          if (manifest) artifactIndex.push(record(manifest))
        }
        const missing = checks.filter(item => item.status === 'missing')
        if (missing.length > 0) {
          await this.ports.execution.recordProgress(taskId, verify.stepId, 0.1,
            `最终验证被阻塞：缺少 ${missing.map(item => String(item.phase)).join('、')} 产物清单`)
        } else {
          await this.#finishStep(taskId, verify, {
            logicalName: verify.view.requiredOutputs[0]?.logicalName ?? 'production-manifest.json',
            manifest: {
              schema: VIDEO_PRODUCTION_MANIFEST_SCHEMA, taskId, projectId: task.projectId ?? null,
              phase: 'final-verification', checks, artifacts: artifactIndex, scripts,
              generatedAt: this.now()
            }
          })
          actions.push(`verify-ready:${verify.stepId}`)
          await refresh()
        }
      } catch (error) {
        errors.push(`${verify.stepId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return { taskId, actions, ...(errors.length ? { errors } : {}) }
  }

  now(): string {
    return (this.options.clock ?? (() => new Date()))().toISOString()
  }

  #workerRun(taskId: string): unknown {
    try { return this.ports.worker.workflowSnapshot(taskId) } catch { return null }
  }

  #latestManifestArtifact(view: ExecutionTaskSnapshot, stepId: string): Record<string, unknown> | null {
    const assignmentId = view.runtime.steps.find(item => item.stepId === stepId)?.assignmentId
    const events = view.events.filter(event =>
      event.type === 'artifact.produced' && event.stepId === stepId && (!assignmentId || event.assignmentId === assignmentId))
    const latest = events[events.length - 1]
    return latest ? record(latest.payload) : null
  }

  // After completion is requested, close the automated gate. Steps whose gate includes
  // human_review (final verification) deliberately stay verifying for the operator.
  async #closeGate(taskId: string, entry: { stepId: string; view: StepView }): Promise<void> {
    if (entry.view.humanGate) return
    const fresh = await this.ports.execution.getTask(taskId)
    const runtime = fresh.runtime.steps.find(item => item.stepId === entry.stepId)
    if (runtime?.status !== 'verifying') return
    const missing = this.#requiredOutputGaps(fresh, entry)
    if (missing.length === 0) {
      await this.ports.execution.gatePassed(taskId, entry.stepId, {
        source: VIDEO_GENERATION_TASK_BRIDGE, note: '自动验证通过：全部必需产物已按本次执行登记。', assignmentId: runtime.assignmentId
      })
    } else {
      await this.ports.execution.gateFailed(taskId, entry.stepId, `缺少必需产物：${missing.join('、')}`)
    }
  }

  // Record the aggregated manifest, submit completion and close the automated gate.
  async #finishStep(
    taskId: string,
    entry: { stepId: string; view: StepView },
    manifestInput: { logicalName: string; manifest: Record<string, unknown> }
  ): Promise<void> {
    const assignmentId = entry.view.assignmentId
    if (!assignmentId) throw new Error(`step ${entry.stepId} has no assignment`)
    const eventId = `evt-art-${hashId({ taskId, stepId: entry.stepId, assignmentId, logicalName: manifestInput.logicalName })}`
    await this.ports.execution.recordArtifact(taskId, entry.stepId, {
      artifactId: `art-${hashId({ taskId, stepId: entry.stepId, assignmentId })}`,
      logicalName: manifestInput.logicalName,
      kind: 'json',
      mimeType: 'application/json',
      assignmentId,
      bridge: VIDEO_GENERATION_TASK_BRIDGE,
      content: JSON.stringify(manifestInput.manifest)
    }, { eventId })
    await this.ports.execution.recordProgress(taskId, entry.stepId, 1, '阶段产物已登记，提交验证')
    await this.ports.execution.requestCompletion(taskId, entry.stepId)
    await this.#closeGate(taskId, entry)
  }

  #requiredOutputGaps(view: ExecutionTaskSnapshot, entry: { stepId: string; view: StepView }): string[] {
    const assignmentId = view.runtime.steps.find(item => item.stepId === entry.stepId)?.assignmentId
    const artifacts = view.events.filter(event =>
      event.type === 'artifact.produced' && event.stepId === entry.stepId && event.assignmentId === assignmentId)
    return entry.view.requiredOutputs.filter(output => {
      const ids = new Set(artifacts
        .filter(event => record(event.payload).logicalName === output.logicalName)
        .map(event => String(record(event.payload).artifactId ?? event.eventId)))
      return ids.size < (output.minCount ?? 1)
    }).map(output => output.logicalName)
  }

  // Aggregate completed worker stages into the Execution Runtime: one manifest artifact
  // per step, recorded under the live assignment so the completion gate can verify it.
  async #completeFromStages(
    taskId: string,
    entry: { stepId: string; view: StepView },
    completed: WorkerStageView[]
  ): Promise<void> {
    const status = entry.view.status
    if (['dispatching', 'running', 'waiting_report'].includes(status)) {
      const assignmentId = entry.view.assignmentId
      if (!assignmentId) throw new Error(`step ${entry.stepId} has no assignment`)
      const manifest = {
        schema: VIDEO_PRODUCTION_MANIFEST_SCHEMA, taskId, phase: entry.stepId,
        stages: completed.map(stage => ({
          stageRunId: stage.stageRunId, workItemId: stage.workItemId,
          artifacts: stage.artifacts.map(item => stageArtifactRef(stage, item))
        })),
        artifactCount: completed.reduce((sum, stage) => sum + stage.artifacts.length, 0),
        generatedAt: this.now()
      }
      const logicalName = entry.view.requiredOutputs[0]?.logicalName ?? 'stage-manifest.json'
      await this.ports.execution.recordArtifact(taskId, entry.stepId, {
        artifactId: `art-${hashId({ taskId, stepId: entry.stepId, assignmentId })}`,
        logicalName, kind: 'json', mimeType: 'application/json', assignmentId,
        bridge: VIDEO_GENERATION_TASK_BRIDGE, content: JSON.stringify(manifest)
      }, { eventId: `evt-art-${hashId({ taskId, stepId: entry.stepId, assignmentId, logicalName })}` })
      await this.ports.execution.recordProgress(taskId, entry.stepId, 1, '全部工位阶段已完成，提交验证')
      await this.ports.execution.requestCompletion(taskId, entry.stepId)
      await this.#closeGate(taskId, entry)
      return
    }
    if (status === 'verifying' && !entry.view.humanGate) {
      await this.#closeGate(taskId, entry)
    }
  }

  // Read the human intake artifact and install the Worker v2 run for this task.
  // Every failure mode throws with the exact missing input; the caller moves the
  // rewrite step to blocked. Never a fabricated success.
  async #installRun(view: ExecutionTaskSnapshot, taskId: string): Promise<void> {
    const task = view.definition.task
    if (!task.projectId) throw new Error('任务缺少项目归属，无法安装视频生产运行。')
    const intakeStep = view.definition.steps.find(item => record(item.metadata).workflowPhase === 'intake')
    const inputsEvent = intakeStep
      ? [...view.events].reverse().find(event =>
          event.type === 'artifact.produced' && event.stepId === intakeStep.stepId &&
          record(event.payload).logicalName === 'video-production-inputs.json')
      : undefined
    if (!inputsEvent) throw new Error('缺少生产输入产物 video-production-inputs.json：请在任务看板完成「生产输入与项目配置」。')
    const raw = await this.ports.artifactContent.read(record(inputsEvent.payload))
    if (raw == null) throw new Error('生产输入产物内容不可读：请以内容或 LOCAL 文件方式登记 video-production-inputs.json。')
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch (error) {
      throw new Error(`生产输入 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`)
    }
    const input = record(parsed)
    if (input.schema !== VIDEO_PRODUCTION_INPUTS_SCHEMA) throw new Error(`生产输入 schema 必须是 ${VIDEO_PRODUCTION_INPUTS_SCHEMA}。`)
    const rawSources = Array.isArray(input.sources) ? input.sources : []
    if (rawSources.length < 1 || rawSources.length > 1000) throw new Error('生产输入 sources 必须包含 1..1000 个脚本。')
    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    const idRe = /^[A-Za-z0-9._:-]{1,256}$/
    const sources: VideoGenerationSourceInput[] = []
    for (const value of rawSources) {
      const source = record(value)
      const storage = record(source.storage)
      const path = typeof storage.path === 'string' ? storage.path.trim() : ''
      const workItemId = typeof source.workItemId === 'string' ? source.workItemId.trim() : ''
      const scriptName = typeof source.scriptName === 'string' ? source.scriptName.trim() : ''
      const productionDate = typeof source.productionDate === 'string' ? source.productionDate.trim() : ''
      if (!idRe.test(workItemId)) throw new Error(`脚本 workItemId 非法：${workItemId || '(空)'}`)
      if (!scriptName || scriptName.length > 1024) throw new Error(`脚本 scriptName 非法：${scriptName || '(空)'}`)
      if (!dateRe.test(productionDate) || Number.isNaN(new Date(`${productionDate}T00:00:00Z`).getTime())) {
        throw new Error(`脚本 ${scriptName} 的 productionDate 必须是 YYYY-MM-DD。`)
      }
      if (storage.provider !== 'LOCAL' || !path) throw new Error(`脚本 ${scriptName} 的原始文件必须是 LOCAL 存储路径。`)
      if (!fs.existsSync(path)) throw new Error(`脚本 ${scriptName} 的原始文件不存在：${path}`)
      sources.push({
        workItemId,
        scriptName,
        productionDate,
        path,
        logicalName: typeof storage.logicalName === 'string' && storage.logicalName.trim()
          ? storage.logicalName.trim()
          : path.replace(/\\/g, '/').split('/').pop() ?? path
      })
    }
    const profile = await this.ports.productionProfiles.get(task.projectId)
    const driveFolderId = typeof input.driveFolderId === 'string' && input.driveFolderId.trim()
      ? input.driveFolderId.trim()
      : profile?.driveFolderId ?? ''
    if (!driveFolderId) throw new Error('缺少 driveFolderId：请在生产输入或项目生产配置中提供云端生产目录。')
    const imageBatchSize = input.imageBatchSize ?? profile?.imageBatchSize ?? 10
    if (!Number.isSafeInteger(Number(imageBatchSize)) || Number(imageBatchSize) < 1 || Number(imageBatchSize) > 10) {
      throw new Error(`imageBatchSize 必须是 1..10 的整数：${String(imageBatchSize)}`)
    }
    const profileRevision = profile?.revision ?? (Number.isSafeInteger(Number(input.profileRevision)) ? Number(input.profileRevision) : 1)
    installVideoGenerationWorkflow(this.ports.worker as never, {
      workflowRunId: taskId,
      taskId,
      projectId: task.projectId,
      profileRevision,
      driveFolderId,
      imageBatchSize: Number(imageBatchSize),
      sources: sources.map(source => ({
        workItemId: source.workItemId,
        scriptName: source.scriptName,
        productionDate: source.productionDate,
        sourceArtifact: {
          artifactId: `src-${hashId({ taskId, workItemId: source.workItemId, path: source.path })}`,
          workflowRunId: taskId,
          workItemId: source.workItemId,
          stageRunId: `${source.workItemId}:source`,
          logicalName: source.logicalName,
          kind: 'text',
          mimeType: 'text/plain',
          storage: { provider: 'LOCAL', path: source.path },
          producer: { workerDefinitionId: 'intake', workerSlotId: `${taskId}:intake`, workerSessionId: `human-intake:${taskId}` }
        } satisfies WorkflowArtifactRef
      })),
      idempotencyKey: `${taskId}:install`
    })
  }
}

type VideoGenerationSourceInput = { workItemId: string; scriptName: string; productionDate: string; path: string; logicalName: string }

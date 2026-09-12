import type { WorkflowArtifactRef, WorkflowWorkerBinding } from '../worker-runtime/v2/contracts.ts'
import type { Zero3WorkflowWorkerRuntime } from '../worker-runtime/v2/workflow-worker-runtime.ts'
import { planImageBatches } from './image-batch-planner.ts'
import { parseVisualPlan } from './visual-plan-parser.ts'
import {
  buildVideoImageInstruction,
  buildVideoRewriteInstruction,
  buildVideoVisualInstruction,
  imagePackageNames,
  rewriteOutputName,
  safeProductionFilename,
  visualOutputNames
} from './video-generation-prompts.ts'

export const VIDEO_GENERATION_MODULE_ID = 'video-generation'
export const VIDEO_GENERATION_MODULE_VERSION = 'v1'

export type VideoGenerationSource = {
  workItemId: string
  scriptName: string
  sourceArtifact: WorkflowArtifactRef
  productionDate: string
}
export type InstallVideoGenerationWorkflowInput = {
  workflowRunId: string
  taskId: string
  projectId: string
  profileRevision: number
  driveFolderId: string
  imageBatchSize?: number
  sources: VideoGenerationSource[]
  idempotencyKey: string
}
export type MaterializeVideoProductionPlanInput = {
  workflowRunId: string
  workItemId: string
  scriptName: string
  productionDate: string
  visualPlan: unknown
  imageBatchSize?: number
  idempotencyKey: string
}

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}
function requiredText(value: unknown, label: string, max = 4096): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is invalid`)
  return text
}
function productionDate(value: unknown): string {
  const text = requiredText(value, 'productionDate', 10)
  if (!DATE_RE.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) throw new Error('productionDate must use YYYY-MM-DD')
  return text
}
function batchSize(value: unknown): number {
  const number = value == null ? 10 : Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > 10) throw new Error('imageBatchSize must be an integer between 1 and 10')
  return number
}
function workerBinding(workflowRunId: string, role: 'script' | 'visual' | 'image'): WorkflowWorkerBinding {
  const definition = role === 'script' ? 'script-rewriter' : role === 'visual' ? 'visual-planner' : 'image-producer'
  const capability = role === 'script' ? 'script-rewrite' : role === 'visual' ? 'visual-plan' : 'image-generation'
  return {
    workflowRunId,
    moduleId: VIDEO_GENERATION_MODULE_ID,
    moduleVersion: VIDEO_GENERATION_MODULE_VERSION,
    workerDefinitionId: definition,
    workerSlotId: `${workflowRunId}:${role}`,
    provider: 'GPT_WEB',
    requiredCapabilities: [capability],
    maxBatchSize: 1,
    sessionPolicy: {
      maxItemsPerPhysicalSession: role === 'image' ? 10 : 1,
      rotateOnContextRisk: true,
      rotateOnStall: true
    }
  }
}
function workerBindings(workflowRunId: string) {
  return [
    { binding: workerBinding(workflowRunId, 'script'), role: '视频脚本重构工位', promptRevision: 'video-generation-script-worker.v1' },
    { binding: workerBinding(workflowRunId, 'visual'), role: '视频视觉规划工位', promptRevision: 'video-generation-visual-worker.v1' },
    { binding: workerBinding(workflowRunId, 'image'), role: '视频图片生产工位', promptRevision: 'video-generation-image-worker.v1' }
  ]
}

export function videoGenerationInitialWorkItem(sourceValue: VideoGenerationSource): Record<string, unknown> {
  const workItemId = id(sourceValue.workItemId, 'workItemId')
  const scriptName = requiredText(sourceValue.scriptName, 'scriptName', 1024)
  const date = productionDate(sourceValue.productionDate)
  const rewrite = rewriteOutputName(scriptName, date)
  const visual = visualOutputNames(scriptName, date)
  return {
    workItemId,
    title: scriptName,
    metadata: { module: VIDEO_GENERATION_MODULE_ID, scriptName, productionDate: date, phase: 'rewrite_visual' },
    stages: [
      {
        stageRunId: `${workItemId}:rewrite`, stageKey: 'script-rewrite',
        workerDefinitionId: 'script-rewriter', requiredCapability: 'script-rewrite',
        instruction: buildVideoRewriteInstruction(scriptName, date),
        skill: { id: 'cognitive-store-script' }, inputs: [sourceValue.sourceArtifact],
        expectedOutputs: [{ logicalName: rewrite, kind: 'markdown', mimeType: 'text/markdown', required: true }],
        policy: { maxAttempts: 3, leaseSeconds: 1800 },
        metadata: { module: VIDEO_GENERATION_MODULE_ID, scriptName, productionDate: date }
      },
      {
        stageRunId: `${workItemId}:visual`, stageKey: 'visual-plan',
        workerDefinitionId: 'visual-planner', requiredCapability: 'visual-plan', dependsOn: [`${workItemId}:rewrite`],
        instruction: buildVideoVisualInstruction(scriptName, date),
        skill: { id: 'cognitive-store-visual' },
        expectedOutputs: [
          { logicalName: visual.markdown, kind: 'markdown', mimeType: 'text/markdown', required: true },
          { logicalName: visual.json, kind: 'json', mimeType: 'application/json', required: true },
          { logicalName: visual.remotionHandoff, kind: 'archive', mimeType: 'application/zip', required: true }
        ],
        policy: { maxAttempts: 3, leaseSeconds: 1800 },
        metadata: { module: VIDEO_GENERATION_MODULE_ID, scriptName, productionDate: date, visualPlanSchema: 'zero3.visual-plan.v1' }
      }
    ]
  }
}

export function installVideoGenerationWorkflow(runtime: Zero3WorkflowWorkerRuntime, inputValue: InstallVideoGenerationWorkflowInput): Record<string, unknown> {
  const workflowRunId = id(inputValue.workflowRunId, 'workflowRunId')
  const taskId = id(inputValue.taskId, 'taskId')
  const projectId = id(inputValue.projectId, 'projectId')
  const profileRevision = Number(inputValue.profileRevision)
  if (!Number.isSafeInteger(profileRevision) || profileRevision < 1) throw new Error('profileRevision must be a positive integer')
  const driveFolderId = requiredText(inputValue.driveFolderId, 'driveFolderId', 2048)
  const imageBatchSize = batchSize(inputValue.imageBatchSize)
  const idempotencyKey = id(inputValue.idempotencyKey, 'idempotencyKey')
  if (!Array.isArray(inputValue.sources) || inputValue.sources.length === 0 || inputValue.sources.length > 1000) throw new Error('sources must contain 1..1000 scripts')

  runtime.ensureWorkflowRun({
    workflowRunId, taskId, moduleId: VIDEO_GENERATION_MODULE_ID, moduleVersion: VIDEO_GENERATION_MODULE_VERSION,
    metadata: { projectId, profileRevision, driveFolderId, imageBatchSize, autoProvisionGptWorkers: true, pipeline: 'rewrite-visual-dynamic-image', workItemCount: inputValue.sources.length }
  })
  const bindings = workerBindings(workflowRunId)
  for (const item of bindings) runtime.ensureWorkerBinding({ ...item, metadata: { module: VIDEO_GENERATION_MODULE_ID } })
  runtime.addWorkItems({
    workflowRunId,
    items: inputValue.sources.map(videoGenerationInitialWorkItem),
    idempotencyKey: `${idempotencyKey}-initial`
  })
  return { workflowRunId, taskId, projectId, moduleId: VIDEO_GENERATION_MODULE_ID, moduleVersion: VIDEO_GENERATION_MODULE_VERSION, bindings: bindings.map(item => item.binding.workerSlotId), snapshot: runtime.workflowSnapshot(workflowRunId) }
}

export function materializeVideoGenerationProductionPlan(runtime: Zero3WorkflowWorkerRuntime, inputValue: MaterializeVideoProductionPlanInput): Record<string, unknown> {
  const workflowRunId = id(inputValue.workflowRunId, 'workflowRunId')
  const workItemId = id(inputValue.workItemId, 'workItemId')
  const scriptName = requiredText(inputValue.scriptName, 'scriptName', 1024)
  const date = productionDate(inputValue.productionDate)
  const size = batchSize(inputValue.imageBatchSize)
  const key = id(inputValue.idempotencyKey, 'idempotencyKey')
  const parsed = parseVisualPlan(inputValue.visualPlan)
  if (parsed.plan.scriptId !== workItemId) throw new Error(`visual plan scriptId ${parsed.plan.scriptId} does not match workItemId ${workItemId}`)
  const before = runtime.workflowSnapshot(workflowRunId) as any
  if (before.run?.moduleId !== VIDEO_GENERATION_MODULE_ID) throw new Error('workflow run is not a video-generation module')
  const visualStage = before.stages?.find((stage: any) => stage.stageRunId === `${workItemId}:visual`)
  if (!visualStage || visualStage.status !== 'COMPLETED') throw new Error('visual plan stage must be completed before materializing production')

  const batches = planImageBatches(parsed.plan.shots, size)
  const imageStageIds = batches.map(batch => `${workItemId}:image-b${String(batch.ordinal).padStart(3, '0')}`)
  const packageNames = imagePackageNames(scriptName, date)
  const stages: Array<Record<string, unknown>> = batches.map((batch, index) => ({
    stageRunId: imageStageIds[index], stageKey: 'image-batch', workerDefinitionId: 'image-producer', requiredCapability: 'image-generation',
    dependsOn: [`${workItemId}:visual`], instruction: buildVideoImageInstruction(batch),
    expectedOutputs: batch.shots.map(shot => ({ logicalName: `${shot.shotId}.png`, kind: 'image', mimeType: 'image/png', required: true })),
    policy: { maxAttempts: 3, leaseSeconds: 1800 },
    metadata: { module: VIDEO_GENERATION_MODULE_ID, sourceWorkItemId: workItemId, batchId: batch.batchId, shotIds: batch.shotIds, imageCount: batch.shotIds.length, maxImagesPerBatch: 10 }
  }))
  const packageStageId = `${workItemId}:image-package`
  stages.push({
    stageRunId: packageStageId, stageKey: 'image-package', workerDefinitionId: 'image-producer', requiredCapability: 'image-generation',
    dependsOn: imageStageIds.length ? imageStageIds : [`${workItemId}:visual`],
    instruction: [
      '核对本脚本全部 requiresImage 分镜都已有按 Shot ID 登记的图片 Artifact；缺图时不得完成。',
      `生成 ${packageNames.imagesZip}、${packageNames.manifest}、${packageNames.imageToVideoHandoff}。`,
      '图生视频交接包只包含 image_to_video 分镜及其已验证首帧，不得混入 Remotion 分镜。'
    ].join('\n'),
    expectedOutputs: [
      { logicalName: packageNames.imagesZip, kind: 'archive', mimeType: 'application/zip', required: true },
      { logicalName: packageNames.manifest, kind: 'json', mimeType: 'application/json', required: true },
      { logicalName: packageNames.imageToVideoHandoff, kind: 'archive', mimeType: 'application/zip', required: true }
    ],
    policy: { maxAttempts: 3, leaseSeconds: 1800 },
    metadata: { module: VIDEO_GENERATION_MODULE_ID, sourceWorkItemId: workItemId, imageRequiredShotIds: parsed.imageRequiredShotIds, imageToVideoShotIds: parsed.plan.shots.filter(shot => shot.type === 'image_to_video').map(shot => shot.shotId) }
  })

  const productionWorkItemId = `${workItemId}-production`
  runtime.addWorkItems({
    workflowRunId, idempotencyKey: `${key}-production`,
    items: [{
      workItemId: productionWorkItemId,
      title: `${safeProductionFilename(scriptName)} · 图片生产`,
      metadata: {
        module: VIDEO_GENERATION_MODULE_ID, sourceWorkItemId: workItemId, productionDate: date,
        visualPlanSchema: parsed.plan.schema, totalShots: parsed.totalShots, staticShots: parsed.staticShots,
        imageToVideoShots: parsed.imageToVideoShots, remotionShots: parsed.remotionShots,
        imageRequiredShots: parsed.imageRequiredShotIds.length, imageBatchCount: batches.length
      },
      stages
    }]
  })
  return {
    workflowRunId, workItemId, productionWorkItemId,
    summary: { totalShots: parsed.totalShots, staticShots: parsed.staticShots, imageToVideoShots: parsed.imageToVideoShots, remotionShots: parsed.remotionShots, imageRequiredShots: parsed.imageRequiredShotIds.length, imageBatchCount: batches.length },
    batches: batches.map(batch => ({ batchId: batch.batchId, shotIds: batch.shotIds })),
    snapshot: runtime.workflowSnapshot(workflowRunId)
  }
}
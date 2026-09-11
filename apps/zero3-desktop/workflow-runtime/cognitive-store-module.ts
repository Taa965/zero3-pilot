import type { WorkflowArtifactRef, WorkflowWorkerBinding } from '../worker-runtime/v2/contracts.ts'
import type { Zero3WorkflowWorkerRuntime } from '../worker-runtime/v2/workflow-worker-runtime.ts'

export const COGNITIVE_STORE_MODULE_ID = 'cognitive-store'
export const COGNITIVE_STORE_MODULE_VERSION = 'v1'
export const COGNITIVE_STORE_IMAGE_BATCH_LIMIT = 10

export type CognitiveStoreSource = {
  workItemId: string
  title: string
  sourceArtifact: WorkflowArtifactRef
  chapterImageCounts: number[]
}

export type InstallCognitiveStoreWorkflowInput = {
  workflowRunId: string
  taskId: string
  projectId: string
  sources: CognitiveStoreSource[]
  idempotencyKey: string
}

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}
function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`${label} must be an integer between 1 and 10000`)
  }
  return value
}

export function cognitiveStoreImageBatches(imageCount: number): number[] {
  let remaining = positiveInt(imageCount, 'imageCount')
  const batches: number[] = []
  while (remaining > 0) {
    const size = Math.min(COGNITIVE_STORE_IMAGE_BATCH_LIMIT, remaining)
    batches.push(size)
    remaining -= size
  }
  return batches
}

function workerBinding(
  workflowRunId: string,
  workerDefinitionId: string,
  workerSlotId: string,
  capability: string,
  maxItemsPerPhysicalSession: number
): WorkflowWorkerBinding {
  return {
    workflowRunId,
    moduleId: COGNITIVE_STORE_MODULE_ID,
    moduleVersion: COGNITIVE_STORE_MODULE_VERSION,
    workerDefinitionId,
    workerSlotId,
    provider: 'GPT_WEB',
    requiredCapabilities: [capability],
    maxBatchSize: 1,
    sessionPolicy: {
      maxItemsPerPhysicalSession,
      rotateOnContextRisk: true,
      rotateOnStall: true
    }
  }
}

export function cognitiveStoreWorkerBindings(workflowRunIdValue: unknown): Array<{
  binding: WorkflowWorkerBinding
  role: string
  promptRevision: string
}> {
  const workflowRunId = id(workflowRunIdValue, 'workflowRunId')
  return [
    {
      binding: workerBinding(workflowRunId, 'script-rewriter', 'script-worker-01', 'script-rewrite', 10),
      role: '认知便利店脚本重构工位',
      promptRevision: 'cognitive-store-script-worker.v1'
    },
    {
      binding: workerBinding(workflowRunId, 'visual-planner', 'visual-worker-01', 'visual-plan', 10),
      role: '认知便利店视觉规划工位',
      promptRevision: 'cognitive-store-visual-worker.v1'
    },
    {
      binding: workerBinding(workflowRunId, 'image-producer', 'image-worker-01', 'image-generation', 10),
      role: '认知便利店图片生产工位',
      promptRevision: 'cognitive-store-image-worker.v1'
    }
  ]
}

function imageExpectedOutputs(workItemId: string, chapterIndex: number, batchIndex: number, count: number) {
  return Array.from({ length: count }, (_, imageIndex) => ({
    logicalName: `${workItemId}-C${String(chapterIndex).padStart(2, '0')}-B${String(batchIndex).padStart(2, '0')}-I${String(imageIndex + 1).padStart(2, '0')}.png`,
    kind: 'image',
    mimeType: 'image/png',
    required: true
  }))
}

export function cognitiveStoreWorkItem(source: CognitiveStoreSource): Record<string, unknown> {
  const workItemId = id(source.workItemId, 'workItemId')
  const title = String(source.title ?? '').trim()
  if (!title || title.length > 1024) throw new Error('title is invalid')
  if (!Array.isArray(source.chapterImageCounts) || source.chapterImageCounts.length === 0) {
    throw new Error('chapterImageCounts must contain at least one chapter')
  }
  const chapterCounts = source.chapterImageCounts.map((value, index) => positiveInt(value, `chapterImageCounts[${index}]`))
  const scriptStageId = `${workItemId}:script`
  const visualStageId = `${workItemId}:visual`
  const overviewStageId = `${workItemId}:image-overview`
  const imageStages: Array<Record<string, unknown>> = []
  const imageStageIds: string[] = [overviewStageId]

  for (const [chapterIndex, imageCount] of chapterCounts.entries()) {
    const batches = cognitiveStoreImageBatches(imageCount)
    for (const [batchIndex, batchCount] of batches.entries()) {
      const stageRunId = `${workItemId}:image-c${chapterIndex + 1}-b${batchIndex + 1}`
      imageStageIds.push(stageRunId)
      imageStages.push({
        stageRunId,
        stageKey: 'image-chapter-batch',
        workerDefinitionId: 'image-producer',
        requiredCapability: 'image-generation',
        dependsOn: [visualStageId],
        instruction: `按完整视觉规划生成第 ${chapterIndex + 1} 章第 ${batchIndex + 1}/${batches.length} 批静帧，共 ${batchCount} 张；单批禁止超过 10 张。`,
        expectedOutputs: imageExpectedOutputs(workItemId, chapterIndex + 1, batchIndex + 1, batchCount),
        policy: { maxAttempts: 3, leaseSeconds: 1800 },
        metadata: {
          module: COGNITIVE_STORE_MODULE_ID,
          chapterIndex: chapterIndex + 1,
          batchIndex: batchIndex + 1,
          batchCount: batches.length,
          imageCount: batchCount,
          maxImagesPerBatch: COGNITIVE_STORE_IMAGE_BATCH_LIMIT
        }
      })
    }
  }

  return {
    workItemId,
    title,
    metadata: {
      module: COGNITIVE_STORE_MODULE_ID,
      chapterImageCounts: chapterCounts
    },
    stages: [
      {
        stageRunId: scriptStageId,
        stageKey: 'script-rewrite',
        workerDefinitionId: 'script-rewriter',
        requiredCapability: 'script-rewrite',
        instruction: '调用认知便利店脚本 Skill 完成完整重构；保持风格与节奏，但不得简单洗稿。',
        skill: { id: 'cognitive-store-script' },
        inputs: [source.sourceArtifact],
        expectedOutputs: [{ logicalName: '重构脚本.md', kind: 'markdown', mimeType: 'text/markdown', required: true }],
        policy: { maxAttempts: 3, leaseSeconds: 1800 },
        metadata: { module: COGNITIVE_STORE_MODULE_ID }
      },
      {
        stageRunId: visualStageId,
        stageKey: 'visual-plan',
        workerDefinitionId: 'visual-planner',
        requiredCapability: 'visual-plan',
        dependsOn: [scriptStageId],
        instruction: '根据上游重构脚本生成完整视觉规划：完整脚本 → 大分镜 → 小分镜/生产单元 → 资产，并明确静帧、动态视频与 Remotion 分工。',
        skill: { id: 'cognitive-store-visual' },
        expectedOutputs: [{ logicalName: '完整视觉规划.md', kind: 'markdown', mimeType: 'text/markdown', required: true }],
        policy: { maxAttempts: 3, leaseSeconds: 1800 },
        metadata: { module: COGNITIVE_STORE_MODULE_ID }
      },
      {
        stageRunId: overviewStageId,
        stageKey: 'image-overview',
        workerDefinitionId: 'image-producer',
        requiredCapability: 'image-generation',
        dependsOn: [visualStageId],
        instruction: '先根据完整视觉规划生成本 WorkItem 的总览图，展示全部主要分镜与视觉机制。',
        expectedOutputs: [{ logicalName: 'M1总览.png', kind: 'image', mimeType: 'image/png', required: true }],
        policy: { maxAttempts: 3, leaseSeconds: 1800 },
        metadata: { module: COGNITIVE_STORE_MODULE_ID, imageRole: 'overview', imageCount: 1 }
      },
      ...imageStages,
      {
        stageRunId: `${workItemId}:image-package`,
        stageKey: 'image-package',
        workerDefinitionId: 'image-producer',
        requiredCapability: 'image-generation',
        dependsOn: imageStageIds,
        instruction: '确认总览与全部章节图片均已登记，生成图片生产清单；缺图时不得宣告完成。',
        expectedOutputs: [{ logicalName: '图片生产清单.json', kind: 'json', mimeType: 'application/json', required: true }],
        policy: { maxAttempts: 3, leaseSeconds: 1800 },
        metadata: { module: COGNITIVE_STORE_MODULE_ID, imageRole: 'package' }
      }
    ]
  }
}

export function installCognitiveStoreWorkflow(
  runtime: Zero3WorkflowWorkerRuntime,
  inputValue: InstallCognitiveStoreWorkflowInput
): Record<string, unknown> {
  const workflowRunId = id(inputValue.workflowRunId, 'workflowRunId')
  const taskId = id(inputValue.taskId, 'taskId')
  const projectId = id(inputValue.projectId, 'projectId')
  const idempotencyKey = id(inputValue.idempotencyKey, 'idempotencyKey')
  if (!Array.isArray(inputValue.sources) || inputValue.sources.length === 0 || inputValue.sources.length > 1000) {
    throw new Error('sources must contain 1..1000 scripts')
  }

  runtime.ensureWorkflowRun({
    workflowRunId,
    taskId,
    projectId,
    moduleId: COGNITIVE_STORE_MODULE_ID,
    moduleVersion: COGNITIVE_STORE_MODULE_VERSION,
    metadata: { projectId, autoProvisionGptWorkers: true, pipeline: 'script-visual-image', workItemCount: inputValue.sources.length }
  })

  const bindings = cognitiveStoreWorkerBindings(workflowRunId)
  for (const item of bindings) {
    runtime.ensureWorkerBinding({ ...item, metadata: { module: COGNITIVE_STORE_MODULE_ID } })
  }

  runtime.addWorkItems({
    workflowRunId,
    items: inputValue.sources.map(cognitiveStoreWorkItem),
    idempotencyKey: `${idempotencyKey}-items`
  })

  return {
    workflowRunId,
    taskId,
    projectId,
    moduleId: COGNITIVE_STORE_MODULE_ID,
    moduleVersion: COGNITIVE_STORE_MODULE_VERSION,
    bindings: bindings.map(item => item.binding.workerSlotId),
    snapshot: runtime.workflowSnapshot(workflowRunId)
  }
}

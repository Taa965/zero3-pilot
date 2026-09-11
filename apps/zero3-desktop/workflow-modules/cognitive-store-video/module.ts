import { randomUUID } from 'node:crypto'

import {
  ZERO3_WORKFLOW_MODULE,
  ZERO3_WORKFLOW_RUN,
  type WorkflowArtifactLocator,
  type WorkflowModule,
  type WorkflowRunPlan,
  type WorkflowValidationResult
} from '../../workflow-runtime/contracts.ts'
import {
  COGNITIVE_STORE_IMAGE_PROMPT,
  COGNITIVE_STORE_IMAGE_PROMPT_REVISION,
  COGNITIVE_STORE_SCRIPT_PROMPT,
  COGNITIVE_STORE_SCRIPT_PROMPT_REVISION,
  COGNITIVE_STORE_VISUAL_PROMPT,
  COGNITIVE_STORE_VISUAL_PROMPT_REVISION
} from './prompts.ts'
import { cognitiveStoreDriveLayout } from './handoff.ts'

export interface CognitiveStoreScriptInput {
  itemId?: string
  title: string
  localPath?: string
  driveFileId?: string
  driveWebUrl?: string
}

export interface CognitiveStoreVideoRunInput {
  projectId: string
  projectRootPath?: string
  title?: string
  scripts: readonly CognitiveStoreScriptInput[]
  drive?: { rootFolderId?: string | null }
  workers?: { script?: number; visual?: number; image?: number }
  cloud?: { executorId?: string | null }
}

function asInput(value: unknown): CognitiveStoreVideoRunInput | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CognitiveStoreVideoRunInput : null
}
function safeId(value: string): string { return value.trim().replace(/[^A-Za-z0-9._:-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 180) || `item-${randomUUID()}` }
function concurrency(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 8 ? Number(value) : 1 }

export const cognitiveStoreVideoModule: WorkflowModule = {
  manifest: {
    contract: ZERO3_WORKFLOW_MODULE,
    id: 'cognitive-store-video',
    version: '1.0.0',
    name: '认知便利店批量视频生产',
    description: 'GPT 脚本重构 → GPT 视觉规划 → GPT 图片生产 → Zero3 接包 → 云端视频 → 本地回传',
    uiKind: 'cognitive-store-video',
    requiredExecutors: ['GPT_WEB', 'ZERO3', 'REMOTE_COMPUTE'],
    requiredSkills: ['cognitive-store-script', 'cognitive-store-visual'],
    requiredPlugins: ['zero3-web-worker', 'google-drive'],
    requiredArtifactProviders: ['GOOGLE_DRIVE', 'LOCAL', 'REMOTE_COMPUTE']
  },

  validateCreateInput(value: unknown): WorkflowValidationResult {
    const input = asInput(value)
    const errors: string[] = []
    const warnings: string[] = []
    if (!input?.projectId?.trim()) errors.push('必须选择项目')
    if (!Array.isArray(input?.scripts) || input.scripts.length === 0) errors.push('至少需要一个脚本')
    if (Array.isArray(input?.scripts) && input.scripts.length > 1000) errors.push('单次运行最多 1000 个脚本')
    for (const [index, script] of input?.scripts?.entries?.() ?? []) {
      if (!script?.title?.trim()) errors.push(`脚本 ${index + 1} 缺少标题`)
      if (!script?.localPath?.trim() && !script?.driveFileId?.trim()) errors.push(`脚本 ${script?.title || index + 1} 缺少本地路径或 Drive fileId`)
      if (script?.localPath && script?.driveFileId) warnings.push(`脚本 ${script.title} 同时提供本地路径和 Drive fileId，将优先使用 Drive`)
    }
    return { valid: errors.length === 0, errors, warnings }
  },

  createRun(value: unknown): WorkflowRunPlan {
    const input = asInput(value)
    if (!input) throw new Error('cognitive store run input must be an object')
    const createdAt = new Date().toISOString()
    const workflowRunId = `csv-${createdAt.replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
    const driveRootFolderId = input.drive?.rootFolderId?.trim() || null
    const stages = [
      { stageId: 'input-ingest', title: '输入上传', executor: 'ZERO3' as const, workerDefinitionId: null, dependsOn: [], expectedOutputs: [{ logicalName: '原始脚本', kind: 'script', required: true }], completionGate: ['input_artifact_available'], maxAttempts: 3, metadata: { targetStorage: 'GOOGLE_DRIVE' } },
      { stageId: 'script-rewrite', title: '脚本重构', executor: 'GPT_WEB' as const, workerDefinitionId: 'script-worker', dependsOn: ['input-ingest'], expectedOutputs: [{ logicalName: '重构脚本.md', kind: 'markdown', mimeType: 'text/markdown', required: true }], completionGate: ['drive_file_id', 'non_empty'], maxAttempts: 3, metadata: { instruction: '读取当前 WorkItem 的原始脚本 Artifact，调用 cognitive-store-script Skill 完成认知便利店风格重构，并交付重构脚本.md。' } },
      { stageId: 'visual-plan', title: '视觉规划', executor: 'GPT_WEB' as const, workerDefinitionId: 'visual-worker', dependsOn: ['script-rewrite'], expectedOutputs: [
        { logicalName: '视觉内容.md', kind: 'markdown', mimeType: 'text/markdown', required: true },
        { logicalName: '导演审片单.md', kind: 'markdown', mimeType: 'text/markdown', required: true },
        { logicalName: '逐条完整提示词.md', kind: 'markdown', mimeType: 'text/markdown', required: true }
      ], completionGate: ['all_visual_documents', 'drive_file_ids'], maxAttempts: 3, metadata: { instruction: '读取重构脚本.md，调用 cognitive-store-visual Skill 完成视觉规划，交付视觉内容.md、导演审片单.md、逐条完整提示词.md。' } },
      { stageId: 'image-production', title: '图片生产', executor: 'GPT_WEB' as const, workerDefinitionId: 'image-worker', dependsOn: ['visual-plan'], expectedOutputs: [
        { logicalName: 'overview.png', kind: 'image', mimeType: 'image/png', required: true },
        { logicalName: '交接包.zip', kind: 'handoff-package', mimeType: 'application/zip', required: true }
      ], completionGate: ['overview_exists', 'image_count_matches', 'handoff_manifest_valid'], maxAttempts: 5, metadata: { instruction: '先生成总览图，再按章节生成独立图片；每批最多 10 张，全部图片校验后生成交接包.zip。', maxImagesPerBatch: 10, batching: 'chapter' } },
      { stageId: 'local-ingest', title: '本地接包', executor: 'ZERO3' as const, workerDefinitionId: null, dependsOn: ['image-production'], expectedOutputs: [{ logicalName: 'local-handoff', kind: 'local-package', required: true }], completionGate: ['zip_valid', 'manifest_valid'], maxAttempts: 3, metadata: {} },
      { stageId: 'cloud-render', title: '云端视频生产', executor: 'REMOTE_COMPUTE' as const, workerDefinitionId: null, dependsOn: ['local-ingest'], expectedOutputs: [{ logicalName: '云端视频结果集', kind: 'remote-video-set', required: true }], completionGate: ['remote_terminal_success'], maxAttempts: 3, metadata: { executorId: input.cloud?.executorId ?? null, forbidBlindResubmit: true } },
      { stageId: 'pullback', title: '视频回传', executor: 'ZERO3' as const, workerDefinitionId: null, dependsOn: ['cloud-render'], expectedOutputs: [{ logicalName: '视频回传清单.json', kind: 'video-result-manifest', mimeType: 'application/json', required: true }], completionGate: ['downloaded', 'non_empty', 'technical_qc'], maxAttempts: 3, metadata: {} }
    ]
    const workers = [
      { workerDefinitionId: 'script-worker', name: '脚本重构工位', executor: 'GPT_WEB' as const, concurrency: concurrency(input.workers?.script), capability: 'cognitive-store-script', promptRevision: COGNITIVE_STORE_SCRIPT_PROMPT_REVISION, skillId: 'cognitive-store-script', maxItemsPerPhysicalSession: 10, rotateOnContextRisk: true, rotateOnStall: true, metadata: { prompt: COGNITIVE_STORE_SCRIPT_PROMPT } },
      { workerDefinitionId: 'visual-worker', name: '视觉规划工位', executor: 'GPT_WEB' as const, concurrency: concurrency(input.workers?.visual), capability: 'cognitive-store-visual', promptRevision: COGNITIVE_STORE_VISUAL_PROMPT_REVISION, skillId: 'cognitive-store-visual', maxItemsPerPhysicalSession: 10, rotateOnContextRisk: true, rotateOnStall: true, metadata: { prompt: COGNITIVE_STORE_VISUAL_PROMPT } },
      { workerDefinitionId: 'image-worker', name: '图片生产工位', executor: 'GPT_WEB' as const, concurrency: concurrency(input.workers?.image), capability: 'cognitive-store-image', promptRevision: COGNITIVE_STORE_IMAGE_PROMPT_REVISION, maxItemsPerPhysicalSession: 5, rotateOnContextRisk: true, rotateOnStall: true, metadata: { prompt: COGNITIVE_STORE_IMAGE_PROMPT, maxImagesPerBatch: 10 } }
    ]
    const items = input.scripts.map((script, index) => {
      const itemId = safeId(script.itemId || `${String(index + 1).padStart(3, '0')}-${script.title}`)
      const storage: WorkflowArtifactLocator = script.driveFileId?.trim()
        ? { provider: 'GOOGLE_DRIVE', fileId: script.driveFileId.trim(), webUrl: script.driveWebUrl?.trim() || undefined, parentFolderId: driveRootFolderId || undefined }
        : { provider: 'LOCAL', path: script.localPath!.trim() }
      const alreadyInDrive = storage.provider === 'GOOGLE_DRIVE'
      const driveLayout = cognitiveStoreDriveLayout(workflowRunId, itemId)
      return {
        itemId,
        title: script.title.trim(),
        metadata: { sourceOrdinal: index + 1, driveLayout },
        initialArtifacts: [{
          stageId: 'input-ingest',
          logicalName: '原始脚本',
          kind: 'script',
          storage,
          state: 'AVAILABLE' as const,
          metadata: {
            sourceName: script.title.trim(),
            drivePathSegments: ['Zero3', 'runs', workflowRunId, itemId, '00_input'],
            driveLayout
          }
        }],
        completedStageIds: alreadyInDrive ? ['input-ingest'] : []
      }
    })
    return {
      contract: ZERO3_WORKFLOW_RUN,
      workflowRunId,
      moduleId: this.manifest.id,
      moduleVersion: this.manifest.version,
      projectId: input.projectId.trim(),
      title: input.title?.trim() || `认知便利店批量视频 · ${input.scripts.length} 条`,
      stages,
      workers,
      items,
      metadata: { driveRootFolderId, artifactTransport: 'GOOGLE_DRIVE', cloudExecutorId: input.cloud?.executorId ?? null, projectRootPath: input.projectRootPath?.trim() || null },
      createdAt
    }
  }
}

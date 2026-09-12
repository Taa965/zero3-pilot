import type { ImageBatchPlan } from './image-batch-planner.ts'
import type { VisualPlanShot } from './visual-plan-parser.ts'

export function safeProductionFilename(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '')
  if (!normalized) throw new Error('script name cannot be converted into a safe filename')
  return normalized.slice(0, 180)
}

export function rewriteOutputName(scriptName: string, date: string): string {
  return `${safeProductionFilename(scriptName)}_重构_${date}.md`
}
export function visualOutputNames(scriptName: string, date: string) {
  const base = safeProductionFilename(scriptName)
  return {
    markdown: `${base}_视觉方案_${date}.md`,
    json: `${base}_视觉方案_${date}.json`,
    remotionHandoff: `${base}_Remotion35云端执行交接包_${date}.zip`
  }
}
export function imagePackageNames(scriptName: string, date: string) {
  const base = safeProductionFilename(scriptName)
  return {
    imagesZip: `${base}_GPT静帧_${date}.zip`,
    manifest: `${base}_图片生产清单_${date}.json`,
    imageToVideoHandoff: `${base}_图生视频云端执行交接包_${date}.zip`
  }
}

export function buildVideoRewriteInstruction(scriptName: string, date: string): string {
  return [
    '调用 Claim 指定的认知便利店脚本 Skill，对输入原稿进行完整重构；不得逐句换词或沿原稿结构洗稿。',
    `最终必须输出文件：${rewriteOutputName(scriptName, date)}。`,
    '产物必须按 Zero3 Artifact 协议登记；不要只在聊天中声称已经完成。'
  ].join('\n')
}
export function buildVideoVisualInstruction(scriptName: string, date: string): string {
  const names = visualOutputNames(scriptName, date)
  return [
    '调用 Claim 指定的认知便利店视觉 Skill，基于上游重构脚本构建完整视觉方案。',
    `必须输出：${names.markdown}、${names.json}、${names.remotionHandoff}。`,
    'JSON 必须符合 zero3.visual-plan.v1；Markdown 末尾也应包含同一 JSON 的 ZERO3_VISUAL_PLAN machine block。',
    '每个分镜必须有唯一 shotId，并明确 static / image_to_video / remotion 及相应提示词。'
  ].join('\n')
}
export function buildVideoImageInstruction(batch: ImageBatchPlan): string {
  const details = batch.shots.map((shot: VisualPlanShot) => `${shot.shotId}: ${shot.imagePrompt ?? ''}`).join('\n')
  return [
    `只生成本 Claim 指定的 ${batch.shotIds.length} 张图片，禁止扩大批次；单批上限 10 张。`,
    `Shot IDs：${batch.shotIds.join('、')}`,
    details,
    '每张图片必须以对应 Shot ID 命名并逐一登记 Artifact；缺失 Shot 必须报告，不得用其他图片代替。'
  ].join('\n')
}
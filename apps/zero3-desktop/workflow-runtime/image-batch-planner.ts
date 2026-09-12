import type { VisualPlanShot } from './visual-plan-parser.ts'

export const VIDEO_IMAGE_BATCH_LIMIT = 10
export type ImageBatchPlan = {
  batchId: string
  ordinal: number
  shotIds: readonly string[]
  shots: readonly VisualPlanShot[]
}

export function planImageBatches(shots: readonly VisualPlanShot[], batchSize = VIDEO_IMAGE_BATCH_LIMIT): ImageBatchPlan[] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > VIDEO_IMAGE_BATCH_LIMIT) {
    throw new Error(`image batch size must be an integer between 1 and ${VIDEO_IMAGE_BATCH_LIMIT}`)
  }
  const required = shots.filter(shot => shot.requiresImage)
  const ids = required.map(shot => shot.shotId)
  if (new Set(ids).size !== ids.length) throw new Error('image batch planner received duplicate shot IDs')
  const batches: ImageBatchPlan[] = []
  for (let offset = 0; offset < required.length; offset += batchSize) {
    const items = required.slice(offset, offset + batchSize)
    const ordinal = batches.length + 1
    batches.push({ batchId: `image-batch-${String(ordinal).padStart(3, '0')}`, ordinal, shotIds: items.map(item => item.shotId), shots: items })
  }
  return batches
}

export function missingImageShotIds(plan: readonly VisualPlanShot[], completedShotIds: readonly string[]): string[] {
  const completed = new Set(completedShotIds)
  return plan.filter(shot => shot.requiresImage && !completed.has(shot.shotId)).map(shot => shot.shotId)
}

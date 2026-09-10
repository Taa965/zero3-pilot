export interface CognitiveStoreChapterBatch {
  chapterId: string
  shotCount: number
  batches: readonly { batchIndex: number; start: number; end: number; count: number }[]
}

export function splitChapterIntoImageBatches(chapterId: string, shotCount: number, maxBatchSize = 10): CognitiveStoreChapterBatch {
  if (!chapterId.trim()) throw new Error('chapterId is required')
  if (!Number.isSafeInteger(shotCount) || shotCount < 0) throw new Error('shotCount must be a non-negative integer')
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 10) throw new Error('maxBatchSize must be an integer between 1 and 10')
  const batches: { batchIndex: number; start: number; end: number; count: number }[] = []
  for (let start = 1, batchIndex = 1; start <= shotCount; start += maxBatchSize, batchIndex += 1) {
    const end = Math.min(shotCount, start + maxBatchSize - 1)
    batches.push({ batchIndex, start, end, count: end - start + 1 })
  }
  return { chapterId, shotCount, batches }
}

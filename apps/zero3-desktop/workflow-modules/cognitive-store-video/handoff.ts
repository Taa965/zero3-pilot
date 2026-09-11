export const COGNITIVE_STORE_HANDOFF_PROTOCOL = 'zero3.gpt-gpu-handoff/1.0' as const

export interface CognitiveStoreHandoffManifest {
  protocol: typeof COGNITIVE_STORE_HANDOFF_PROTOCOL
  workflow: string
  workflowRunId: string
  workItemId: string
  title: string
  imageCount: number
  images: readonly string[]
  scriptFile: string
  visualPlanFile: string
  directorReviewFile?: string
  promptsFile?: string
  remoteExecutionId?: string | null
}

export function cognitiveStoreDriveLayout(runId: string, itemId: string) {
  const root = `Zero3/runs/${runId}/${itemId}`
  return {
    root,
    input: `${root}/00_input`,
    script: `${root}/10_script`,
    visual: `${root}/20_visual`,
    images: `${root}/30_images`,
    handoff: `${root}/40_handoff`,
    output: `${root}/50_output`
  } as const
}

export function validateCognitiveStoreHandoffManifest(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['manifest must be an object']
  const manifest = value as Partial<CognitiveStoreHandoffManifest>
  if (manifest.protocol !== COGNITIVE_STORE_HANDOFF_PROTOCOL) errors.push(`protocol must be ${COGNITIVE_STORE_HANDOFF_PROTOCOL}`)
  for (const field of ['workflowRunId', 'workItemId', 'title', 'scriptFile', 'visualPlanFile'] as const) {
    if (typeof manifest[field] !== 'string' || !String(manifest[field]).trim()) errors.push(`${field} is required`)
  }
  if (!Number.isSafeInteger(manifest.imageCount) || Number(manifest.imageCount) < 1) errors.push('imageCount must be a positive integer')
  if (!Array.isArray(manifest.images)) errors.push('images must be an array')
  else {
    if (new Set(manifest.images).size !== manifest.images.length) errors.push('images contains duplicates')
    if (Number.isSafeInteger(manifest.imageCount) && manifest.images.length !== manifest.imageCount) errors.push('imageCount does not match images length')
    if (manifest.images.some(image => typeof image !== 'string' || !image.trim())) errors.push('images contains invalid file names')
  }
  return errors
}

export function shouldSubmitRemoteRender(manifest: CognitiveStoreHandoffManifest): boolean {
  return !manifest.remoteExecutionId?.trim()
}

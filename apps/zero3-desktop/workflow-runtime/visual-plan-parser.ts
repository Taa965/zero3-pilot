export const ZERO3_VISUAL_PLAN_SCHEMA = 'zero3.visual-plan.v1' as const
export const ZERO3_VISUAL_PLAN_BEGIN = '<!-- ZERO3_VISUAL_PLAN_BEGIN -->'
export const ZERO3_VISUAL_PLAN_END = '<!-- ZERO3_VISUAL_PLAN_END -->'

export type VisualShotType = 'static' | 'image_to_video' | 'remotion'
export type VisualPlanShot = {
  shotId: string
  type: VisualShotType
  requiresImage: boolean
  imagePrompt?: string
  videoPrompt?: string
  remotionPrompt?: string
  metadata: Readonly<Record<string, unknown>>
}
export type VisualPlan = {
  schema: typeof ZERO3_VISUAL_PLAN_SCHEMA
  scriptId: string
  shots: readonly VisualPlanShot[]
}
export type VisualPlanSummary = {
  plan: VisualPlan
  totalShots: number
  staticShots: number
  imageToVideoShots: number
  remotionShots: number
  imageRequiredShotIds: readonly string[]
}

const SHOT_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 64_000): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max) throw new Error(`${label} is invalid`)
  return result
}
function optionalText(value: unknown, label: string, max = 64_000): string | undefined {
  if (value == null || value === '') return undefined
  return text(value, label, max)
}
function jsonFromMarkdown(markdown: string): unknown {
  const begin = markdown.indexOf(ZERO3_VISUAL_PLAN_BEGIN)
  const end = markdown.indexOf(ZERO3_VISUAL_PLAN_END)
  if (begin < 0 || end < 0 || end <= begin) throw new Error('visual plan machine block is missing')
  let block = markdown.slice(begin + ZERO3_VISUAL_PLAN_BEGIN.length, end).trim()
  const fence = block.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) block = fence[1]!.trim()
  try { return JSON.parse(block) }
  catch (error) { throw new Error(`visual plan machine block is invalid JSON: ${error instanceof Error ? error.message : String(error)}`) }
}

export function parseVisualPlan(value: unknown): VisualPlanSummary {
  let raw: unknown = value
  if (typeof value === 'string') {
    const source = value.trim()
    if (!source) throw new Error('visual plan is empty')
    if (source.includes(ZERO3_VISUAL_PLAN_BEGIN)) raw = jsonFromMarkdown(source)
    else {
      try { raw = JSON.parse(source) }
      catch { throw new Error('visual plan must be JSON or contain the Zero3 machine block') }
    }
  }
  const input = object(raw, 'visual plan')
  if (input.schema !== ZERO3_VISUAL_PLAN_SCHEMA) throw new Error(`visual plan schema must be ${ZERO3_VISUAL_PLAN_SCHEMA}`)
  const scriptId = text(input.scriptId, 'visual plan scriptId', 256)
  if (!Array.isArray(input.shots) || input.shots.length === 0 || input.shots.length > 10_000) {
    throw new Error('visual plan shots must contain 1..10000 entries')
  }
  const seen = new Set<string>()
  const shots = input.shots.map((entry, index): VisualPlanShot => {
    const shot = object(entry, `shots[${index}]`)
    const shotId = text(shot.shotId, `shots[${index}].shotId`, 128)
    if (!SHOT_ID_RE.test(shotId)) throw new Error(`shotId is invalid: ${shotId}`)
    if (seen.has(shotId)) throw new Error(`duplicate shotId: ${shotId}`)
    seen.add(shotId)
    const type = shot.type
    if (type !== 'static' && type !== 'image_to_video' && type !== 'remotion') throw new Error(`shot ${shotId} type is invalid`)
    const requiresImage = shot.requiresImage == null ? type !== 'remotion' : shot.requiresImage
    if (typeof requiresImage !== 'boolean') throw new Error(`shot ${shotId} requiresImage must be boolean`)
    if (type === 'remotion' && requiresImage) throw new Error(`remotion shot ${shotId} cannot require an image`)
    const imagePrompt = optionalText(shot.imagePrompt, `shot ${shotId} imagePrompt`)
    const videoPrompt = optionalText(shot.videoPrompt, `shot ${shotId} videoPrompt`)
    const remotionPrompt = optionalText(shot.remotionPrompt, `shot ${shotId} remotionPrompt`)
    if (requiresImage && !imagePrompt) throw new Error(`shot ${shotId} requires an imagePrompt`)
    if (type === 'image_to_video' && !videoPrompt) throw new Error(`image_to_video shot ${shotId} requires a videoPrompt`)
    if (type === 'remotion' && !remotionPrompt) throw new Error(`remotion shot ${shotId} requires a remotionPrompt`)
    const metadata = shot.metadata == null ? {} : object(shot.metadata, `shot ${shotId} metadata`)
    return { shotId, type, requiresImage, ...(imagePrompt ? { imagePrompt } : {}), ...(videoPrompt ? { videoPrompt } : {}), ...(remotionPrompt ? { remotionPrompt } : {}), metadata: { ...metadata } }
  })
  const imageRequiredShotIds = shots.filter(shot => shot.requiresImage).map(shot => shot.shotId)
  return {
    plan: { schema: ZERO3_VISUAL_PLAN_SCHEMA, scriptId, shots },
    totalShots: shots.length,
    staticShots: shots.filter(shot => shot.type === 'static').length,
    imageToVideoShots: shots.filter(shot => shot.type === 'image_to_video').length,
    remotionShots: shots.filter(shot => shot.type === 'remotion').length,
    imageRequiredShotIds
  }
}

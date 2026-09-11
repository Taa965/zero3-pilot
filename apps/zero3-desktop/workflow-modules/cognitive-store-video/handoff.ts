export const COGNITIVE_STORE_HANDOFF_SCHEMA = 'zero3.gpt-gpu-handoff/1.0' as const
export const COGNITIVE_STORE_WAN_WORKFLOW = 'wan22-i2v-14b-lightx2v-api' as const

export interface CognitiveStoreHandoffJob {
  id: string
  workflow: typeof COGNITIVE_STORE_WAN_WORKFLOW
  start_image: string
  prompt: string
  negative_prompt?: string
  seed?: number
  width: number
  height: number
  timeout_seconds?: number
}

export interface CognitiveStoreHandoffManifest {
  schema: typeof COGNITIVE_STORE_HANDOFF_SCHEMA
  package_id: string
  project_id: string
  workflowRunId: string
  workItemId: string
  title: string
  execution?: { max_parallel?: number }
  jobs: readonly CognitiveStoreHandoffJob[]
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

function validRelativePath(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().replace(/\\/gu, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) return false
  const parts = normalized.split('/')
  return parts.every(part => Boolean(part) && part !== '.' && part !== '..')
}

export function validateCognitiveStoreHandoffManifest(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['manifest must be an object']
  const manifest = value as Partial<CognitiveStoreHandoffManifest>
  if (manifest.schema !== COGNITIVE_STORE_HANDOFF_SCHEMA) errors.push(`schema must be ${COGNITIVE_STORE_HANDOFF_SCHEMA}`)
  for (const field of ['package_id', 'project_id', 'workflowRunId', 'workItemId', 'title'] as const) {
    if (typeof manifest[field] !== 'string' || !String(manifest[field]).trim()) errors.push(`${field} is required`)
  }
  if (!Array.isArray(manifest.jobs) || manifest.jobs.length < 1 || manifest.jobs.length > 500) {
    errors.push('jobs must contain 1..500 items')
    return errors
  }
  const seen = new Set<string>()
  for (const [index, raw] of manifest.jobs.entries()) {
    const prefix = `jobs[${index}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${prefix} must be an object`); continue }
    const job = raw as Partial<CognitiveStoreHandoffJob>
    if (typeof job.id !== 'string' || !job.id.trim() || job.id.length > 160 || seen.has(job.id)) errors.push(`${prefix}.id is invalid or duplicated`)
    else seen.add(job.id)
    if ((job.workflow ?? COGNITIVE_STORE_WAN_WORKFLOW) !== COGNITIVE_STORE_WAN_WORKFLOW) errors.push(`${prefix}.workflow is unsupported`)
    if (!validRelativePath(job.start_image)) errors.push(`${prefix}.start_image must be a safe relative path`)
    if (typeof job.prompt !== 'string' || !job.prompt.trim() || job.prompt.length > 50_000) errors.push(`${prefix}.prompt is empty or too long`)
    if (job.negative_prompt != null && (typeof job.negative_prompt !== 'string' || job.negative_prompt.length > 50_000)) errors.push(`${prefix}.negative_prompt is invalid`)
    if (job.seed != null && (typeof job.seed !== 'number' || !Number.isSafeInteger(job.seed) || job.seed < 0 || job.seed > (2 ** 53) - 1)) errors.push(`${prefix}.seed is invalid`)
    for (const dimension of ['width', 'height'] as const) {
      const dimensionValue = Number(job[dimension])
      if (!Number.isSafeInteger(dimensionValue) || dimensionValue < 512 || dimensionValue > 1280 || dimensionValue % 32 !== 0) errors.push(`${prefix}.${dimension} must be a 32-multiple between 512 and 1280`)
    }
    if (job.timeout_seconds != null && (!Number.isSafeInteger(job.timeout_seconds) || job.timeout_seconds < 60 || job.timeout_seconds > 86_400)) errors.push(`${prefix}.timeout_seconds is invalid`)
  }
  if (manifest.execution?.max_parallel != null && (!Number.isSafeInteger(manifest.execution.max_parallel) || manifest.execution.max_parallel < 1 || manifest.execution.max_parallel > 32)) {
    errors.push('execution.max_parallel must be an integer between 1 and 32')
  }
  return errors
}

export function shouldSubmitRemoteRender(manifest: CognitiveStoreHandoffManifest): boolean {
  return !manifest.remoteExecutionId?.trim()
}

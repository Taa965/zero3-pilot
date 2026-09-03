import type { CreateDevelopmentGroupInput, ProductRequirementInput } from './product-service.ts'

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return normalized
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value == null) return undefined
  return text(value, label, max)
}

function stringList(value: unknown, label: string, options: { required?: boolean; maxItems?: number; maxItemLength?: number } = {}): string[] {
  if (value == null) {
    if (options.required) throw new Error(`${label} is required`)
    return []
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const maxItems = options.maxItems ?? 256
  if (value.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`)
  const items = value.map((item, index) => text(item, `${label}[${index}]`, options.maxItemLength ?? 8192))
  const unique = [...new Set(items)]
  if (options.required && unique.length === 0) throw new Error(`${label} must contain at least one item`)
  return unique
}

function ownershipPattern(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (/^(?:[A-Za-z]:\/|\/)/u.test(normalized)) throw new Error(`${label} must be repository-relative`)
  const segments = normalized.split('/')
  if (segments.includes('..')) throw new Error(`${label} must not traverse outside the repository`)
  if (segments.includes('.git') || segments.includes('.zero3')) throw new Error(`${label} overlaps a protected Zero3/Git path`)
  if (['*', '**', '**/*', '**/**'].includes(normalized)) {
    throw new Error(`${label} is too broad for isolated Development Sessions; declare a bounded file or directory glob`)
  }
  return normalized
}

function requirement(value: unknown, index: number): ProductRequirementInput {
  const input = record(value, `requirements[${index}]`)
  const pathHints = stringList(input.pathHints, `requirements[${index}].pathHints`, { required: true, maxItems: 64, maxItemLength: 2048 })
    .map((item, pathIndex) => ownershipPattern(item, `requirements[${index}].pathHints[${pathIndex}]`))
  const mandatory = input.mandatory == null ? undefined : input.mandatory
  if (mandatory != null && typeof mandatory !== 'boolean') throw new Error(`requirements[${index}].mandatory must be boolean`)
  return {
    title: text(input.title, `requirements[${index}].title`, 512),
    description: optionalText(input.description, `requirements[${index}].description`, 4096),
    acceptanceCriteria: input.acceptanceCriteria == null
      ? undefined
      : stringList(input.acceptanceCriteria, `requirements[${index}].acceptanceCriteria`, { required: true, maxItems: 64, maxItemLength: 2048 }),
    pathHints,
    tags: stringList(input.tags, `requirements[${index}].tags`, { maxItems: 64, maxItemLength: 256 }),
    dependencies: stringList(input.dependencies, `requirements[${index}].dependencies`, { maxItems: 64, maxItemLength: 256 }),
    mandatory: mandatory as boolean | undefined
  }
}

function optionalPositiveInt(value: unknown, label: string, max: number): number | undefined {
  if (value == null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`${label} must be an integer between 1 and ${max}`)
  return value as number
}

export function validateDevelopmentGroupCreateRequest(value: unknown): CreateDevelopmentGroupInput {
  const input = record(value, 'Development Group create request')
  if (!Array.isArray(input.requirements) || input.requirements.length < 1 || input.requirements.length > 200) {
    throw new Error('Development Group create request requires between 1 and 200 Requirements')
  }
  const permissionProfile = input.permissionProfile
  if (permissionProfile != null && !['read_only', 'standard', 'elevated'].includes(String(permissionProfile))) {
    throw new Error('permissionProfile must be read_only, standard, or elevated')
  }
  return {
    repositoryRoot: text(input.repositoryRoot, 'repositoryRoot', 4096),
    masterGoal: text(input.masterGoal, 'masterGoal', 16_384),
    developmentPlan: text(input.developmentPlan, 'developmentPlan', 100_000),
    requirements: input.requirements.map(requirement),
    maxParallelSessions: optionalPositiveInt(input.maxParallelSessions, 'maxParallelSessions', 12),
    maxSessionSubagents: optionalPositiveInt(input.maxSessionSubagents, 'maxSessionSubagents', 8),
    permissionProfile: permissionProfile as CreateDevelopmentGroupInput['permissionProfile']
  }
}

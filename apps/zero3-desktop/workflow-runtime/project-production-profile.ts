import fs from 'node:fs/promises'
import path from 'node:path'

import { zero3AtomicWriteFile } from '../workspace-runtime/atomic-file.ts'

export const ZERO3_PRODUCTION_PROFILE_SCHEMA = 'zero3.production-profile.v1' as const
export type ProjectProductionProfile = {
  schema: typeof ZERO3_PRODUCTION_PROFILE_SCHEMA
  projectId: string
  revision: number
  driveFolderId: string
  scriptSkill: string
  visualSkill: string
  imageBatchSize: number
  gpuHandoffRunner: string | null
  jianyingExporter: string
  updatedAt: string
}
type ProfileFile = { schemaVersion: 1; profiles: Record<string, ProjectProductionProfile> }

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
function required(value: unknown, label: string, max = 4096): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is invalid`)
  return text
}
function projectId(value: unknown): string {
  const result = required(value, 'projectId', 256)
  if (!ID_RE.test(result)) throw new Error('projectId is invalid')
  return result
}
function batchSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10) throw new Error('imageBatchSize must be an integer between 1 and 10')
  return Number(value)
}
function normalize(value: unknown): ProjectProductionProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('production profile must be an object')
  const raw = value as Record<string, unknown>
  const revision = Number(raw.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('production profile revision is invalid')
  const runner = raw.gpuHandoffRunner == null || raw.gpuHandoffRunner === '' ? null : required(raw.gpuHandoffRunner, 'gpuHandoffRunner', 32_768)
  if (runner && !path.isAbsolute(runner)) throw new Error('gpuHandoffRunner must be an absolute path')
  return {
    schema: ZERO3_PRODUCTION_PROFILE_SCHEMA,
    projectId: projectId(raw.projectId), revision,
    driveFolderId: required(raw.driveFolderId, 'driveFolderId', 2048),
    scriptSkill: required(raw.scriptSkill, 'scriptSkill', 512),
    visualSkill: required(raw.visualSkill, 'visualSkill', 512),
    imageBatchSize: batchSize(raw.imageBatchSize),
    gpuHandoffRunner: runner,
    jianyingExporter: required(raw.jianyingExporter, 'jianyingExporter', 512),
    updatedAt: required(raw.updatedAt, 'updatedAt', 128)
  }
}

export type UpsertProductionProfileInput = {
  projectId: string
  driveFolderId: string
  scriptSkill?: string
  visualSkill?: string
  imageBatchSize?: number
  gpuHandoffRunner?: string | null
  jianyingExporter?: string
}

export class ProjectProductionProfileStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}

  async get(projectIdValue: string): Promise<ProjectProductionProfile | null> {
    const state = await this.read()
    const item = state.profiles[projectId(projectIdValue)]
    return item ? structuredClone(item) : null
  }

  upsert(input: UpsertProductionProfileInput): Promise<ProjectProductionProfile> {
    return this.mutate(async () => {
      const state = await this.read()
      const id = projectId(input.projectId)
      const prior = state.profiles[id]
      const profile = normalize({
        schema: ZERO3_PRODUCTION_PROFILE_SCHEMA,
        projectId: id,
        revision: (prior?.revision ?? 0) + 1,
        driveFolderId: input.driveFolderId,
        scriptSkill: input.scriptSkill ?? prior?.scriptSkill ?? 'cognitive-store-script',
        visualSkill: input.visualSkill ?? prior?.visualSkill ?? 'cognitive-store-visual',
        imageBatchSize: input.imageBatchSize ?? prior?.imageBatchSize ?? 10,
        gpuHandoffRunner: input.gpuHandoffRunner === undefined ? prior?.gpuHandoffRunner ?? null : input.gpuHandoffRunner,
        jianyingExporter: input.jianyingExporter ?? prior?.jianyingExporter ?? 'default',
        updatedAt: new Date().toISOString()
      })
      state.profiles[id] = profile
      await zero3AtomicWriteFile(this.file, `${JSON.stringify(state, null, 2)}\n`)
      return structuredClone(profile)
    })
  }

  private async read(): Promise<ProfileFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<ProfileFile>
      if (parsed.schemaVersion !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) throw new Error('invalid production profile store')
      const profiles: Record<string, ProjectProductionProfile> = {}
      for (const [key, value] of Object.entries(parsed.profiles)) {
        const profile = normalize(value)
        if (profile.projectId !== key) throw new Error('production profile key/id mismatch')
        profiles[key] = profile
      }
      return { schemaVersion: 1, profiles }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, profiles: {} }
      throw error
    }
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  ZERO3_PROJECT_REGISTRY_SCHEMA_VERSION,
  type Zero3CreateProjectInput,
  type Zero3Project,
  type Zero3ProjectRegistryFile,
  type Zero3UpdateProjectInput
} from './project-types'

const MAX_PROJECTS = 1_000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ID = 128
const MAX_NAME = 256
const MAX_PATH = 4_096
const MAX_REF = 512
const MAX_SUMMARY = 32_000

function emptyRegistry(): Zero3ProjectRegistryFile {
  return {
    schemaVersion: ZERO3_PROJECT_REGISTRY_SCHEMA_VERSION,
    activeProjectId: null,
    projects: {}
  }
}

function projectId(value: unknown, label = 'project id'): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > MAX_ID || !/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new Error(`${label} must match [A-Za-z0-9._:-] and be at most ${MAX_ID} characters`)
  }
  return text
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return text
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === '') return null
  return requiredText(value, label, max)
}

function absolutePath(value: unknown, label: string): string {
  const text = requiredText(value, label, MAX_PATH)
  if (!path.isAbsolute(text)) throw new Error(`${label} must be an absolute path`)
  return path.normalize(text)
}

function optionalAbsolutePath(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  return absolutePath(value, label)
}

function normalizeProject(value: unknown): Zero3Project {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project must be an object')
  const raw = value as Record<string, unknown>
  return {
    id: projectId(raw.id),
    name: requiredText(raw.name, 'project name', MAX_NAME),
    repositoryPath: absolutePath(raw.repositoryPath, 'repositoryPath'),
    defaultWorktreePath: optionalAbsolutePath(raw.defaultWorktreePath, 'defaultWorktreePath'),
    defaultBranch: optionalText(raw.defaultBranch, 'defaultBranch', MAX_REF),
    baseRef: optionalText(raw.baseRef, 'baseRef', MAX_REF),
    contextSummary: optionalText(raw.contextSummary, 'contextSummary', MAX_SUMMARY),
    createdAt: requiredText(raw.createdAt, 'createdAt', 128),
    updatedAt: requiredText(raw.updatedAt, 'updatedAt', 128)
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class Zero3ProjectStore {
  private mutations: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  registryFile(): string {
    return this.file
  }

  async list(): Promise<Zero3Project[]> {
    const registry = await this.read()
    return Object.values(registry.projects)
      .map(clone)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async get(idValue: unknown): Promise<Zero3Project | null> {
    const id = projectId(idValue)
    const registry = await this.read()
    const project = registry.projects[id]
    return project ? clone(project) : null
  }

  async getActive(): Promise<Zero3Project | null> {
    const registry = await this.read()
    if (!registry.activeProjectId) return null
    const project = registry.projects[registry.activeProjectId]
    return project ? clone(project) : null
  }

  create(input: Zero3CreateProjectInput): Promise<Zero3Project> {
    return this.mutate(async () => {
      const registry = await this.read()
      const id = projectId(input.id)
      if (registry.projects[id]) throw new Error(`project ${id} already exists`)
      if (Object.keys(registry.projects).length >= MAX_PROJECTS) throw new Error('project registry limit reached')
      const timestamp = new Date().toISOString()
      const project: Zero3Project = {
        id,
        name: requiredText(input.name, 'project name', MAX_NAME),
        repositoryPath: absolutePath(input.repositoryPath, 'repositoryPath'),
        defaultWorktreePath: optionalAbsolutePath(input.defaultWorktreePath, 'defaultWorktreePath'),
        defaultBranch: optionalText(input.defaultBranch, 'defaultBranch', MAX_REF),
        baseRef: optionalText(input.baseRef, 'baseRef', MAX_REF),
        contextSummary: optionalText(input.contextSummary, 'contextSummary', MAX_SUMMARY),
        createdAt: timestamp,
        updatedAt: timestamp
      }
      registry.projects[id] = project
      if (!registry.activeProjectId) registry.activeProjectId = id
      await this.write(registry)
      return clone(project)
    })
  }

  update(input: Zero3UpdateProjectInput): Promise<Zero3Project> {
    return this.mutate(async () => {
      const registry = await this.read()
      const id = projectId(input.id)
      const current = registry.projects[id]
      if (!current) throw new Error(`project ${id} was not found`)
      const next: Zero3Project = {
        ...current,
        ...(input.name === undefined ? {} : { name: requiredText(input.name, 'project name', MAX_NAME) }),
        ...(input.repositoryPath === undefined ? {} : { repositoryPath: absolutePath(input.repositoryPath, 'repositoryPath') }),
        ...(input.defaultWorktreePath === undefined ? {} : { defaultWorktreePath: optionalAbsolutePath(input.defaultWorktreePath, 'defaultWorktreePath') }),
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: optionalText(input.defaultBranch, 'defaultBranch', MAX_REF) }),
        ...(input.baseRef === undefined ? {} : { baseRef: optionalText(input.baseRef, 'baseRef', MAX_REF) }),
        ...(input.contextSummary === undefined ? {} : { contextSummary: optionalText(input.contextSummary, 'contextSummary', MAX_SUMMARY) }),
        updatedAt: new Date().toISOString()
      }
      registry.projects[id] = next
      await this.write(registry)
      return clone(next)
    })
  }

  remove(idValue: unknown): Promise<{ removed: boolean; activeProjectId: string | null }> {
    return this.mutate(async () => {
      const registry = await this.read()
      const id = projectId(idValue)
      if (!registry.projects[id]) return { removed: false, activeProjectId: registry.activeProjectId }
      delete registry.projects[id]
      if (registry.activeProjectId === id) {
        registry.activeProjectId = Object.values(registry.projects)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null
      }
      await this.write(registry)
      return { removed: true, activeProjectId: registry.activeProjectId }
    })
  }

  setActive(idValue: unknown): Promise<Zero3Project> {
    return this.mutate(async () => {
      const registry = await this.read()
      const id = projectId(idValue)
      const project = registry.projects[id]
      if (!project) throw new Error(`project ${id} was not found`)
      registry.activeProjectId = id
      await this.write(registry)
      return clone(project)
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(operation, operation)
    this.mutations = task.then(() => undefined, () => undefined)
    return task
  }

  private async read(): Promise<Zero3ProjectRegistryFile> {
    try {
      const buffer = await fs.readFile(this.file)
      if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('project registry exceeds size limit')
      const parsed = JSON.parse(buffer.toString('utf8')) as Partial<Zero3ProjectRegistryFile>
      if (parsed.schemaVersion !== ZERO3_PROJECT_REGISTRY_SCHEMA_VERSION || !parsed.projects || typeof parsed.projects !== 'object') {
        throw new Error('invalid Zero3 project registry')
      }
      const entries = Object.entries(parsed.projects)
      if (entries.length > MAX_PROJECTS) throw new Error('project registry limit exceeded')
      const projects: Record<string, Zero3Project> = {}
      for (const [key, raw] of entries) {
        const project = normalizeProject(raw)
        if (project.id !== key) throw new Error('project registry key/id mismatch')
        projects[key] = project
      }
      const activeProjectId = parsed.activeProjectId == null ? null : projectId(parsed.activeProjectId, 'activeProjectId')
      if (activeProjectId && !projects[activeProjectId]) throw new Error('activeProjectId does not reference a stored project')
      return { schemaVersion: ZERO3_PROJECT_REGISTRY_SCHEMA_VERSION, activeProjectId, projects }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
      throw error
    }
  }

  private async write(registry: Zero3ProjectRegistryFile): Promise<void> {
    const serialized = `${JSON.stringify(registry, null, 2)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw new Error('project registry exceeds size limit')
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`
    await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, this.file)
  }
}

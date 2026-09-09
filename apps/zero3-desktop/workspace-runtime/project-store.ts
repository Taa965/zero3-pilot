import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { zero3AtomicWriteFile } from './atomic-file'
import {
  ZERO3_PROJECT_SCHEMA_VERSION,
  type Zero3CreateProjectInput,
  type Zero3Project,
  type Zero3ProjectFile,
  type Zero3UpdateProjectInput
} from './project-types'

const MAX_PROJECTS = 1_000
const MAX_ID = 256
const MAX_NAME = 512
const MAX_PATH = 32_768
const MAX_URL = 8_192

function emptyFile(): Zero3ProjectFile {
  return { schemaVersion: ZERO3_PROJECT_SCHEMA_VERSION, projects: {} }
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string or null`)
  const text = value.trim()
  if (!text || text.length > max) throw new Error(`${label} must be at most ${max} characters`)
  return text
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = optionalText(value, label, max)
  if (!text) throw new Error(`${label} is required`)
  return text
}

function chatGptProjectUrl(value: unknown): string | null {
  const raw = optionalText(value, 'project chatGptProjectUrl', MAX_URL)
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('project chatGptProjectUrl must be a valid URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('project chatGptProjectUrl must use https')
  if (parsed.username || parsed.password) throw new Error('project chatGptProjectUrl must not embed credentials')
  if (parsed.hostname !== 'chatgpt.com') throw new Error('project chatGptProjectUrl must point to chatgpt.com')
  return parsed.toString()
}

async function rootDirectory(value: unknown): Promise<string> {
  const raw = requiredText(value, 'project rootPath', MAX_PATH)
  if (!path.isAbsolute(raw)) throw new Error('project rootPath must be an absolute path')
  const resolved = path.resolve(raw)
  let stat
  try {
    stat = await fs.stat(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('project rootPath does not exist')
    throw new Error(`project rootPath is not accessible: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!stat.isDirectory()) throw new Error('project rootPath must be an existing directory')
  try {
    await fs.access(resolved, fsConstants.R_OK)
  } catch {
    throw new Error('project rootPath must be readable')
  }
  return resolved
}

function normalizeProject(value: unknown): Zero3Project {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project must be an object')
  const raw = value as Record<string, unknown>
  const rootPath = requiredText(raw.rootPath, 'project rootPath', MAX_PATH)
  if (!path.isAbsolute(rootPath)) throw new Error('persisted project rootPath must be absolute')
  return {
    id: requiredText(raw.id, 'project id', MAX_ID),
    name: requiredText(raw.name, 'project name', MAX_NAME),
    rootPath: path.resolve(rootPath),
    chatGptProjectUrl: chatGptProjectUrl(raw.chatGptProjectUrl),
    createdAt: requiredText(raw.createdAt, 'project createdAt', 128),
    lastActiveAt: requiredText(raw.lastActiveAt, 'project lastActiveAt', 128)
  }
}

export class Zero3ProjectStore {
  private mutations: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async list(): Promise<Zero3Project[]> {
    const state = await this.read()
    return Object.values(state.projects)
      .map(project => ({ ...project }))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }

  async get(id: string): Promise<Zero3Project | null> {
    const key = requiredText(id, 'project id', MAX_ID)
    const state = await this.read()
    const project = state.projects[key]
    return project ? { ...project } : null
  }

  create(input: Zero3CreateProjectInput): Promise<Zero3Project> {
    return this.mutate(async () => {
      const state = await this.read()
      if (Object.keys(state.projects).length >= MAX_PROJECTS) throw new Error('project limit reached')
      const now = new Date().toISOString()
      const project: Zero3Project = {
        id: `project-${randomUUID()}`,
        name: requiredText(input.name, 'project name', MAX_NAME),
        rootPath: await rootDirectory(input.rootPath),
        chatGptProjectUrl: null,
        createdAt: now,
        lastActiveAt: now
      }
      state.projects[project.id] = project
      await this.write(state)
      return { ...project }
    })
  }

  update(input: Zero3UpdateProjectInput): Promise<Zero3Project> {
    return this.mutate(async () => {
      const id = requiredText(input.id, 'project id', MAX_ID)
      const state = await this.read()
      const existing = state.projects[id]
      if (!existing) throw new Error('project was not found')
      const next: Zero3Project = {
        ...existing,
        name: input.name === undefined ? existing.name : requiredText(input.name, 'project name', MAX_NAME),
        chatGptProjectUrl:
          input.chatGptProjectUrl === undefined ? existing.chatGptProjectUrl : chatGptProjectUrl(input.chatGptProjectUrl),
        lastActiveAt: new Date().toISOString()
      }
      state.projects[id] = next
      await this.write(state)
      return { ...next }
    })
  }

  remove(id: string): Promise<{ removed: boolean }> {
    return this.mutate(async () => {
      const key = requiredText(id, 'project id', MAX_ID)
      const state = await this.read()
      if (!state.projects[key]) return { removed: false }
      delete state.projects[key]
      await this.write(state)
      return { removed: true }
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(operation, operation)
    this.mutations = task.then(() => undefined, () => undefined)
    return task
  }

  private async read(): Promise<Zero3ProjectFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<Zero3ProjectFile>
      if (parsed.schemaVersion !== ZERO3_PROJECT_SCHEMA_VERSION || !parsed.projects || typeof parsed.projects !== 'object') {
        throw new Error('invalid Zero3 project state')
      }
      const rawProjects = Object.entries(parsed.projects)
      if (rawProjects.length > MAX_PROJECTS) throw new Error('Zero3 project state exceeds the supported limit')
      const projects: Record<string, Zero3Project> = {}
      for (const [key, value] of rawProjects) {
        const project = normalizeProject(value)
        if (project.id !== key) throw new Error('Zero3 project key/id mismatch')
        projects[key] = project
      }
      return { schemaVersion: ZERO3_PROJECT_SCHEMA_VERSION, projects }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
      throw error
    }
  }

  private async write(state: Zero3ProjectFile): Promise<void> {
    await zero3AtomicWriteFile(this.file, `${JSON.stringify(state, null, 2)}\n`)
  }
}

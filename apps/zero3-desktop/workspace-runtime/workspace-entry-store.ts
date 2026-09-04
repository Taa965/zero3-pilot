import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  ZERO3_GEMINI_WEB_HOME,
  ZERO3_GEMINI_WEB_PROFILE_ID,
  ZERO3_GPT_WEB_HOME,
  ZERO3_GPT_WEB_PROFILE_ID,
  ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION,
  type Zero3CreateGeminiWebEntryInput,
  type Zero3CreateGptWebEntryInput,
  type Zero3GeminiWebWorkspaceEntry,
  type Zero3GptWebWorkspaceEntry,
  type Zero3RenameWorkspaceEntryInput,
  type Zero3ResolveGeminiWebNavigationResult,
  type Zero3ResolveGptWebNavigationResult,
  type Zero3SetWorkspaceProjectInput,
  type Zero3UpdateGeminiWebNavigationInput,
  type Zero3UpdateGptWebNavigationInput,
  type Zero3WorkspaceEntry,
  type Zero3WorkspaceEntryFile
} from './workspace-entry-types'

const MAX_ENTRIES = 5_000
const MAX_ID = 256
const MAX_PROJECT_ID = 512
const MAX_URL = 8_192
const MAX_TITLE = 512

function emptyFile(): Zero3WorkspaceEntryFile {
  return { schemaVersion: ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION, entries: {} }
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

function safeHttpsUrl(value: unknown, label: string): string {
  const raw = requiredText(value, label, MAX_URL)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use https`)
  if (parsed.username || parsed.password) throw new Error(`${label} must not embed credentials`)
  return parsed.toString()
}

function commonEntry(raw: Record<string, unknown>) {
  return {
    id: requiredText(raw.id, 'workspace entry id', MAX_ID),
    projectId: optionalText(raw.projectId, 'workspace entry projectId', MAX_PROJECT_ID),
    browserProfileId: requiredText(raw.browserProfileId, 'workspace entry browserProfileId', 128),
    conversationUrl: raw.conversationUrl == null ? null : safeHttpsUrl(raw.conversationUrl, 'workspace entry conversationUrl'),
    currentUrl: safeHttpsUrl(raw.currentUrl, 'workspace entry currentUrl'),
    pageTitle: optionalText(raw.pageTitle, 'workspace entry pageTitle', MAX_TITLE),
    localDisplayTitle: optionalText(raw.localDisplayTitle, 'workspace entry localDisplayTitle', MAX_TITLE),
    createdAt: requiredText(raw.createdAt, 'workspace entry createdAt', 128),
    lastActiveAt: requiredText(raw.lastActiveAt, 'workspace entry lastActiveAt', 128)
  }
}

function normalizeEntry(value: unknown): Zero3WorkspaceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workspace entry must be an object')
  const raw = value as Record<string, unknown>
  if (raw.kind === 'gpt_web') return { ...commonEntry(raw), kind: 'gpt_web' }
  if (raw.kind === 'gemini_web') {
    return {
      ...commonEntry(raw),
      kind: 'gemini_web',
      logicalSessionId: requiredText(raw.logicalSessionId, 'workspace entry logicalSessionId', MAX_ID)
    }
  }
  throw new Error('unsupported workspace entry kind')
}

export class Zero3WorkspaceEntryStore {
  private mutations: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async list(): Promise<Zero3WorkspaceEntry[]> {
    const state = await this.read()
    return Object.values(state.entries)
      .map(entry => ({ ...entry }))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }

  async get(id: string): Promise<Zero3WorkspaceEntry | null> {
    const key = requiredText(id, 'workspace entry id', MAX_ID)
    const state = await this.read()
    const entry = state.entries[key]
    return entry ? { ...entry } : null
  }

  createGptWeb(input: Zero3CreateGptWebEntryInput = {}): Promise<Zero3GptWebWorkspaceEntry> {
    return this.mutate(async () => {
      const state = await this.read()
      this.assertCapacity(state)
      const now = new Date().toISOString()
      const entry: Zero3GptWebWorkspaceEntry = {
        id: `gpt-web-${randomUUID()}`,
        kind: 'gpt_web',
        projectId: optionalText(input.projectId, 'projectId', MAX_PROJECT_ID),
        browserProfileId: ZERO3_GPT_WEB_PROFILE_ID,
        conversationUrl: null,
        currentUrl: ZERO3_GPT_WEB_HOME,
        pageTitle: null,
        localDisplayTitle: null,
        createdAt: now,
        lastActiveAt: now
      }
      state.entries[entry.id] = entry
      await this.write(state)
      return { ...entry }
    })
  }

  createGeminiWeb(input: Zero3CreateGeminiWebEntryInput = {}): Promise<Zero3GeminiWebWorkspaceEntry> {
    return this.mutate(async () => {
      const state = await this.read()
      this.assertCapacity(state)
      const now = new Date().toISOString()
      const logicalSessionId = optionalText(input.logicalSessionId, 'logicalSessionId', MAX_ID) ?? `gemini-${randomUUID()}`
      const entry: Zero3GeminiWebWorkspaceEntry = {
        id: `gemini-web-${randomUUID()}`,
        kind: 'gemini_web',
        logicalSessionId,
        projectId: optionalText(input.projectId, 'projectId', MAX_PROJECT_ID),
        browserProfileId: ZERO3_GEMINI_WEB_PROFILE_ID,
        conversationUrl: null,
        currentUrl: ZERO3_GEMINI_WEB_HOME,
        pageTitle: null,
        localDisplayTitle: null,
        createdAt: now,
        lastActiveAt: now
      }
      state.entries[entry.id] = entry
      await this.write(state)
      return { ...entry }
    })
  }

  updateGptWebNavigation(input: Zero3UpdateGptWebNavigationInput): Promise<Zero3GptWebWorkspaceEntry> {
    return this.updateNavigation('gpt_web', input) as Promise<Zero3GptWebWorkspaceEntry>
  }

  updateGeminiWebNavigation(input: Zero3UpdateGeminiWebNavigationInput): Promise<Zero3GeminiWebWorkspaceEntry> {
    return this.updateNavigation('gemini_web', input) as Promise<Zero3GeminiWebWorkspaceEntry>
  }

  resolveGptWebNavigation(input: Zero3UpdateGptWebNavigationInput): Promise<Zero3ResolveGptWebNavigationResult> {
    return this.resolveNavigation('gpt_web', input) as Promise<Zero3ResolveGptWebNavigationResult>
  }

  resolveGeminiWebNavigation(input: Zero3UpdateGeminiWebNavigationInput): Promise<Zero3ResolveGeminiWebNavigationResult> {
    return this.resolveNavigation('gemini_web', input) as Promise<Zero3ResolveGeminiWebNavigationResult>
  }

  rename(input: Zero3RenameWorkspaceEntryInput): Promise<Zero3WorkspaceEntry> {
    return this.mutate(async () => {
      const id = requiredText(input.id, 'workspace entry id', MAX_ID)
      const state = await this.read()
      const existing = state.entries[id]
      if (!existing) throw new Error('workspace entry was not found')
      const next = {
        ...existing,
        localDisplayTitle: optionalText(input.title, 'title', MAX_TITLE),
        lastActiveAt: new Date().toISOString()
      } as Zero3WorkspaceEntry
      state.entries[id] = next
      await this.write(state)
      return { ...next }
    })
  }

  setProject(input: Zero3SetWorkspaceProjectInput): Promise<Zero3WorkspaceEntry> {
    return this.mutate(async () => {
      const id = requiredText(input.id, 'workspace entry id', MAX_ID)
      const state = await this.read()
      const existing = state.entries[id]
      if (!existing) throw new Error('workspace entry was not found')
      const next = {
        ...existing,
        projectId: optionalText(input.projectId, 'projectId', MAX_PROJECT_ID),
        lastActiveAt: new Date().toISOString()
      } as Zero3WorkspaceEntry
      state.entries[id] = next
      await this.write(state)
      return { ...next }
    })
  }

  remove(id: string): Promise<{ removed: boolean }> {
    return this.mutate(async () => {
      const key = requiredText(id, 'workspace entry id', MAX_ID)
      const state = await this.read()
      const removed = Boolean(state.entries[key])
      if (!removed) return { removed: false }
      delete state.entries[key]
      await this.write(state)
      return { removed: true }
    })
  }

  private updateNavigation(kind: 'gpt_web' | 'gemini_web', input: Zero3UpdateGptWebNavigationInput): Promise<Zero3WorkspaceEntry> {
    return this.mutate(async () => {
      const id = requiredText(input.id, 'workspace entry id', MAX_ID)
      const state = await this.read()
      const existing = state.entries[id]
      if (!existing || existing.kind !== kind) throw new Error(`${kind} workspace entry was not found`)
      const next = {
        ...existing,
        currentUrl: safeHttpsUrl(input.currentUrl, 'currentUrl'),
        conversationUrl:
          input.conversationUrl === undefined
            ? existing.conversationUrl
            : input.conversationUrl == null
              ? null
              : safeHttpsUrl(input.conversationUrl, 'conversationUrl'),
        pageTitle: input.pageTitle === undefined ? existing.pageTitle : optionalText(input.pageTitle, 'pageTitle', MAX_TITLE),
        lastActiveAt: new Date().toISOString()
      } as Zero3WorkspaceEntry
      state.entries[id] = next
      await this.write(state)
      return { ...next }
    })
  }

  private resolveNavigation(
    kind: 'gpt_web' | 'gemini_web',
    input: Zero3UpdateGptWebNavigationInput
  ): Promise<{ entry: Zero3WorkspaceEntry; previousEntryId: string | null }> {
    return this.mutate(async () => {
      const id = requiredText(input.id, 'workspace entry id', MAX_ID)
      const state = await this.read()
      const source = state.entries[id]
      if (!source || source.kind !== kind) throw new Error(`${kind} workspace entry was not found`)

      const currentUrl = safeHttpsUrl(input.currentUrl, 'currentUrl')
      const conversationUrl =
        input.conversationUrl === undefined
          ? source.conversationUrl
          : input.conversationUrl == null
            ? null
            : safeHttpsUrl(input.conversationUrl, 'conversationUrl')
      const pageTitle = input.pageTitle === undefined ? source.pageTitle : optionalText(input.pageTitle, 'pageTitle', MAX_TITLE)
      const now = new Date().toISOString()

      if (conversationUrl && source.conversationUrl && conversationUrl !== source.conversationUrl) {
        const existingTarget = Object.values(state.entries).find(entry =>
          entry.kind === kind &&
          entry.id !== source.id &&
          entry.browserProfileId === source.browserProfileId &&
          entry.projectId === source.projectId &&
          entry.conversationUrl === conversationUrl
        )

        let target: Zero3WorkspaceEntry
        if (existingTarget) {
          target = {
            ...existingTarget,
            currentUrl,
            pageTitle: pageTitle ?? existingTarget.pageTitle,
            lastActiveAt: now
          } as Zero3WorkspaceEntry
        } else {
          this.assertCapacity(state)
          if (kind === 'gpt_web') {
            target = {
              id: `gpt-web-${randomUUID()}`,
              kind,
              projectId: source.projectId,
              browserProfileId: source.browserProfileId,
              conversationUrl,
              currentUrl,
              pageTitle,
              localDisplayTitle: null,
              createdAt: now,
              lastActiveAt: now
            }
          } else {
            target = {
              id: `gemini-web-${randomUUID()}`,
              kind,
              logicalSessionId: `gemini-${randomUUID()}`,
              projectId: source.projectId,
              browserProfileId: source.browserProfileId,
              conversationUrl,
              currentUrl,
              pageTitle,
              localDisplayTitle: null,
              createdAt: now,
              lastActiveAt: now
            }
          }
        }
        state.entries[target.id] = target
        await this.write(state)
        return { entry: { ...target }, previousEntryId: source.id }
      }

      const next = {
        ...source,
        currentUrl,
        conversationUrl,
        pageTitle,
        lastActiveAt: now
      } as Zero3WorkspaceEntry
      state.entries[id] = next
      await this.write(state)
      return { entry: { ...next }, previousEntryId: null }
    })
  }

  private assertCapacity(state: Zero3WorkspaceEntryFile): void {
    if (Object.keys(state.entries).length >= MAX_ENTRIES) throw new Error('workspace entry limit reached')
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(operation, operation)
    this.mutations = task.then(() => undefined, () => undefined)
    return task
  }

  private async read(): Promise<Zero3WorkspaceEntryFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<Zero3WorkspaceEntryFile>
      if (parsed.schemaVersion !== ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
        throw new Error('invalid Zero3 workspace entry state')
      }
      const entries: Record<string, Zero3WorkspaceEntry> = {}
      const rawEntries = Object.entries(parsed.entries)
      if (rawEntries.length > MAX_ENTRIES) throw new Error('Zero3 workspace entry state exceeds the supported limit')
      for (const [key, value] of rawEntries) {
        const entry = normalizeEntry(value)
        if (entry.id !== key) throw new Error('Zero3 workspace entry key/id mismatch')
        entries[key] = entry
      }
      return { schemaVersion: ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION, entries }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
      throw error
    }
  }

  private async write(state: Zero3WorkspaceEntryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, this.file)
  }
}

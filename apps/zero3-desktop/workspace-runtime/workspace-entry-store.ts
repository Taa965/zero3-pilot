import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  ZERO3_GPT_WEB_HOME,
  ZERO3_GPT_WEB_PROFILE_ID,
  ZERO3_WORKSPACE_ENTRY_SCHEMA_VERSION,
  type Zero3CreateGptWebEntryInput,
  type Zero3GptWebWorkspaceEntry,
  type Zero3RenameWorkspaceEntryInput,
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

function normalizeEntry(value: unknown): Zero3WorkspaceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workspace entry must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'gpt_web') throw new Error('unsupported workspace entry kind')

  const id = requiredText(raw.id, 'workspace entry id', MAX_ID)
  const createdAt = requiredText(raw.createdAt, 'workspace entry createdAt', 128)
  const lastActiveAt = requiredText(raw.lastActiveAt, 'workspace entry lastActiveAt', 128)
  const currentUrl = safeHttpsUrl(raw.currentUrl, 'workspace entry currentUrl')
  const conversationUrl = raw.conversationUrl == null ? null : safeHttpsUrl(raw.conversationUrl, 'workspace entry conversationUrl')
  const browserProfileId = requiredText(raw.browserProfileId, 'workspace entry browserProfileId', 128)

  return {
    id,
    kind: 'gpt_web',
    projectId: optionalText(raw.projectId, 'workspace entry projectId', MAX_PROJECT_ID),
    browserProfileId,
    conversationUrl,
    currentUrl,
    pageTitle: optionalText(raw.pageTitle, 'workspace entry pageTitle', MAX_TITLE),
    localDisplayTitle: optionalText(raw.localDisplayTitle, 'workspace entry localDisplayTitle', MAX_TITLE),
    createdAt,
    lastActiveAt
  }
}

export class Zero3WorkspaceEntryStore {
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

  async createGptWeb(input: Zero3CreateGptWebEntryInput = {}): Promise<Zero3GptWebWorkspaceEntry> {
    const state = await this.read()
    if (Object.keys(state.entries).length >= MAX_ENTRIES) throw new Error('workspace entry limit reached')

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
  }

  async updateGptWebNavigation(input: Zero3UpdateGptWebNavigationInput): Promise<Zero3GptWebWorkspaceEntry> {
    const id = requiredText(input.id, 'workspace entry id', MAX_ID)
    const state = await this.read()
    const existing = state.entries[id]
    if (!existing || existing.kind !== 'gpt_web') throw new Error('GPT Web workspace entry was not found')

    const next: Zero3GptWebWorkspaceEntry = {
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
    }
    state.entries[id] = next
    await this.write(state)
    return { ...next }
  }

  async rename(input: Zero3RenameWorkspaceEntryInput): Promise<Zero3WorkspaceEntry> {
    const id = requiredText(input.id, 'workspace entry id', MAX_ID)
    const state = await this.read()
    const existing = state.entries[id]
    if (!existing) throw new Error('workspace entry was not found')

    const next: Zero3WorkspaceEntry = {
      ...existing,
      localDisplayTitle: optionalText(input.title, 'title', MAX_TITLE),
      lastActiveAt: new Date().toISOString()
    }
    state.entries[id] = next
    await this.write(state)
    return { ...next }
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    const key = requiredText(id, 'workspace entry id', MAX_ID)
    const state = await this.read()
    const removed = Boolean(state.entries[key])
    if (!removed) return { removed: false }
    delete state.entries[key]
    await this.write(state)
    return { removed: true }
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
    const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, this.file)
  }
}

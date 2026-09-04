import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  shell,
  type Session
} from 'electron'

import type { Zero3WorkspaceEntryStore } from '../workspace/workspace-entry-store'
import type { Zero3GptWebWorkspaceEntry } from '../workspace/workspace-entry-types'
import {
  ZERO3_GPT_WEB_MAX_LIVE_VIEWS,
  ZERO3_GPT_WEB_PARTITION,
  type Zero3GptWebBounds,
  type Zero3GptWebEvent
} from './gpt-web-types'

type LiveGptWebView = {
  entryId: string
  view: WebContentsView
  parentWindowId: number | null
  lastUsedAt: number
}

type EventSink = (event: Zero3GptWebEvent) => void

const MAX_URL = 8_192
const MAX_ENTRY_ID = 256
const MAX_BOUND = 16_384
const CHATGPT_HOST = 'chatgpt.com'
const GENERIC_TITLES = new Set(['ChatGPT', 'New chat', '新聊天', '新对话'])

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return text
}

function safeHttpsUrl(value: unknown, label: string): URL {
  const raw = requiredText(value, label, MAX_URL)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use https`)
  if (parsed.username || parsed.password) throw new Error(`${label} must not embed credentials`)
  return parsed
}

function chatGptNavigationUrl(value: unknown): string {
  const parsed = safeHttpsUrl(value, 'GPT Web URL')
  if (parsed.hostname.toLowerCase() !== CHATGPT_HOST) {
    throw new Error('direct GPT Web navigation is limited to chatgpt.com')
  }
  return parsed.toString()
}

function observedHttpsUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function canonicalConversationUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== CHATGPT_HOST) return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    const conversationMarker = segments.lastIndexOf('c')
    if (conversationMarker < 0 || conversationMarker >= segments.length - 1) return null
    const conversationId = segments[conversationMarker + 1]?.trim()
    if (!conversationId || conversationId.length > 512) return null
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function normalizedTitle(value: string): string | null {
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title || title.length > 512 || GENERIC_TITLES.has(title)) return null
  return title
}

function integerBound(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > MAX_BOUND) {
    throw new Error(`${label} must be an integer between ${minimum} and ${MAX_BOUND}`)
  }
  return value
}

function normalizeBounds(value: unknown): Zero3GptWebBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GPT Web bounds must be an object')
  const raw = value as Record<string, unknown>
  return {
    x: integerBound(raw.x, 'bounds.x', 0),
    y: integerBound(raw.y, 'bounds.y', 0),
    width: integerBound(raw.width, 'bounds.width', 1),
    height: integerBound(raw.height, 'bounds.height', 1)
  }
}

export class Zero3GptWebProvider {
  private readonly live = new Map<string, LiveGptWebView>()
  private readonly profileSession: Session
  private persistenceTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly entries: Zero3WorkspaceEntryStore,
    private readonly emitEvent: EventSink
  ) {
    this.profileSession = electronSession.fromPartition(ZERO3_GPT_WEB_PARTITION, { cache: true })
    this.profileSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    this.profileSession.setPermissionCheckHandler(() => false)
  }

  async create(projectId?: string | null): Promise<Zero3GptWebWorkspaceEntry> {
    const entry = await this.entries.createGptWeb({ projectId: projectId ?? null })
    this.emitEvent({ kind: 'state', entryId: entry.id, state: 'created' })
    return entry
  }

  async show(parent: BrowserWindow, input: { id: string; bounds: unknown }): Promise<Zero3GptWebWorkspaceEntry> {
    if (parent.isDestroyed()) throw new Error('GPT Web parent window is unavailable')
    const id = requiredText(input.id, 'workspace entry id', MAX_ENTRY_ID)
    const bounds = normalizeBounds(input.bounds)
    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)

    this.detachFromParent(live)
    this.hideOtherViewsInWindow(parent.id, id)
    parent.contentView.addChildView(live.view)
    live.view.setBounds(bounds)
    live.parentWindowId = parent.id
    live.lastUsedAt = Date.now()
    live.view.webContents.focus()
    this.bump(id)
    this.emitEvent({ kind: 'state', entryId: id, state: 'shown' })
    return (await this.entries.get(id)) as Zero3GptWebWorkspaceEntry
  }

  async hide(idValue: unknown): Promise<{ hidden: boolean }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const live = this.live.get(id)
    if (!live) return { hidden: false }
    this.detachFromParent(live)
    live.lastUsedAt = Date.now()
    this.emitEvent({ kind: 'state', entryId: id, state: 'hidden' })
    return { hidden: true }
  }

  async setBounds(idValue: unknown, boundsValue: unknown): Promise<{ ok: true }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const live = this.live.get(id)
    if (!live) throw new Error('GPT Web view is not live')
    live.view.setBounds(normalizeBounds(boundsValue))
    live.lastUsedAt = Date.now()
    this.bump(id)
    return { ok: true }
  }

  async navigate(idValue: unknown, urlValue: unknown): Promise<{ url: string }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const entry = await this.requireEntry(id)
    const url = chatGptNavigationUrl(urlValue)
    const live = await this.ensureLive(entry)
    await live.view.webContents.loadURL(url)
    live.lastUsedAt = Date.now()
    this.bump(id)
    return { url: live.view.webContents.getURL() || url }
  }

  async reload(idValue: unknown): Promise<{ ok: true }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)
    live.view.webContents.reload()
    live.lastUsedAt = Date.now()
    this.bump(id)
    return { ok: true }
  }

  async suspend(idValue: unknown): Promise<{ suspended: boolean }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const live = this.live.get(id)
    if (!live) return { suspended: false }
    this.destroyLive(id, 'suspended')
    return { suspended: true }
  }

  async remove(idValue: unknown): Promise<{ removed: boolean }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    this.destroyLive(id, 'suspended')
    return this.entries.remove(id)
  }

  async openExternal(idValue: unknown): Promise<{ opened: boolean }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const entry = await this.requireEntry(id)
    const target = entry.conversationUrl ?? entry.currentUrl
    const parsed = safeHttpsUrl(target, 'GPT Web external URL')
    await shell.openExternal(parsed.toString())
    return { opened: true }
  }

  stop(): void {
    for (const id of [...this.live.keys()]) this.destroyLive(id, 'suspended')
  }

  private async requireEntry(id: string): Promise<Zero3GptWebWorkspaceEntry> {
    const entry = await this.entries.get(id)
    if (!entry || entry.kind !== 'gpt_web') throw new Error('GPT Web workspace entry was not found')
    return entry
  }

  private async ensureLive(entry: Zero3GptWebWorkspaceEntry): Promise<LiveGptWebView> {
    const existing = this.live.get(entry.id)
    if (existing && !existing.view.webContents.isDestroyed()) {
      existing.lastUsedAt = Date.now()
      this.bump(entry.id)
      return existing
    }
    if (existing) this.live.delete(entry.id)

    const view = new WebContentsView({
      webPreferences: {
        session: this.profileSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true
      }
    })
    const live: LiveGptWebView = {
      entryId: entry.id,
      view,
      parentWindowId: null,
      lastUsedAt: Date.now()
    }
    this.live.set(entry.id, live)
    this.installViewGuards(live)
    this.installViewObservers(live)
    this.bump(entry.id)
    this.evictIfNeeded(entry.id)

    const target = chatGptNavigationUrl(entry.conversationUrl ?? entry.currentUrl)
    this.emitEvent({ kind: 'state', entryId: entry.id, state: 'loading' })
    try {
      await view.webContents.loadURL(target)
    } catch (error) {
      if (!view.webContents.isDestroyed()) {
        this.emitEvent({
          kind: 'state',
          entryId: entry.id,
          state: 'error',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }
    return live
  }

  private installViewGuards(live: LiveGptWebView): void {
    const contents = live.view.webContents
    contents.on('will-navigate', (event, url) => {
      if (observedHttpsUrl(url)) return
      event.preventDefault()
      this.emitEvent({ kind: 'state', entryId: live.entryId, state: 'error', detail: 'Blocked non-HTTPS navigation' })
    })

    contents.setWindowOpenHandler(details => {
      const target = observedHttpsUrl(details.url)
      if (!target) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960,
          height: 760,
          show: true,
          webPreferences: {
            session: this.profileSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
          }
        }
      }
    })
  }

  private installViewObservers(live: LiveGptWebView): void {
    const contents = live.view.webContents
    const observe = () => {
      const currentUrl = observedHttpsUrl(contents.getURL())
      if (!currentUrl) return
      this.queueObservedState(live.entryId, currentUrl, contents.getTitle())
    }

    contents.on('did-navigate', observe)
    contents.on('did-navigate-in-page', observe)
    contents.on('page-title-updated', () => observe())
    contents.on('did-start-loading', () => {
      this.emitEvent({ kind: 'state', entryId: live.entryId, state: 'loading' })
    })
    contents.on('did-stop-loading', () => {
      observe()
      this.emitEvent({ kind: 'state', entryId: live.entryId, state: 'ready' })
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.emitEvent({
        kind: 'state',
        entryId: live.entryId,
        state: 'error',
        detail: `${errorDescription} (${errorCode}) ${validatedUrl}`.slice(0, 2_000)
      })
    })
    contents.on('render-process-gone', (_event, details) => {
      this.emitEvent({
        kind: 'state',
        entryId: live.entryId,
        state: 'error',
        detail: `ChatGPT Web renderer exited: ${details.reason}`
      })
      this.detachFromParent(live)
      this.live.delete(live.entryId)
    })
    contents.on('destroyed', () => {
      const current = this.live.get(live.entryId)
      if (current?.view === live.view) this.live.delete(live.entryId)
    })
  }

  private queueObservedState(entryId: string, currentUrl: string, title: string): void {
    const conversationUrl = canonicalConversationUrl(currentUrl)
    const pageTitle = normalizedTitle(title)
    this.persistenceTail = this.persistenceTail
      .then(async () => {
        const updated = await this.entries.updateGptWebNavigation({
          id: entryId,
          currentUrl,
          ...(conversationUrl ? { conversationUrl } : {}),
          pageTitle
        })
        this.emitEvent({
          kind: 'navigation',
          entryId,
          currentUrl: updated.currentUrl,
          conversationUrl: updated.conversationUrl,
          pageTitle: updated.pageTitle
        })
      })
      .catch(error => {
        this.emitEvent({
          kind: 'state',
          entryId,
          state: 'error',
          detail: error instanceof Error ? error.message : String(error)
        })
      })
  }

  private detachFromParent(live: LiveGptWebView): void {
    const parentId = live.parentWindowId
    live.parentWindowId = null
    if (parentId == null) return
    const parent = BrowserWindow.fromId(parentId)
    if (!parent || parent.isDestroyed()) return
    try {
      parent.contentView.removeChildView(live.view)
    } catch {
      // Parent/view teardown may race with a native window close. The binding
      // remains durable and can be restored into a fresh WebContentsView.
    }
  }

  private hideOtherViewsInWindow(windowId: number, exceptEntryId: string): void {
    for (const live of this.live.values()) {
      if (live.entryId !== exceptEntryId && live.parentWindowId === windowId) {
        this.detachFromParent(live)
        this.emitEvent({ kind: 'state', entryId: live.entryId, state: 'hidden' })
      }
    }
  }

  private bump(entryId: string): void {
    const live = this.live.get(entryId)
    if (!live) return
    this.live.delete(entryId)
    this.live.set(entryId, live)
  }

  private evictIfNeeded(currentEntryId: string): void {
    while (this.live.size > ZERO3_GPT_WEB_MAX_LIVE_VIEWS) {
      const candidate = [...this.live.keys()].find(id => id !== currentEntryId)
      if (!candidate) return
      this.destroyLive(candidate, 'suspended')
    }
  }

  private destroyLive(entryId: string, state: 'suspended'): void {
    const live = this.live.get(entryId)
    if (!live) return
    this.live.delete(entryId)
    this.detachFromParent(live)
    if (!live.view.webContents.isDestroyed()) live.view.webContents.close({ waitForBeforeUnload: false })
    this.emitEvent({ kind: 'state', entryId, state })
  }
}

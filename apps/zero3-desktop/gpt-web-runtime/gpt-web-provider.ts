import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  shell,
  type Session,
  type WebContents
} from 'electron'

import type { Zero3ProjectStore } from '../workspace/project-store'
import type { Zero3WorkspaceEntryStore } from '../workspace/workspace-entry-store'
import {
  ZERO3_GPT_WEB_HOME,
  ZERO3_GPT_WEB_PROFILE_ID,
  type Zero3GptWebWorkspaceEntry
} from '../workspace/workspace-entry-types'
import { readChatGptProjectCatalog } from './chatgpt-project-catalog'
import {
  ZERO3_GPT_WEB_MAX_LIVE_VIEWS,
  ZERO3_GPT_WEB_PARTITION,
  type Zero3ChatGptRemoteProject,
  type Zero3GptWebBounds,
  type Zero3GptWebEvent
} from './gpt-web-types'

type LiveGptWebView = {
  entryId: string
  view: WebContentsView
  parentWindowId: number | null
  lastUsedAt: number
  chromeHidden: boolean
  chromeCssKey: string | null
}

type EventSink = (event: Zero3GptWebEvent) => void

const MAX_URL = 8_192
const MAX_ENTRY_ID = 256
const MAX_BOUND = 16_384
const CHATGPT_HOST = 'chatgpt.com'
// ChatGPT ships its own conversation rail. Zero3's second column already lists
// these sessions, so leaving it visible puts two navigation surfaces side by
// side. The tiny collapsed rail is a descendant of the same element, so one
// selector covers both states. These ids belong to chatgpt.com and can vanish
// on any redeploy: insertCSS does not fail on a selector that matches nothing,
// so a rename makes the rail reappear rather than breaking the view -- which is
// why the renderer keeps a toggle for reaching ChatGPT's own history.
const CHATGPT_CHROME_CSS = '#stage-slideover-sidebar{display:none !important}'
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

function resumeChatGptUrl(entry: Zero3GptWebWorkspaceEntry): string {
  for (const candidate of [entry.conversationUrl, entry.currentUrl]) {
    if (!candidate) continue
    try {
      return chatGptNavigationUrl(candidate)
    } catch {
      // OAuth/login navigation is intentionally not persisted. Authentication
      // state itself remains inside the persistent Electron partition.
    }
  }
  return ZERO3_GPT_WEB_HOME
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

function observedChatGptUrl(value: string): string | null {
  const normalized = observedHttpsUrl(value)
  if (!normalized) return null
  try {
    return new URL(normalized).hostname.toLowerCase() === CHATGPT_HOST ? normalized : null
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

// The renderer measures its host element with getBoundingClientRect, which
// reports CSS pixels, while WebContentsView.setBounds takes device-independent
// pixels relative to the window's content view. Those units only coincide at
// zoom factor 1, and the desktop ships a 90% default zoom -- so an unconverted
// rect makes the ChatGPT view ~11% too large and offset down-right, pushing its
// composer past the window edge. Deriving the factor per call also means a
// Ctrl+/- zoom change corrects itself on the next bounds sync.
function toDeviceIndependentBounds(bounds: Zero3GptWebBounds, zoomFactor: number): Zero3GptWebBounds {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  if (scale === 1) return bounds
  return {
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale))
  }
}

function windowZoomFactor(window: BrowserWindow | null): number {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return 1
  return window.webContents.getZoomFactor()
}

export class Zero3GptWebProvider {
  private readonly live = new Map<string, LiveGptWebView>()
  private profileSession: Session | null = null
  private persistenceTail: Promise<void> = Promise.resolve()
  private catalogTail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly entries: Zero3WorkspaceEntryStore,
    private readonly projects: Zero3ProjectStore,
    private readonly emitEvent: EventSink
  ) {}

  async create(projectId?: string | null): Promise<Zero3GptWebWorkspaceEntry> {
    const scope = projectId ?? null
    const entry = await this.entries.createGptWeb({
      projectId: scope,
      homeUrl: await this.boundProjectUrl(scope)
    })
    this.emitEvent({ kind: 'state', entryId: entry.id, state: 'created' })
    return entry
  }

  /**
   * Lists the projects on chatgpt.com so a Zero3 project can be bound to one.
   * Serialised because each miss opens a page: two pickers racing would load
   * chatgpt.com twice for the same answer.
   */
  listRemoteProjects(): Promise<Zero3ChatGptRemoteProject[]> {
    const task = this.catalogTail.then(
      () => readChatGptProjectCatalog(this.getProfileSession(), this.reusableContents()),
      () => readChatGptProjectCatalog(this.getProfileSession(), this.reusableContents())
    )
    this.catalogTail = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  // A view the user already has open is signed in and warm, so the catalog can
  // be read through it instead of paying for another chatgpt.com load.
  private reusableContents(): WebContents | null {
    for (const live of this.live.values()) {
      const contents = live.view.webContents
      if (!contents.isDestroyed() && observedChatGptUrl(contents.getURL())) return contents
    }
    return null
  }

  // A Zero3 project bound to a ChatGPT project opens new sessions on that
  // project's page. A stored URL that no longer parses as a chatgpt.com address
  // is ignored rather than fatal: the session still opens, just unfiled.
  private async boundProjectUrl(projectId: string | null): Promise<string | null> {
    if (!projectId) return null
    const project = await this.projects.get(projectId).catch(() => null)
    if (!project?.chatGptProjectUrl) return null
    try {
      return chatGptNavigationUrl(project.chatGptProjectUrl)
    } catch {
      return null
    }
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
    live.view.setBounds(toDeviceIndependentBounds(bounds, windowZoomFactor(parent)))
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

  private async applyChromeSuppression(live: LiveGptWebView): Promise<void> {
    const contents = live.view.webContents
    if (contents.isDestroyed() || live.chromeCssKey) return
    try {
      live.chromeCssKey = await contents.insertCSS(CHATGPT_CHROME_CSS)
    } catch {
      // A destroyed or navigating view is the only realistic failure here, and
      // the rail staying visible is not worth surfacing as a session error.
      live.chromeCssKey = null
    }
  }

  // Hiding ChatGPT's own rail costs access to the history it lists, so the
  // renderer can bring it back on demand for the session's lifetime.
  async setChromeVisible(idValue: unknown, visibleValue: unknown): Promise<{ visible: boolean }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    if (typeof visibleValue !== 'boolean') throw new Error('visible must be a boolean')
    const live = this.live.get(id)
    if (!live) throw new Error('GPT Web view is not live')

    live.chromeHidden = !visibleValue
    const contents = live.view.webContents
    if (visibleValue) {
      if (live.chromeCssKey && !contents.isDestroyed()) {
        await contents.removeInsertedCSS(live.chromeCssKey).catch(() => {})
      }
      live.chromeCssKey = null
    } else {
      await this.applyChromeSuppression(live)
    }
    return { visible: visibleValue }
  }

  async setBounds(idValue: unknown, boundsValue: unknown): Promise<{ ok: true }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const live = this.live.get(id)
    if (!live) throw new Error('GPT Web view is not live')
    const parent = live.parentWindowId == null ? null : BrowserWindow.fromId(live.parentWindowId)
    live.view.setBounds(toDeviceIndependentBounds(normalizeBounds(boundsValue), windowZoomFactor(parent)))
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
    this.bump(live.entryId)
    return { url: live.view.webContents.getURL() || url }
  }

  async reload(idValue: unknown): Promise<{ ok: true }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)
    live.view.webContents.reload()
    live.lastUsedAt = Date.now()
    this.bump(live.entryId)
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
    const parsed = new URL(chatGptNavigationUrl(target))
    await shell.openExternal(parsed.toString())
    return { opened: true }
  }

  stop(): void {
    for (const id of [...this.live.keys()]) this.destroyLive(id, 'suspended')
  }

  private getProfileSession(): Session {
    if (this.profileSession) return this.profileSession
    const profile = electronSession.fromPartition(ZERO3_GPT_WEB_PARTITION, { cache: true })
    profile.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    profile.setPermissionCheckHandler(() => false)
    this.profileSession = profile
    return profile
  }

  private async requireEntry(id: string): Promise<Zero3GptWebWorkspaceEntry> {
    const entry = await this.entries.get(id)
    if (!entry || entry.kind !== 'gpt_web') throw new Error('GPT Web workspace entry was not found')
    if (entry.browserProfileId !== ZERO3_GPT_WEB_PROFILE_ID) throw new Error('unsupported GPT Web browser profile')
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

    const profile = this.getProfileSession()
    const view = new WebContentsView({
      webPreferences: {
        session: profile,
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
      lastUsedAt: Date.now(),
      chromeHidden: true,
      chromeCssKey: null
    }
    this.live.set(entry.id, live)
    this.installViewGuards(live)
    this.installViewObservers(live)
    this.bump(entry.id)
    this.evictIfNeeded(entry.id)

    const target = resumeChatGptUrl(entry)
    this.emitEvent({ kind: 'state', entryId: entry.id, state: 'loading' })
    void view.webContents.loadURL(target).catch(error => {
      if (!view.webContents.isDestroyed()) {
        this.emitEvent({
          kind: 'state',
          entryId: live.entryId,
          state: 'error',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    })
    return live
  }

  private installViewGuards(live: LiveGptWebView): void {
    const contents = live.view.webContents
    contents.on('will-navigate', event => {
      if (observedHttpsUrl(event.url)) return
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
            session: contents.session,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
          }
        }
      }
    })

    contents.on('did-create-window', childWindow => {
      const childContents = childWindow.webContents
      childContents.on('will-navigate', event => {
        if (observedHttpsUrl(event.url)) return
        event.preventDefault()
      })
      childContents.setWindowOpenHandler(details => {
        const target = observedHttpsUrl(details.url)
        if (target) void shell.openExternal(target)
        return { action: 'deny' }
      })
    })
  }

  private installViewObservers(live: LiveGptWebView): void {
    const contents = live.view.webContents
    const observe = () => {
      // Persist only chatgpt.com URLs. OAuth providers can contain transient
      // authorization codes in their query string and must never enter the
      // Zero3 workspace metadata store.
      const currentUrl = observedChatGptUrl(contents.getURL())
      if (!currentUrl) return
      this.queueObservedState(live, currentUrl, contents.getTitle())
    }

    // A full document load drops inserted stylesheets, so the suppression has to
    // be reapplied per document. In-page SPA routing keeps the same document and
    // therefore the existing sheet.
    contents.on('dom-ready', () => {
      live.chromeCssKey = null
      if (live.chromeHidden) void this.applyChromeSuppression(live)
    })

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
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
    })
    contents.on('destroyed', () => {
      const current = this.live.get(live.entryId)
      if (current?.view === live.view) this.live.delete(live.entryId)
    })
  }

  private queueObservedState(live: LiveGptWebView, currentUrl: string, title: string): void {
    const conversationUrl = canonicalConversationUrl(currentUrl)
    const pageTitle = normalizedTitle(title)
    this.persistenceTail = this.persistenceTail
      .then(async () => {
        const sourceEntryId = live.entryId
        const resolved = await this.entries.resolveGptWebNavigation({
          id: sourceEntryId,
          currentUrl,
          ...(conversationUrl ? { conversationUrl } : {}),
          ...(pageTitle ? { pageTitle } : {})
        })

        if (resolved.entry.id !== sourceEntryId) {
          const existingTarget = this.live.get(resolved.entry.id)
          if (existingTarget && existingTarget !== live) this.destroyLive(resolved.entry.id, 'suspended')
          this.live.delete(sourceEntryId)
          live.entryId = resolved.entry.id
          live.lastUsedAt = Date.now()
          this.live.set(live.entryId, live)
          this.bump(live.entryId)
        }

        this.emitEvent({
          kind: 'navigation',
          entryId: resolved.entry.id,
          previousEntryId: resolved.previousEntryId,
          currentUrl: resolved.entry.currentUrl,
          conversationUrl: resolved.entry.conversationUrl,
          pageTitle: resolved.entry.pageTitle
        })
      })
      .catch(error => {
        this.emitEvent({
          kind: 'state',
          entryId: live.entryId,
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

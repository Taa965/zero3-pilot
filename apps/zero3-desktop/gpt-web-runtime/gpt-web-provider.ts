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
import { ChatGptSignedOutError, readChatGptProjectCatalog, withChatGptContents } from './chatgpt-project-catalog'
import { chatGptProjectId, loadChatGptProject } from './chatgpt-project-navigation'
import { chatGptConversationId, renameChatGptConversation, setChatGptConversationArchived } from './chatgpt-conversation-name'
import {
  ZERO3_GPT_WEB_ACTIVITY_WINDOW_MS,
  ZERO3_GPT_WEB_BASE_LIVE_VIEWS,
  ZERO3_GPT_WEB_MAX_LIVE_VIEWS,
  ZERO3_GPT_WEB_PARTITION,
  type Zero3ChatGptRemoteProject,
  type Zero3GptWebBounds,
  type Zero3GptWebEvent,
  type Zero3GptWebSnapshotResult,
  type Zero3GptWebWarmResult
} from './gpt-web-types'

type LiveGptWebLoadState = 'warming' | 'warm' | 'error'

type LiveGptWebView = {
  entryId: string
  view: WebContentsView
  parentWindowId: number | null
  lastUsedAt: number
  warmedAt: number
  lastActivatedAt: number | null
  loadState: LiveGptWebLoadState
  chromeHidden: boolean
  chromeCssKey: string | null
  headerCssKey: string | null
  projectLoad?: Promise<void>
}

type SnapshotRecord = {
  dataUrl: string
  capturedAt: number
}

type EventSink = (event: Zero3GptWebEvent) => void

const MAX_URL = 8_192
const MAX_ENTRY_ID = 256
const MAX_BOUND = 16_384
const CHATGPT_HOST = 'chatgpt.com'
const MAINTENANCE_INTERVAL_MS = 15_000
const EXECUTION_PROBE_INTERVAL_MS = 800
const RENDER_WAIT_TIMEOUT_MS = 8_000
const SNAPSHOT_MAX_COUNT = 30
const SNAPSHOT_MAX_WIDTH = 1_280
const SNAPSHOT_JPEG_QUALITY = 55
const CHATGPT_LOGIN_STATUS_SCRIPT = String.raw`fetch('/api/auth/session', { credentials: 'include' })
  .then(response => response.ok ? response.json() : null)
  .then(session => Boolean(session && typeof session.accessToken === 'string' && session.accessToken))
  .catch(() => false)`
const CHATGPT_EXECUTION_STATUS_SCRIPT = String.raw`(() => {
  const selectors = [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="停止"]',
    'button[aria-label="停止生成"]',
    'button[aria-label="停止响应"]',
    'button[aria-label="停止回答"]'
  ]
  const visible = element => {
    if (!(element instanceof HTMLElement)) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
  }
  return selectors.some(selector => Array.from(document.querySelectorAll(selector)).some(visible))
})()`

// Zero3 owns the outer navigation and toolbar. Keep ChatGPT's own conversation
// rail suppressed by default, and collapse its page header so the same controls
// do not consume a second row. The hidden header remains in layout at zero
// height (rather than display:none) so Zero3 can invoke its native buttons and
// ChatGPT can still position portaled menus/dialogs relative to those triggers.
const CHATGPT_CHROME_CSS = '#stage-slideover-sidebar{display:none !important}'
const CHATGPT_HEADER_CSS = `#page-header{
  height:0 !important;
  min-height:0 !important;
  padding:0 !important;
  margin:0 !important;
  opacity:0 !important;
  pointer-events:none !important;
  overflow:visible !important;
  align-items:flex-start !important;
}`

const CHATGPT_TOOLBAR_ACTION_SELECTORS = {
  sidebar: [
    '[data-testid="open-sidebar-button"]',
    'button[aria-label="打开侧边栏"]',
    'button[aria-label="Open sidebar"]',
    'button[aria-controls="stage-slideover-sidebar"][aria-expanded="false"]',
    'button[aria-controls="stage-popover-sidebar"][aria-expanded="false"]',
    '[data-testid="close-sidebar-button"]',
    'button[aria-label="关闭侧边栏"]',
    'button[aria-label="Close sidebar"]'
  ],
  new_chat: ['#page-header a[aria-label="新聊天"]', '#page-header a[aria-label="New chat"]', '#page-header a[href="/"]'],
  share: ['[data-testid="share-chat-button"]'],
  more: ['[data-testid="conversation-options-button"]']
} as const

type ChatGptToolbarAction = keyof typeof CHATGPT_TOOLBAR_ACTION_SELECTORS
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

function allowChatGptClipboardWrite(
  contents: WebContents | null,
  permission: string,
  requestingUrl: string,
  isMainFrame: boolean
): boolean {
  if (permission !== 'clipboard-sanitized-write' || !isMainFrame || !contents || contents.isDestroyed()) return false
  try {
    const requester = safeHttpsUrl(requestingUrl, 'clipboard requesting URL')
    const page = safeHttpsUrl(contents.getURL(), 'clipboard page URL')
    return requester.origin === `https://${CHATGPT_HOST}` && page.origin === `https://${CHATGPT_HOST}`
  } catch {
    return false
  }
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
  private readonly snapshots = new Map<string, SnapshotRecord>()
  private readonly executionStates = new Map<string, boolean>()
  private profileSession: Session | null = null
  private loginWindow: BrowserWindow | null = null
  private persistenceTail: Promise<void> = Promise.resolve()
  private catalogTail: Promise<unknown> = Promise.resolve()
  private conversationMutationTail: Promise<unknown> = Promise.resolve()
  private maintenanceTimer: NodeJS.Timeout | null = null
  private executionProbeTimer: NodeJS.Timeout | null = null
  private executionProbeInFlight = false

  constructor(
    private readonly entries: Zero3WorkspaceEntryStore,
    private readonly projects: Zero3ProjectStore,
    private readonly emitEvent: EventSink
  ) {
    this.maintenanceTimer = setInterval(() => this.maintainHotPool(), MAINTENANCE_INTERVAL_MS)
    this.maintenanceTimer.unref?.()
    this.executionProbeTimer = setInterval(() => void this.probeExecutionStates(), EXECUTION_PROBE_INTERVAL_MS)
    this.executionProbeTimer.unref?.()
  }

  async create(projectId?: string | null): Promise<Zero3GptWebWorkspaceEntry> {
    const scope = projectId ?? null
    const entry = await this.entries.createGptWeb({
      projectId: scope,
      homeUrl: await this.boundProjectUrl(scope)
    })
    this.emitEvent({ kind: 'state', entryId: entry.id, state: 'cold' })
    return entry
  }

  /**
   * Lists the projects on chatgpt.com so a Zero3 project can be bound to one.
   * Serialised because each miss opens a page: two pickers racing would load
   * chatgpt.com twice for the same answer.
   */
  listRemoteProjects(parent: BrowserWindow): Promise<Zero3ChatGptRemoteProject[]> {
    const read = async () => {
      try {
        return await readChatGptProjectCatalog(this.getProfileSession(), this.reusableContents())
      } catch (error) {
        if (!(error instanceof ChatGptSignedOutError)) throw error
        await this.openLoginWindow(parent)
        return readChatGptProjectCatalog(this.getProfileSession(), this.reusableContents())
      }
    }
    const task = this.catalogTail.then(read, read)
    this.catalogTail = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  private async openLoginWindow(parent: BrowserWindow): Promise<void> {
    if (parent.isDestroyed()) throw new Error('GPT Web parent window is unavailable')
    const profile = this.getProfileSession()
    const login = new BrowserWindow({
      parent,
      modal: true,
      width: 980,
      height: 760,
      minWidth: 720,
      minHeight: 560,
      show: true,
      autoHideMenuBar: true,
      title: '登录 ChatGPT - Zero3 Pilot',
      webPreferences: {
        session: profile,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
    this.loginWindow = login
    const contents = login.webContents

    contents.on('will-navigate', event => {
      if (observedHttpsUrl(event.url)) return
      event.preventDefault()
    })
    contents.setWindowOpenHandler(details => {
      if (!observedHttpsUrl(details.url)) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900,
          height: 700,
          show: true,
          webPreferences: {
            session: profile,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
          }
        }
      }
    })

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let checking = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          cleanup()
          if (error) reject(error)
          else resolve()
        }
        const checkLogin = async () => {
          if (checking || contents.isDestroyed() || !observedChatGptUrl(contents.getURL())) return
          checking = true
          try {
            const signedIn = await contents.executeJavaScript(CHATGPT_LOGIN_STATUS_SCRIPT, false)
            if (signedIn === true) finish()
          } catch {
            // Login navigation can briefly destroy/change the document; retry on the next navigation event.
          } finally {
            checking = false
          }
        }
        const onClosed = () => finish(new Error('ChatGPT 登录窗口已关闭，请重新尝试'))
        const cleanup = () => {
          login.removeListener('closed', onClosed)
          contents.removeListener('did-navigate', checkLogin)
          contents.removeListener('did-navigate-in-page', checkLogin)
          contents.removeListener('did-stop-loading', checkLogin)
        }

        login.once('closed', onClosed)
        contents.on('did-navigate', checkLogin)
        contents.on('did-navigate-in-page', checkLogin)
        contents.on('did-stop-loading', checkLogin)
        login.focus()
        void contents.loadURL(ZERO3_GPT_WEB_HOME).then(() => checkLogin()).catch(error => {
          finish(error instanceof Error ? error : new Error(String(error)))
        })
      })
    } finally {
      for (const child of login.getChildWindows()) {
        if (!child.isDestroyed()) child.close()
      }
      if (!login.isDestroyed()) login.close()
      if (this.loginWindow === login) this.loginWindow = null
    }
  }

  rename(id: string, title: unknown): Promise<Zero3GptWebWorkspaceEntry> {
    const normalized = requiredText(title, '会话名称', 200)
    const task = this.conversationMutationTail.then(async () => {
      await this.persistenceTail
      const entry = await this.requireEntry(id)
      const conversationUrl = entry.conversationUrl ?? entry.currentUrl
      chatGptConversationId(conversationUrl)
      await withChatGptContents(this.getProfileSession(), this.reusableContents(), contents =>
        renameChatGptConversation(contents, conversationUrl, normalized)
      )
      // Only commit the local name after the remote write was read back.
      const current = await this.requireEntry(id)
      if (chatGptConversationId(current.conversationUrl ?? current.currentUrl) !== chatGptConversationId(conversationUrl)) {
        throw new Error('网页名称已修改，但零三会话地址已变更，请刷新列表后重试')
      }
      const renamed = await this.entries.rename({ id, title: normalized }) as Zero3GptWebWorkspaceEntry
      this.emitEvent({ kind: 'navigation', entryId: id, previousEntryId: null,
        currentUrl: renamed.currentUrl, conversationUrl: renamed.conversationUrl, pageTitle: renamed.pageTitle })
      return renamed
    })
    this.conversationMutationTail = task.catch(() => undefined)
    return task
  }

  setArchived(id: string, archived: unknown): Promise<Zero3GptWebWorkspaceEntry> {
    if (typeof archived !== 'boolean') throw new Error('archive state must be a boolean')
    const task = this.conversationMutationTail.then(async () => {
      await this.persistenceTail
      const entry = await this.requireEntry(id)
      const conversationUrl = canonicalConversationUrl(entry.conversationUrl ?? entry.currentUrl)
      const conversationId = conversationUrl ? chatGptConversationId(conversationUrl) : null

      // An untouched new-chat page has no remote conversation yet. In that one
      // case there is nothing for ChatGPT to archive, so only the Zero3 entry is
      // moved. Saved conversations must succeed and verify remotely first.
      if (conversationUrl && conversationId) {
        await withChatGptContents(this.getProfileSession(), this.reusableContents(), contents =>
          setChatGptConversationArchived(contents, conversationUrl, archived)
        )
        const current = await this.requireEntry(id)
        const currentUrl = canonicalConversationUrl(current.conversationUrl ?? current.currentUrl)
        if (!currentUrl || chatGptConversationId(currentUrl) !== conversationId) {
          throw new Error('ChatGPT archive state changed remotely but the Zero3 conversation identity changed; refresh and retry')
        }
      }

      const updated = await this.entries.setArchived({ id, archived }) as Zero3GptWebWorkspaceEntry
      if (archived) {
        this.destroyLive(id, 'suspended')
        this.snapshots.delete(id)
      }
      this.emitEvent({
        kind: 'navigation',
        entryId: id,
        previousEntryId: null,
        currentUrl: updated.currentUrl,
        conversationUrl: updated.conversationUrl,
        pageTitle: updated.pageTitle
      })
      return updated
    })
    this.conversationMutationTail = task.catch(() => undefined)
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

    // Trim any expired burst-tier views before switching. The durable ten-view
    // LRU base tier is never removed merely because five minutes elapsed.
    this.maintainHotPool()

    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)
    this.markActivated(live)

    // A cold or hover-prewarmed view stays detached while its first document is
    // loading. This lets UI v2 keep a cached screenshot (or its lightweight
    // placeholder) visible instead of flashing an empty native WebContentsView.
    if (live.loadState === 'warming') await this.waitUntilRenderable(live)
    // Suppression is part of show(), not just dom-ready, so a renderer reload or
    // a timing race can never re-expose ChatGPT's duplicate native header.
    await this.applyHeaderSuppression(live)
    if (live.chromeHidden) await this.applyChromeSuppression(live)

    this.detachFromParent(live)
    this.hideOtherViewsInWindow(parent.id, id)
    parent.contentView.addChildView(live.view)
    live.view.setBounds(toDeviceIndependentBounds(bounds, windowZoomFactor(parent)))
    live.parentWindowId = parent.id
    live.lastUsedAt = Date.now()
    live.view.webContents.focus()
    this.bump(id)
    this.maintainHotPool(id)

    if (live.loadState === 'warm') {
      this.emitEvent({ kind: 'state', entryId: id, state: 'visible' })
    } else if (live.loadState === 'warming') {
      this.emitEvent({ kind: 'state', entryId: id, state: 'warming' })
    }

    return (await this.entries.get(id)) as Zero3GptWebWorkspaceEntry
  }

  /**
   * Preloads a GPT session without attaching or focusing it. Hovering a session
   * row uses this path. Prewarmed-but-never-opened views fit inside the normal
   * ten-view LRU budget; only sessions actually activated in the last five
   * minutes can expand the budget beyond ten, up to thirty.
   */
  async warm(idValue: unknown): Promise<Zero3GptWebWarmResult> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    this.maintainHotPool()
    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)
    const now = Date.now()
    live.warmedAt = now
    live.lastUsedAt = now
    this.bump(id)
    this.maintainHotPool()
    return {
      state: live.parentWindowId != null ? 'visible' : live.loadState === 'warm' ? 'warm' : 'warming'
    }
  }

  async executionStatus(idValue: unknown): Promise<{ executing: boolean }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const live = this.live.get(id)
    if (!live || live.view.webContents.isDestroyed()) return { executing: false }
    const detected = await this.readExecutionState(live)
    if (detected !== null) this.publishExecutionState(live.entryId, detected)
    return { executing: detected ?? this.executionStates.get(live.entryId) === true }
  }

  snapshot(idValue: unknown): Zero3GptWebSnapshotResult {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const record = this.snapshots.get(id)
    if (!record) return { dataUrl: null }
    // Reading the snapshot also refreshes its in-memory LRU order.
    this.snapshots.delete(id)
    this.snapshots.set(id, record)
    return { dataUrl: record.dataUrl }
  }

  async hide(idValue: unknown): Promise<{ hidden: boolean }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const live = this.live.get(id)
    if (!live) return { hidden: false }
    void this.captureSnapshot(live)
    this.detachFromParent(live)
    this.markActivated(live)
    this.emitEvent({ kind: 'state', entryId: id, state: 'warm' })
    this.maintainHotPool()
    return { hidden: true }
  }

  private async applyHeaderSuppression(live: LiveGptWebView): Promise<void> {
    const contents = live.view.webContents
    if (contents.isDestroyed() || live.headerCssKey) return
    try {
      live.headerCssKey = await contents.insertCSS(CHATGPT_HEADER_CSS)
    } catch {
      live.headerCssKey = null
    }
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

  async invokeToolbarAction(
    idValue: unknown,
    actionValue: unknown
  ): Promise<{ action: ChatGptToolbarAction; invoked: true }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    if (
      typeof actionValue !== 'string' ||
      !Object.prototype.hasOwnProperty.call(CHATGPT_TOOLBAR_ACTION_SELECTORS, actionValue)
    ) {
      throw new Error('unsupported GPT Web toolbar action')
    }
    const action = actionValue as ChatGptToolbarAction
    const live = this.live.get(id)
    if (!live || live.view.webContents.isDestroyed()) throw new Error('GPT Web view is not live')

    const selectors = CHATGPT_TOOLBAR_ACTION_SELECTORS[action]
    live.view.webContents.focus()
    // The native ChatGPT rail is suppressed by default so it does not duplicate
    // Zero3's own session navigation. A promoted sidebar action explicitly opts
    // this live session back into the native rail before clicking ChatGPT's
    // current open/close control.
    if (action === 'sidebar' && live.chromeHidden) {
      await this.setChromeVisible(id, true)
    }
    let invoked = await live.view.webContents.executeJavaScript(
      `(() => {
        const selectors = ${JSON.stringify(selectors)}
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            if (!(element instanceof HTMLElement)) continue
            const style = getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden' || element.getClientRects().length === 0) continue
            element.click()
            return true
          }
        }
        return false
      })()`,
      true
    )
    // Some ChatGPT surfaces omit the pencil/new-chat control entirely. Keep
    // Zero3's promoted toolbar action reliable by falling back to the same
    // canonical ChatGPT home navigation used by a native new-chat link.
    if (invoked !== true && action === 'new_chat') {
      await live.view.webContents.loadURL(ZERO3_GPT_WEB_HOME)
      invoked = true
    }
    if (invoked !== true) throw new Error(`ChatGPT toolbar action is unavailable: ${action}`)
    live.lastUsedAt = Date.now()
    this.bump(id)
    return { action, invoked: true }
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
    this.markActivated(live)
    await this.loadPage(live, url)
    live.lastUsedAt = Date.now()
    this.bump(live.entryId)
    this.maintainHotPool(live.entryId)
    return { url: live.view.webContents.getURL() || url }
  }

  async reload(idValue: unknown): Promise<{ ok: true }> {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)
    this.markActivated(live)
    const target = live.loadState === 'error' ? resumeChatGptUrl(entry) : live.view.webContents.getURL()
    if (live.projectLoad) await live.projectLoad
    else if (chatGptProjectId(target)) await this.loadPage(live, target)
    else live.view.webContents.reload()
    live.lastUsedAt = Date.now()
    this.bump(live.entryId)
    this.maintainHotPool(live.entryId)
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
    this.snapshots.delete(id)
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
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close()
    this.loginWindow = null
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
    if (this.executionProbeTimer) {
      clearInterval(this.executionProbeTimer)
      this.executionProbeTimer = null
    }
    for (const id of [...this.live.keys()]) this.destroyLive(id, 'suspended')
    this.snapshots.clear()
  }

  private async readExecutionState(live: LiveGptWebView): Promise<boolean | null> {
    const contents = live.view.webContents
    if (contents.isDestroyed()) return false
    try {
      return (await contents.executeJavaScript(CHATGPT_EXECUTION_STATUS_SCRIPT, false)) === true
    } catch {
      return null
    }
  }

  private publishExecutionState(entryId: string, executing: boolean): void {
    const previous = this.executionStates.get(entryId)
    this.executionStates.set(entryId, executing)
    if (previous === executing || (previous === undefined && !executing)) return
    this.emitEvent({ kind: 'execution', entryId, executing })
  }

  private clearExecutionState(entryId: string): void {
    const previous = this.executionStates.get(entryId)
    this.executionStates.delete(entryId)
    if (previous === true) this.emitEvent({ kind: 'execution', entryId, executing: false })
  }

  private async probeExecutionStates(): Promise<void> {
    if (this.executionProbeInFlight) return
    this.executionProbeInFlight = true
    try {
      await Promise.all([...this.live.values()].map(async live => {
        const detected = await this.readExecutionState(live)
        if (detected !== null) this.publishExecutionState(live.entryId, detected)
      }))
    } finally {
      this.executionProbeInFlight = false
    }
  }

  private getProfileSession(): Session {
    if (this.profileSession) return this.profileSession
    const profile = electronSession.fromPartition(ZERO3_GPT_WEB_PARTITION, { cache: true })
    // ChatGPT's response/code copy buttons use the Async Clipboard API. Both
    // handlers must allow writes; clipboard reads and other permissions stay denied.
    profile.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(allowChatGptClipboardWrite(contents, permission, details.requestingUrl, details.isMainFrame))
    })
    profile.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      return allowChatGptClipboardWrite(contents, permission, requestingOrigin, details.isMainFrame)
    })
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
    // Detached prewarming still needs a desktop viewport so ChatGPT mounts and
    // populates its project sidebar before the project route is entered.
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 })
    const now = Date.now()
    const live: LiveGptWebView = {
      entryId: entry.id,
      view,
      parentWindowId: null,
      lastUsedAt: now,
      warmedAt: now,
      lastActivatedAt: null,
      loadState: 'warming',
      chromeHidden: true,
      chromeCssKey: null,
      headerCssKey: null
    }
    this.live.set(entry.id, live)
    this.installViewGuards(live)
    this.installViewObservers(live)
    this.bump(entry.id)

    const target = resumeChatGptUrl(entry)
    this.emitEvent({ kind: 'state', entryId: entry.id, state: 'warming' })
    void this.loadPage(live, target).catch(error => {
      if (!view.webContents.isDestroyed()) {
        live.loadState = 'error'
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

  private async loadPage(live: LiveGptWebView, target: string): Promise<void> {
    if (live.projectLoad) await live.projectLoad
    if (!chatGptProjectId(target)) return live.view.webContents.loadURL(target)
    const contents = live.view.webContents
    live.loadState = 'warming'
    this.emitEvent({ kind: 'state', entryId: live.entryId, state: 'warming' })
    // Suppress transient home-page persistence and ready events during bootstrap.
    const task = Promise.resolve().then(() => loadChatGptProject(contents, target))
    live.projectLoad = task
    try {
      await task
      if (contents.isDestroyed()) return
      const currentUrl = observedChatGptUrl(contents.getURL())
      if (currentUrl) this.queueObservedState(live, currentUrl, contents.getTitle())
      live.loadState = 'warm'
      this.emitEvent({ kind: 'state', entryId: live.entryId,
        state: live.parentWindowId == null ? 'warm' : 'visible' })
    } catch (error) {
      live.loadState = 'error'
      this.emitEvent({ kind: 'state', entryId: live.entryId, state: 'error',
        detail: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      live.projectLoad = undefined
    }
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
      if (live.projectLoad) return
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
      live.headerCssKey = null
      void this.applyHeaderSuppression(live)
      if (live.chromeHidden) void this.applyChromeSuppression(live)
    })

    contents.on('did-navigate', observe)
    contents.on('did-navigate-in-page', observe)
    contents.on('page-title-updated', () => observe())
    contents.on('did-start-loading', () => {
      this.publishExecutionState(live.entryId, false)
      live.loadState = 'warming'
      this.emitEvent({ kind: 'state', entryId: live.entryId, state: 'warming' })
    })
    contents.on('did-stop-loading', () => {
      void this.applyHeaderSuppression(live)
      if (live.chromeHidden) void this.applyChromeSuppression(live)
      if (live.projectLoad || live.loadState === 'error') return
      observe()
      live.loadState = 'warm'
      this.emitEvent({
        kind: 'state',
        entryId: live.entryId,
        state: live.parentWindowId == null ? 'warm' : 'visible'
      })
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      live.loadState = 'error'
      this.emitEvent({
        kind: 'state',
        entryId: live.entryId,
        state: 'error',
        detail: `${errorDescription} (${errorCode}) ${validatedUrl}`.slice(0, 2_000)
      })
    })
    contents.on('render-process-gone', (_event, details) => {
      this.clearExecutionState(live.entryId)
      live.loadState = 'error'
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
      this.clearExecutionState(live.entryId)
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
          const sourceExecution = this.executionStates.get(sourceEntryId)
          this.executionStates.delete(sourceEntryId)
          if (sourceExecution !== undefined) this.executionStates.set(live.entryId, sourceExecution)

          const sourceSnapshot = this.snapshots.get(sourceEntryId)
          if (sourceSnapshot) {
            this.snapshots.delete(sourceEntryId)
            this.rememberSnapshot(live.entryId, sourceSnapshot)
          }
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
        void this.captureSnapshot(live)
        this.detachFromParent(live)
        this.markActivated(live)
        this.emitEvent({ kind: 'state', entryId: live.entryId, state: 'warm' })
      }
    }
  }

  private markActivated(live: LiveGptWebView): void {
    const now = Date.now()
    live.lastActivatedAt = now
    live.lastUsedAt = now
    this.bump(live.entryId)
  }

  private bump(entryId: string): void {
    const live = this.live.get(entryId)
    if (!live) return
    this.live.delete(entryId)
    this.live.set(entryId, live)
  }

  private hotCapacity(now = Date.now()): number {
    let recentlyActivated = 0
    for (const live of this.live.values()) {
      const activeNow = live.parentWindowId != null
      const recentClick = live.lastActivatedAt != null && now - live.lastActivatedAt <= ZERO3_GPT_WEB_ACTIVITY_WINDOW_MS
      if (activeNow || recentClick) recentlyActivated += 1
    }
    return Math.min(
      ZERO3_GPT_WEB_MAX_LIVE_VIEWS,
      Math.max(ZERO3_GPT_WEB_BASE_LIVE_VIEWS, recentlyActivated)
    )
  }

  private maintainHotPool(protectedEntryId?: string): void {
    const now = Date.now()
    const capacity = this.hotCapacity(now)

    // The newest ten live sessions form the durable LRU base tier. Recent user
    // activity may temporarily grow that tier up to thirty live renderers, but
    // once those extra sessions fall outside the five-minute activity window the
    // capacity contracts back to ten. Do not destroy stale sessions up front:
    // doing so would erase the persistent base tier before its LRU budget is
    // applied, which is what caused long-lived sessions to reload on selection.
    while (this.live.size > capacity) {
      const candidate = [...this.live.values()]
        .filter(live => live.entryId !== protectedEntryId && live.parentWindowId == null)
        .sort((left, right) => {
          const leftRecent =
            left.lastActivatedAt != null && now - left.lastActivatedAt <= ZERO3_GPT_WEB_ACTIVITY_WINDOW_MS
          const rightRecent =
            right.lastActivatedAt != null && now - right.lastActivatedAt <= ZERO3_GPT_WEB_ACTIVITY_WINDOW_MS
          if (leftRecent !== rightRecent) return leftRecent ? 1 : -1
          return left.lastUsedAt - right.lastUsedAt
        })[0]
      if (!candidate) return
      this.destroyLive(candidate.entryId, 'suspended')
    }
  }

  private async waitUntilRenderable(live: LiveGptWebView): Promise<void> {
    if (live.loadState !== 'warming') return
    const contents = live.view.webContents
    if (contents.isDestroyed()) return

    await new Promise<void>(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        contents.removeListener('did-stop-loading', onStop)
        contents.removeListener('did-fail-load', onFail)
        contents.removeListener('destroyed', onDestroyed)
        resolve()
      }
      const onStop = () => finish()
      const onFail = () => finish()
      const onDestroyed = () => finish()
      const timeout = setTimeout(finish, RENDER_WAIT_TIMEOUT_MS)
      contents.once('did-stop-loading', onStop)
      contents.once('did-fail-load', onFail)
      contents.once('destroyed', onDestroyed)
    })
  }

  private async captureSnapshot(live: LiveGptWebView): Promise<void> {
    const contents = live.view.webContents
    if (contents.isDestroyed()) return
    try {
      const image = await contents.capturePage()
      if (image.isEmpty()) return
      const size = image.getSize()
      const snapshot =
        size.width > SNAPSHOT_MAX_WIDTH
          ? image.resize({ width: SNAPSHOT_MAX_WIDTH, quality: 'good' })
          : image
      const encoded = snapshot.toJPEG(SNAPSHOT_JPEG_QUALITY).toString('base64')
      if (!encoded) return
      this.rememberSnapshot(live.entryId, {
        dataUrl: `data:image/jpeg;base64,${encoded}`,
        capturedAt: Date.now()
      })
    } catch {
      // Snapshotting is a visual optimization only. It must never interfere with
      // session switching or with the authoritative workspace metadata.
    }
  }

  private rememberSnapshot(entryId: string, record: SnapshotRecord): void {
    this.snapshots.delete(entryId)
    this.snapshots.set(entryId, record)
    while (this.snapshots.size > SNAPSHOT_MAX_COUNT) {
      const oldest = this.snapshots.keys().next().value as string | undefined
      if (!oldest) return
      this.snapshots.delete(oldest)
    }
  }

  private destroyLive(entryId: string, state: 'suspended'): void {
    const live = this.live.get(entryId)
    if (!live) return
    this.live.delete(entryId)
    this.clearExecutionState(entryId)
    this.detachFromParent(live)
    if (!live.view.webContents.isDestroyed()) live.view.webContents.close({ waitForBeforeUnload: false })
    this.emitEvent({ kind: 'state', entryId, state })
  }
}

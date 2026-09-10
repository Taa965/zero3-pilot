import { BrowserWindow, WebContentsView, session as electronSession, shell, type Session } from 'electron'

import type { Zero3WorkspaceEntryStore } from '../workspace/workspace-entry-store'
import {
  ZERO3_GEMINI_WEB_HOME,
  ZERO3_GEMINI_WEB_PROFILE_ID,
  type Zero3GeminiWebWorkspaceEntry
} from '../workspace/workspace-entry-types'
import {
  ZERO3_GEMINI_WEB_MAX_LIVE_VIEWS,
  ZERO3_GEMINI_WEB_PARTITION,
  type Zero3GeminiWebBounds,
  type Zero3GeminiWebEvent
} from './gemini-web-types'

type LiveView = { entryId: string; view: WebContentsView; parentWindowId: number | null; lastUsedAt: number }
type EventSink = (event: Zero3GeminiWebEvent) => void

const GEMINI_HOST = 'gemini.google.com'
const MAX_TEXT = 512
const MAX_ID = 256
const MAX_URL = 8192
const MAX_BOUND = 16384
const EXECUTION_PROBE_INTERVAL_MS = 800
const GENERIC_TITLES = new Set(['Gemini', 'Google Gemini'])
const GEMINI_EXECUTION_STATUS_SCRIPT = String.raw`(() => {
  const selectors = [
    '[data-test-id="stop-button"]',
    '[data-testid="stop-button"]',
    'button.stop-button',
    'button[aria-label="Stop"]',
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="停止"]',
    'button[aria-label="停止回答"]',
    'button[aria-label="停止响应"]',
    'button[aria-label="停止生成"]'
  ]
  const visible = element => {
    if (!(element instanceof HTMLElement)) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
  }
  return selectors.some(selector => Array.from(document.querySelectorAll(selector)).some(visible))
})()`

function text(value: unknown, label: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return normalized
}

function httpsUrl(value: unknown, label: string): URL {
  const raw = text(value, label, MAX_URL)
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error(`${label} must be a valid URL`) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`${label} must be credential-free HTTPS`)
  return parsed
}

function geminiUrl(value: unknown): string {
  const parsed = httpsUrl(value, 'Gemini Web URL')
  if (parsed.hostname.toLowerCase() !== GEMINI_HOST) throw new Error('direct Gemini Web navigation is limited to gemini.google.com')
  return parsed.toString()
}

function observedHttps(value: string): string | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null
  } catch { return null }
}

function observedGemini(value: string): string | null {
  const normalized = observedHttps(value)
  if (!normalized) return null
  try { return new URL(normalized).hostname.toLowerCase() === GEMINI_HOST ? normalized : null } catch { return null }
}

function conversationUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.hostname.toLowerCase() !== GEMINI_HOST || parsed.protocol !== 'https:') return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    const marker = segments.lastIndexOf('app')
    if (marker < 0 || marker >= segments.length - 1) return null
    const id = segments[marker + 1]
    if (!id || id.length > 512) return null
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch { return null }
}

function title(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ')
  return !normalized || normalized.length > MAX_TEXT || GENERIC_TITLES.has(normalized) ? null : normalized
}

function bounds(value: unknown): Zero3GeminiWebBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gemini Web bounds must be an object')
  const raw = value as Record<string, unknown>
  const integer = (key: 'x' | 'y' | 'width' | 'height', min: number) => {
    const n = raw[key]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > MAX_BOUND) throw new Error(`bounds.${key} is invalid`)
    return n
  }
  return { x: integer('x', 0), y: integer('y', 0), width: integer('width', 1), height: integer('height', 1) }
}

// The renderer measures its host element in CSS pixels while setBounds takes
// device-independent pixels. They only match at zoom factor 1, and the desktop
// ships a 90% default zoom, so an unconverted rect oversizes the view and
// pushes its lower-right corner past the window edge. Same conversion as the
// GPT Web provider.
function dipBounds(value: Zero3GeminiWebBounds, window: BrowserWindow | null): Zero3GeminiWebBounds {
  const raw =
    !window || window.isDestroyed() || window.webContents.isDestroyed() ? 1 : window.webContents.getZoomFactor()
  const scale = Number.isFinite(raw) && raw > 0 ? raw : 1
  if (scale === 1) return value
  return {
    x: Math.round(value.x * scale),
    y: Math.round(value.y * scale),
    width: Math.max(1, Math.round(value.width * scale)),
    height: Math.max(1, Math.round(value.height * scale))
  }
}

export class Zero3GeminiWebProvider {
  private readonly live = new Map<string, LiveView>()
  private readonly executionStates = new Map<string, boolean>()
  private profile: Session | null = null
  private persistenceTail: Promise<void> = Promise.resolve()
  private executionProbeTimer: NodeJS.Timeout | null = null
  private executionProbeInFlight = false

  constructor(private readonly entries: Zero3WorkspaceEntryStore, private readonly emit: EventSink) {
    this.executionProbeTimer = setInterval(() => void this.probeExecutionStates(), EXECUTION_PROBE_INTERVAL_MS)
    this.executionProbeTimer.unref?.()
  }

  async create(projectId?: string | null): Promise<Zero3GeminiWebWorkspaceEntry> {
    const entry = await this.entries.createGeminiWeb({ projectId: projectId ?? null })
    this.emit({ kind: 'state', entryId: entry.id, state: 'created' })
    return entry
  }

  async show(parent: BrowserWindow, input: { id: string; bounds: unknown }): Promise<Zero3GeminiWebWorkspaceEntry> {
    if (parent.isDestroyed()) throw new Error('Gemini Web parent window is unavailable')
    const id = text(input.id, 'Gemini entry id', MAX_ID)
    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)
    this.detach(live)
    for (const other of this.live.values()) if (other.entryId !== id && other.parentWindowId === parent.id) this.detach(other)
    parent.contentView.addChildView(live.view)
    live.view.setBounds(dipBounds(bounds(input.bounds), parent))
    live.parentWindowId = parent.id
    live.lastUsedAt = Date.now()
    live.view.webContents.focus()
    this.bump(live.entryId)
    this.emit({ kind: 'state', entryId: live.entryId, state: 'shown' })
    return (await this.entries.get(live.entryId)) as Zero3GeminiWebWorkspaceEntry
  }

  async executionStatus(idValue: unknown): Promise<{ executing: boolean }> {
    const id = text(idValue, 'Gemini entry id', MAX_ID)
    const live = this.live.get(id)
    if (!live || live.view.webContents.isDestroyed()) return { executing: false }
    const detected = await this.readExecutionState(live)
    if (detected !== null) this.publishExecutionState(live.entryId, detected)
    return { executing: detected ?? this.executionStates.get(live.entryId) === true }
  }

  async hide(idValue: unknown) {
    const id = text(idValue, 'Gemini entry id', MAX_ID)
    const live = this.live.get(id)
    if (!live) return { hidden: false }
    this.detach(live)
    this.emit({ kind: 'state', entryId: id, state: 'hidden' })
    return { hidden: true }
  }

  async setBounds(idValue: unknown, value: unknown) {
    const id = text(idValue, 'Gemini entry id', MAX_ID)
    const live = this.live.get(id)
    if (!live) throw new Error('Gemini Web view is not live')
    const parent = live.parentWindowId == null ? null : BrowserWindow.fromId(live.parentWindowId)
    live.view.setBounds(dipBounds(bounds(value), parent))
    live.lastUsedAt = Date.now()
    return { ok: true as const }
  }

  async reload(idValue: unknown) {
    const id = text(idValue, 'Gemini entry id', MAX_ID)
    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)
    live.view.webContents.reload()
    return { ok: true as const }
  }

  async suspend(idValue: unknown) {
    const id = text(idValue, 'Gemini entry id', MAX_ID)
    const live = this.live.get(id)
    if (!live) return { suspended: false }
    this.destroy(id)
    return { suspended: true }
  }

  async remove(idValue: unknown) {
    const id = text(idValue, 'Gemini entry id', MAX_ID)
    this.destroy(id)
    return this.entries.remove(id)
  }

  async openExternal(idValue: unknown) {
    const entry = await this.requireEntry(text(idValue, 'Gemini entry id', MAX_ID))
    await shell.openExternal(geminiUrl(entry.conversationUrl ?? entry.currentUrl))
    return { opened: true }
  }

  stop() {
    if (this.executionProbeTimer) {
      clearInterval(this.executionProbeTimer)
      this.executionProbeTimer = null
    }
    for (const id of [...this.live.keys()]) this.destroy(id)
  }

  private async readExecutionState(live: LiveView): Promise<boolean | null> {
    const contents = live.view.webContents
    if (contents.isDestroyed()) return false
    try {
      return (await contents.executeJavaScript(GEMINI_EXECUTION_STATUS_SCRIPT, false)) === true
    } catch {
      return null
    }
  }

  private publishExecutionState(entryId: string, executing: boolean) {
    const previous = this.executionStates.get(entryId)
    this.executionStates.set(entryId, executing)
    if (previous === executing || (previous === undefined && !executing)) return
    this.emit({ kind: 'execution', entryId, executing })
  }

  private clearExecutionState(entryId: string) {
    const previous = this.executionStates.get(entryId)
    this.executionStates.delete(entryId)
    if (previous === true) this.emit({ kind: 'execution', entryId, executing: false })
  }

  private async probeExecutionStates() {
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

  private session(): Session {
    if (this.profile) return this.profile
    const profile = electronSession.fromPartition(ZERO3_GEMINI_WEB_PARTITION, { cache: true })
    profile.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    profile.setPermissionCheckHandler(() => false)
    this.profile = profile
    return profile
  }

  private async requireEntry(id: string): Promise<Zero3GeminiWebWorkspaceEntry> {
    const entry = await this.entries.get(id)
    if (!entry || entry.kind !== 'gemini_web') throw new Error('Gemini Web workspace entry was not found')
    if (entry.browserProfileId !== ZERO3_GEMINI_WEB_PROFILE_ID) throw new Error('unsupported Gemini browser profile')
    return entry
  }

  private async ensureLive(entry: Zero3GeminiWebWorkspaceEntry): Promise<LiveView> {
    const current = this.live.get(entry.id)
    if (current && !current.view.webContents.isDestroyed()) return current
    if (current) this.live.delete(entry.id)
    const view = new WebContentsView({
      webPreferences: {
        session: this.session(), contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, allowRunningInsecureContent: false, spellcheck: true
      }
    })
    const live: LiveView = { entryId: entry.id, view, parentWindowId: null, lastUsedAt: Date.now() }
    this.live.set(entry.id, live)
    this.installGuards(live)
    this.installObservers(live)
    this.bump(entry.id)
    while (this.live.size > ZERO3_GEMINI_WEB_MAX_LIVE_VIEWS) {
      const candidate = [...this.live.keys()].find(id => id !== live.entryId)
      if (!candidate) break
      this.destroy(candidate)
    }
    this.emit({ kind: 'state', entryId: live.entryId, state: 'loading' })
    void view.webContents.loadURL(this.resumeUrl(entry)).catch(error => {
      if (!view.webContents.isDestroyed()) this.emit({ kind: 'state', entryId: live.entryId, state: 'error', detail: String(error) })
    })
    return live
  }

  private resumeUrl(entry: Zero3GeminiWebWorkspaceEntry) {
    for (const candidate of [entry.conversationUrl, entry.currentUrl]) {
      if (!candidate) continue
      try { return geminiUrl(candidate) } catch {}
    }
    return ZERO3_GEMINI_WEB_HOME
  }

  private installGuards(live: LiveView) {
    const contents = live.view.webContents
    contents.on('will-navigate', event => {
      if (observedHttps(event.url)) return
      event.preventDefault()
      this.emit({ kind: 'state', entryId: live.entryId, state: 'error', detail: 'Blocked non-HTTPS navigation' })
    })
    contents.setWindowOpenHandler(details => {
      const target = observedHttps(details.url)
      if (!target) return { action: 'deny' }
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 760, show: true, webPreferences: {
        session: contents.session, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false
      } } }
    })
    contents.on('did-create-window', child => {
      child.webContents.setWindowOpenHandler(details => {
        const target = observedHttps(details.url)
        if (target) void shell.openExternal(target)
        return { action: 'deny' }
      })
    })
  }

  private installObservers(live: LiveView) {
    const contents = live.view.webContents
    const observe = () => {
      // Only persist Gemini URLs. Google OAuth URLs can contain transient auth
      // codes and must never enter Zero3 metadata.
      const currentUrl = observedGemini(contents.getURL())
      if (currentUrl) this.queueNavigation(live, currentUrl, contents.getTitle())
    }
    contents.on('did-navigate', observe)
    contents.on('did-navigate-in-page', observe)
    contents.on('page-title-updated', observe)
    contents.on('did-start-loading', () => {
      this.publishExecutionState(live.entryId, false)
      this.emit({ kind: 'state', entryId: live.entryId, state: 'loading' })
    })
    contents.on('did-stop-loading', () => { observe(); this.emit({ kind: 'state', entryId: live.entryId, state: 'ready' }) })
    contents.on('render-process-gone', (_event, details) => {
      this.clearExecutionState(live.entryId)
      this.emit({ kind: 'state', entryId: live.entryId, state: 'error', detail: `Gemini renderer exited: ${details.reason}` })
      this.detach(live)
      this.live.delete(live.entryId)
    })
  }

  private queueNavigation(live: LiveView, currentUrl: string, rawTitle: string) {
    const canonical = conversationUrl(currentUrl)
    const pageTitle = title(rawTitle)
    this.persistenceTail = this.persistenceTail.then(async () => {
      const sourceId = live.entryId
      const resolved = await this.entries.resolveGeminiWebNavigation({
        id: sourceId, currentUrl,
        ...(canonical ? { conversationUrl: canonical } : {}),
        ...(pageTitle ? { pageTitle } : {})
      })
      if (resolved.entry.id !== sourceId) {
        const duplicate = this.live.get(resolved.entry.id)
        if (duplicate && duplicate !== live) this.destroy(resolved.entry.id)
        this.live.delete(sourceId)
        live.entryId = resolved.entry.id
        this.live.set(live.entryId, live)
        const sourceExecution = this.executionStates.get(sourceId)
        this.executionStates.delete(sourceId)
        if (sourceExecution !== undefined) this.executionStates.set(live.entryId, sourceExecution)
      }
      this.emit({ kind: 'navigation', entryId: resolved.entry.id, previousEntryId: resolved.previousEntryId,
        logicalSessionId: resolved.entry.logicalSessionId, currentUrl: resolved.entry.currentUrl,
        conversationUrl: resolved.entry.conversationUrl, pageTitle: resolved.entry.pageTitle })
    }).catch(error => this.emit({ kind: 'state', entryId: live.entryId, state: 'error', detail: String(error) }))
  }

  private detach(live: LiveView) {
    const parentId = live.parentWindowId
    live.parentWindowId = null
    if (parentId == null) return
    const parent = BrowserWindow.fromId(parentId)
    if (!parent || parent.isDestroyed()) return
    try { parent.contentView.removeChildView(live.view) } catch {}
  }

  private bump(id: string) {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    this.live.set(id, live)
  }

  private destroy(id: string) {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    this.clearExecutionState(id)
    this.detach(live)
    if (!live.view.webContents.isDestroyed()) live.view.webContents.close({ waitForBeforeUnload: false })
    this.emit({ kind: 'state', entryId: id, state: 'suspended' })
  }
}

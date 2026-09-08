import { WebContentsView, type Session, type WebContents } from 'electron'

import type { Zero3ChatGptRemoteProject } from './gpt-web-types'

const CHATGPT_HOST = 'chatgpt.com'
const CHATGPT_HOME = 'https://chatgpt.com/'
const MAX_REMOTE_PROJECTS = 300
const MAX_REMOTE_NAME = 200
const GIZMO_ID = /^g-p-[A-Za-z0-9_-]{1,192}$/
const LOAD_TIMEOUT_MS = 20_000
const SCRIPT_TIMEOUT_MS = 20_000

// ChatGPT publishes no API for "list my projects", so the catalog is read from
// inside the logged-in page: its own session endpoint yields the bearer token
// the web client uses, and the sidebar endpoint behind it lists the projects.
// Both are private and can change without notice, so the reader tries the API
// first and falls back to the rendered sidebar links, and every field that
// comes back is re-validated here -- the page is untrusted input, not a peer.
const CATALOG_SCRIPT = String.raw`(async () => {
  const found = new Map()
  const gizmoId = /^g-p-[A-Za-z0-9_-]{1,192}$/
  const remember = (id, name) => {
    if (typeof id !== 'string' || !gizmoId.test(id) || found.size >= 400) return
    const label = typeof name === 'string' ? name.trim() : ''
    const existing = found.get(id)
    if (existing != null && existing.length >= label.length) return
    found.set(id, label)
  }

  // The payload shape has changed across ChatGPT releases, so instead of
  // pinning one path this walks whatever comes back and keeps every object
  // that carries a project gizmo id next to something name-shaped.
  const walk = (value, depth) => {
    if (!value || depth > 8) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    const id = typeof value.id === 'string' ? value.id : null
    if (id && gizmoId.test(id)) {
      const display = value.display && typeof value.display === 'object' ? value.display : {}
      remember(id, value.name || value.title || display.name || display.title || '')
    }
    for (const key of Object.keys(value)) walk(value[key], depth + 1)
  }

  let reason = null
  try {
    const response = await fetch('/api/auth/session', { credentials: 'include' })
    const session = response.ok ? await response.json() : null
    const token = session && typeof session.accessToken === 'string' ? session.accessToken : null
    if (!token) {
      reason = 'signed-out'
    } else {
      const sidebar = await fetch('/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=1', {
        credentials: 'include',
        headers: { Authorization: 'Bearer ' + token }
      })
      if (sidebar.ok) walk(await sidebar.json(), 0)
      else if (sidebar.status === 401 || sidebar.status === 403) reason = 'signed-out'
      else reason = 'sidebar-' + sidebar.status
    }
  } catch (error) {
    reason = 'request-failed'
  }

  // Fallback for a renamed or withdrawn endpoint: the project links ChatGPT
  // renders in its own rail carry the same ids.
  for (const anchor of document.querySelectorAll('a[href*="/g/g-p-"]')) {
    const href = anchor.getAttribute('href') || ''
    const after = href.split('/g/')[1] || ''
    remember(after.split(/[/?#]/)[0] || '', (anchor.textContent || '').replace(/\s+/g, ' ').trim())
  }

  return {
    reason: found.size > 0 ? null : reason,
    items: [...found.entries()].map(entry => ({ id: entry[0], name: entry[1] }))
  }
})()`

function normalizeRemoteProject(value: unknown): Zero3ChatGptRemoteProject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!GIZMO_ID.test(id)) return null
  const rawName = typeof raw.name === 'string' ? raw.name : ''
  // Control characters would travel into the renderer and into the projects
  // file, so the display name is stripped to printable text before it is used.
  const name = rawName
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REMOTE_NAME)
  return { id, name: name || id, url: `https://${CHATGPT_HOST}/g/${id}/project` }
}

function reasonMessage(reason: unknown): string {
  if (reason === 'signed-out') return '尚未在 Zero3 内登录 ChatGPT 网页版，请先打开一个 GPT 网页会话完成登录'
  if (reason === 'request-failed') return '读取 ChatGPT 项目列表失败：网络请求被拒绝'
  if (typeof reason === 'string' && reason.startsWith('sidebar-')) {
    return `ChatGPT 项目接口返回 ${reason.slice('sidebar-'.length)}，可能是接口已变更`
  }
  return 'ChatGPT 账号下没有找到任何项目'
}

async function readFromContents(contents: WebContents): Promise<Zero3ChatGptRemoteProject[]> {
  const raw = (await Promise.race([
    contents.executeJavaScript(CATALOG_SCRIPT, false),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('读取 ChatGPT 项目列表超时')), SCRIPT_TIMEOUT_MS)
    })
  ])) as unknown

  if (!raw || typeof raw !== 'object') throw new Error('ChatGPT 项目列表返回了无法识别的结果')
  const payload = raw as { reason?: unknown; items?: unknown }
  const items = Array.isArray(payload.items) ? payload.items.slice(0, MAX_REMOTE_PROJECTS) : []
  const projects: Zero3ChatGptRemoteProject[] = []
  for (const item of items) {
    const project = normalizeRemoteProject(item)
    if (project) projects.push(project)
  }
  if (projects.length === 0) throw new Error(reasonMessage(payload.reason))
  return projects.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
}

function loadHome(contents: WebContents): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('打开 ChatGPT 超时')), LOAD_TIMEOUT_MS)
    contents
      .loadURL(CHATGPT_HOME)
      .then(() => {
        clearTimeout(timer)
        resolve()
      })
      .catch(error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
  })
}

function onChatGptOrigin(contents: WebContents): boolean {
  try {
    return new URL(contents.getURL()).hostname.toLowerCase() === CHATGPT_HOST
  } catch {
    return false
  }
}

/**
 * Reads the ChatGPT projects visible to the signed-in account. `reusable` is a
 * live view already sitting on chatgpt.com: reading through it costs no extra
 * page load. When there is none, an off-screen view carries the read and is
 * torn down before returning.
 */
export async function readChatGptProjectCatalog(
  profile: Session,
  reusable: WebContents | null
): Promise<Zero3ChatGptRemoteProject[]> {
  if (reusable && !reusable.isDestroyed() && onChatGptOrigin(reusable)) {
    return readFromContents(reusable)
  }

  const view = new WebContentsView({
    webPreferences: {
      session: profile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  const contents = view.webContents
  // The probe view is never parented to a window, so a popup opened by page
  // script would be the only thing a user could see from it.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await loadHome(contents)
    return await readFromContents(contents)
  } finally {
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
  }
}

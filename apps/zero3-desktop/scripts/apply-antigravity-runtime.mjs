import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'antigravity-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'antigravity')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 Antigravity overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}
function copySources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['antigravity-types.ts', 'antigravity-adapter.ts', 'index.ts']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 Antigravity source missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

const main = String.raw`
const zero3Antigravity = new Zero3AntigravityAdapter(
  path.join(app.getPath('userData'), 'zero3', 'antigravity-sessions-v1.json')
)
const zero3AntigravityUnsubscribe = zero3Antigravity.subscribe(event => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('zero3:antigravity:event', event)
  }
})
function zero3AntigravityRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
ipcMain.handle('zero3:antigravity:status', () => zero3Antigravity.status())
ipcMain.handle('zero3:antigravity:binding', (_event, request: unknown) => zero3Antigravity.binding(zero3AntigravityRecord(request).logicalSessionId))
ipcMain.handle('zero3:antigravity:turn:start', (_event, request: unknown) => zero3Antigravity.startTurn(request as never))
ipcMain.handle('zero3:antigravity:turn:wait', (_event, request: unknown) => zero3Antigravity.waitTurn(zero3AntigravityRecord(request).turnId))
ipcMain.handle('zero3:antigravity:interrupt', (_event, request: unknown) => zero3Antigravity.interrupt(zero3AntigravityRecord(request).logicalSessionId))
ipcMain.handle('zero3:antigravity:stop', (_event, request: unknown) => zero3Antigravity.stop(zero3AntigravityRecord(request).logicalSessionId))
app.on('before-quit', () => { zero3AntigravityUnsubscribe(); zero3Antigravity.stopAll() })
`

const preload = String.raw`contextBridge.exposeInMainWorld('zero3Antigravity', {
  status: () => ipcRenderer.invoke('zero3:antigravity:status'),
  binding: request => ipcRenderer.invoke('zero3:antigravity:binding', request),
  startTurn: request => ipcRenderer.invoke('zero3:antigravity:turn:start', request),
  waitTurn: request => ipcRenderer.invoke('zero3:antigravity:turn:wait', request),
  interrupt: request => ipcRenderer.invoke('zero3:antigravity:interrupt', request),
  stop: request => ipcRenderer.invoke('zero3:antigravity:stop', request),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('zero3:antigravity:event', listener)
    return () => ipcRenderer.removeListener('zero3:antigravity:event', listener)
  }
})

contextBridge.exposeInMainWorld('zero3GeminiWeb', {`

const types = String.raw`
type Zero3AntigravityEvent = {
  eventId: string
  logicalSessionId: string
  taskId: string | null
  turnId: string | null
  conversationId: string | null
  at: string
  type: string
  payload: Record<string, unknown>
}
type Zero3AntigravityTurnResult = {
  turnId: string
  logicalSessionId: string
  conversationId: string | null
  status: 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  response: string | null
  structuredOutput: unknown | null
  error: string | null
  rawStatus: string | null
}
`
const windowSurface = String.raw`    zero3Antigravity: {
      status: () => Promise<{ available: boolean; binary: string | null; activeSessions: string[] }>
      binding: (request: { logicalSessionId: string }) => Promise<unknown>
      startTurn: (request: { logicalSessionId: string; projectId?: string | null; cwd: string; prompt: string; taskId?: string | null; contextVersion?: number | null }) => Promise<{ turnId: string }>
      waitTurn: (request: { turnId: string }) => Promise<Zero3AntigravityTurnResult>
      interrupt: (request: { logicalSessionId: string }) => Promise<{ interrupted: boolean }>
      stop: (request: { logicalSessionId: string }) => Promise<{ stopped: boolean }>
      onEvent: (callback: (event: Zero3AntigravityEvent) => void) => () => void
    }
    zero3GeminiWeb: {`

export function applyZero3AntigravityRuntime() {
  copySources()
  patchFile('electron/main.ts', [
    { label: 'Antigravity runtime import', from: "import { Zero3GeminiWebProvider } from './zero3/gemini-web/index'", to: "import { Zero3GeminiWebProvider } from './zero3/gemini-web/index'\nimport { Zero3AntigravityAdapter } from './zero3/antigravity/index'" },
    { label: 'Antigravity runtime IPC', from: 'const zero3CodexAppServer = createZero3CodexAppServer()', to: main + '\nconst zero3CodexAppServer = createZero3CodexAppServer()' }
  ])
  patchFile('electron/preload.ts', [{ label: 'Antigravity preload', from: "contextBridge.exposeInMainWorld('zero3GeminiWeb', {", to: preload }])
  patchFile('src/global.d.ts', [
    { label: 'Antigravity renderer types', from: 'type Zero3GeminiWebBounds = { x: number; y: number; width: number; height: number }', to: types + '\ntype Zero3GeminiWebBounds = { x: number; y: number; width: number; height: number }' },
    { label: 'Antigravity renderer surface', from: '    zero3GeminiWeb: {', to: windowSurface }
  ])
}

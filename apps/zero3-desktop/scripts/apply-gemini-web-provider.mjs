import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'gemini-web-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'gemini-web')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 Gemini Web overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}
function copySources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['gemini-web-types.ts', 'gemini-web-provider.ts', 'index.ts']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 Gemini Web source missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

const mainHandlers = String.raw`
function broadcastZero3GeminiWebEvent(event: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('zero3:gemini-web:event', event)
  }
}
const zero3GeminiWeb = new Zero3GeminiWebProvider(zero3WorkspaceEntries, broadcastZero3GeminiWebEvent)
function zero3GeminiRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function zero3GeminiId(value: unknown): string {
  const id = zero3GeminiRecord(value).id
  if (typeof id !== 'string' || !id.trim() || id.trim().length > 256) throw new Error('Gemini Web entry id is required')
  return id.trim()
}
function zero3GeminiParent(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const parent = BrowserWindow.fromWebContents(event.sender)
  if (!parent || parent.isDestroyed()) throw new Error('Gemini Web parent window is unavailable')
  return parent
}
ipcMain.handle('zero3:gemini-web:create', async (_event, request: unknown) => {
  const input = zero3GeminiRecord(request)
  const requestedProjectId = input.projectId == null ? null : input.projectId
  if (requestedProjectId != null && typeof requestedProjectId !== 'string') throw new Error('projectId must be a string or null')
  const activeProject = requestedProjectId == null ? await zero3ProjectStore.getActive() : null
  const projectId = (requestedProjectId as string | null) ?? activeProject?.id ?? null
  return zero3GeminiWeb.create(projectId)
})
ipcMain.handle('zero3:gemini-web:show', (event, request: unknown) => {
  const input = zero3GeminiRecord(request)
  return zero3GeminiWeb.show(zero3GeminiParent(event), { id: zero3GeminiId(input), bounds: input.bounds })
})
ipcMain.handle('zero3:gemini-web:hide', (_event, request: unknown) => zero3GeminiWeb.hide(zero3GeminiId(request)))
ipcMain.handle('zero3:gemini-web:set-bounds', (_event, request: unknown) => {
  const input = zero3GeminiRecord(request)
  return zero3GeminiWeb.setBounds(zero3GeminiId(input), input.bounds)
})
ipcMain.handle('zero3:gemini-web:reload', (_event, request: unknown) => zero3GeminiWeb.reload(zero3GeminiId(request)))
ipcMain.handle('zero3:gemini-web:suspend', (_event, request: unknown) => zero3GeminiWeb.suspend(zero3GeminiId(request)))
ipcMain.handle('zero3:gemini-web:remove', (_event, request: unknown) => zero3GeminiWeb.remove(zero3GeminiId(request)))
ipcMain.handle('zero3:gemini-web:open-external', (_event, request: unknown) => zero3GeminiWeb.openExternal(zero3GeminiId(request)))
app.on('before-quit', () => zero3GeminiWeb.stop())
`

const preload = String.raw`contextBridge.exposeInMainWorld('zero3GeminiWeb', {
  create: request => ipcRenderer.invoke('zero3:gemini-web:create', request),
  show: request => ipcRenderer.invoke('zero3:gemini-web:show', request),
  hide: request => ipcRenderer.invoke('zero3:gemini-web:hide', request),
  setBounds: request => ipcRenderer.invoke('zero3:gemini-web:set-bounds', request),
  reload: request => ipcRenderer.invoke('zero3:gemini-web:reload', request),
  suspend: request => ipcRenderer.invoke('zero3:gemini-web:suspend', request),
  remove: request => ipcRenderer.invoke('zero3:gemini-web:remove', request),
  openExternal: request => ipcRenderer.invoke('zero3:gemini-web:open-external', request),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('zero3:gemini-web:event', listener)
    return () => ipcRenderer.removeListener('zero3:gemini-web:event', listener)
  }
})

contextBridge.exposeInMainWorld('zero3Control', {`

const typeDefinitions = String.raw`
type Zero3GeminiWebBounds = { x: number; y: number; width: number; height: number }
type Zero3GeminiWebEvent =
  | { kind: 'state'; entryId: string; state: 'created' | 'loading' | 'ready' | 'shown' | 'hidden' | 'suspended' | 'error'; detail?: string }
  | { kind: 'navigation'; entryId: string; previousEntryId: string | null; logicalSessionId: string; currentUrl: string; conversationUrl: string | null; pageTitle: string | null }
`
const windowSurface = String.raw`    zero3GeminiWeb: {
      create: (request?: { projectId?: string | null }) => Promise<Zero3GeminiWebWorkspaceEntry>
      show: (request: { id: string; bounds: Zero3GeminiWebBounds }) => Promise<Zero3GeminiWebWorkspaceEntry>
      hide: (request: { id: string }) => Promise<{ hidden: boolean }>
      setBounds: (request: { id: string; bounds: Zero3GeminiWebBounds }) => Promise<{ ok: true }>
      reload: (request: { id: string }) => Promise<{ ok: true }>
      suspend: (request: { id: string }) => Promise<{ suspended: boolean }>
      remove: (request: { id: string }) => Promise<{ removed: boolean }>
      openExternal: (request: { id: string }) => Promise<{ opened: boolean }>
      onEvent: (callback: (event: Zero3GeminiWebEvent) => void) => () => void
    }
    zero3Control: {`

export function applyZero3GeminiWebProvider() {
  copySources()
  patchFile('electron/main.ts', [
    { label: 'Gemini provider import', from: "import { Zero3GptWebProvider } from './zero3/gpt-web/index'", to: "import { Zero3GptWebProvider } from './zero3/gpt-web/index'\nimport { Zero3GeminiWebProvider } from './zero3/gemini-web/index'" },
    { label: 'Gemini IPC handlers', from: 'const zero3CodexAppServer = createZero3CodexAppServer()', to: mainHandlers + '\nconst zero3CodexAppServer = createZero3CodexAppServer()' }
  ])
  patchFile('electron/preload.ts', [{ label: 'Gemini preload surface', from: "contextBridge.exposeInMainWorld('zero3Control', {", to: preload }])
  patchFile('src/global.d.ts', [
    { label: 'Gemini renderer types', from: 'type Zero3ControlStatus = { configured: boolean; baseUrl: string | null }', to: typeDefinitions + '\ntype Zero3ControlStatus = { configured: boolean; baseUrl: string | null }' },
    { label: 'Gemini renderer window surface', from: '    zero3Control: {', to: windowSurface }
  ])
}

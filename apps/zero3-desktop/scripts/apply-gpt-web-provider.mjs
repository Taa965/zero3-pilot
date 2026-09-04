import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'gpt-web-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'gpt-web')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 GPT Web overlay drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the pinned Hermes desktop boundary before updating the upstream pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function copyRuntimeSources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['gpt-web-types.ts', 'gpt-web-provider.ts', 'index.ts']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 GPT Web source template missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

const mainHandlers = String.raw`
function broadcastZero3GptWebEvent(event: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('zero3:gpt-web:event', event)
    }
  }
}

const zero3GptWeb = new Zero3GptWebProvider(zero3WorkspaceEntries, broadcastZero3GptWebEvent)

function zero3GptWebRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function zero3GptWebId(value: unknown): string {
  const input = zero3GptWebRecord(value)
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id || id.length > 256) throw new Error('GPT Web entry id is required and must be at most 256 characters')
  return id
}

function zero3GptWebParent(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const parent = BrowserWindow.fromWebContents(event.sender)
  if (!parent || parent.isDestroyed()) throw new Error('GPT Web parent window is unavailable')
  return parent
}

ipcMain.handle('zero3:gpt-web:create', (_event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  const projectId = input.projectId == null ? null : input.projectId
  if (projectId != null && typeof projectId !== 'string') throw new Error('projectId must be a string or null')
  return zero3GptWeb.create(projectId as string | null)
})
ipcMain.handle('zero3:gpt-web:show', (event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  return zero3GptWeb.show(zero3GptWebParent(event), {
    id: zero3GptWebId(input),
    bounds: input.bounds
  })
})
ipcMain.handle('zero3:gpt-web:hide', (_event, request: unknown) => zero3GptWeb.hide(zero3GptWebId(request)))
ipcMain.handle('zero3:gpt-web:set-bounds', (_event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  return zero3GptWeb.setBounds(zero3GptWebId(input), input.bounds)
})
ipcMain.handle('zero3:gpt-web:navigate', (_event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  return zero3GptWeb.navigate(zero3GptWebId(input), input.url)
})
ipcMain.handle('zero3:gpt-web:reload', (_event, request: unknown) => zero3GptWeb.reload(zero3GptWebId(request)))
ipcMain.handle('zero3:gpt-web:suspend', (_event, request: unknown) => zero3GptWeb.suspend(zero3GptWebId(request)))
ipcMain.handle('zero3:gpt-web:remove', (_event, request: unknown) => zero3GptWeb.remove(zero3GptWebId(request)))
ipcMain.handle('zero3:gpt-web:open-external', (_event, request: unknown) =>
  zero3GptWeb.openExternal(zero3GptWebId(request))
)
app.on('before-quit', () => zero3GptWeb.stop())
`

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3GptWeb', {
  create: request => ipcRenderer.invoke('zero3:gpt-web:create', request),
  show: request => ipcRenderer.invoke('zero3:gpt-web:show', request),
  hide: request => ipcRenderer.invoke('zero3:gpt-web:hide', request),
  setBounds: request => ipcRenderer.invoke('zero3:gpt-web:set-bounds', request),
  navigate: request => ipcRenderer.invoke('zero3:gpt-web:navigate', request),
  reload: request => ipcRenderer.invoke('zero3:gpt-web:reload', request),
  suspend: request => ipcRenderer.invoke('zero3:gpt-web:suspend', request),
  remove: request => ipcRenderer.invoke('zero3:gpt-web:remove', request),
  openExternal: request => ipcRenderer.invoke('zero3:gpt-web:open-external', request),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('zero3:gpt-web:event', listener)
    return () => ipcRenderer.removeListener('zero3:gpt-web:event', listener)
  }
})

contextBridge.exposeInMainWorld('zero3Workspace', {`

const globalTypeDefinitions = String.raw`
type Zero3GptWebBounds = { x: number; y: number; width: number; height: number }
type Zero3GptWebEvent =
  | {
      kind: 'state'
      entryId: string
      state: 'created' | 'loading' | 'ready' | 'shown' | 'hidden' | 'suspended' | 'error'
      detail?: string
    }
  | {
      kind: 'navigation'
      entryId: string
      currentUrl: string
      conversationUrl: string | null
      pageTitle: string | null
    }
`

const globalWindowSurface = String.raw`    zero3GptWeb: {
      create: (request?: { projectId?: string | null }) => Promise<Zero3WorkspaceEntry>
      show: (request: { id: string; bounds: Zero3GptWebBounds }) => Promise<Zero3WorkspaceEntry>
      hide: (request: { id: string }) => Promise<{ hidden: boolean }>
      setBounds: (request: { id: string; bounds: Zero3GptWebBounds }) => Promise<{ ok: true }>
      navigate: (request: { id: string; url: string }) => Promise<{ url: string }>
      reload: (request: { id: string }) => Promise<{ ok: true }>
      suspend: (request: { id: string }) => Promise<{ suspended: boolean }>
      remove: (request: { id: string }) => Promise<{ removed: boolean }>
      openExternal: (request: { id: string }) => Promise<{ opened: boolean }>
      onEvent: (callback: (event: Zero3GptWebEvent) => void) => () => void
    }
    zero3Workspace: {`

export function applyZero3GptWebProvider() {
  copyRuntimeSources()

  patchFile('electron/main.ts', [
    {
      label: 'GPT Web provider import beside workspace runtime',
      from: "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'",
      to:
        "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'\n" +
        "import { Zero3GptWebProvider } from './zero3/gpt-web/index'"
    },
    {
      label: 'GPT Web provider handlers before Codex singleton',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()',
      to: mainHandlers + '\nconst zero3CodexAppServer = createZero3CodexAppServer()'
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'GPT Web preload surface before workspace surface',
      from: "contextBridge.exposeInMainWorld('zero3Workspace', {",
      to: preloadBridge
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'GPT Web renderer type definitions',
      from: 'type Zero3WorkspaceEntry = {',
      to: globalTypeDefinitions + '\ntype Zero3WorkspaceEntry = {'
    },
    {
      label: 'GPT Web renderer window surface',
      from: '    zero3Workspace: {',
      to: globalWindowSurface
    }
  ])
}

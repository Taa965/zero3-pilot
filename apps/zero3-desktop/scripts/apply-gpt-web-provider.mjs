import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'
import { applyZero3GptWebUi } from './apply-gpt-web-ui.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'

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
    if ((replacement.already && source.includes(replacement.already)) || source.includes(replacement.to)) continue
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
  for (const file of ['gpt-web-types.ts', 'chatgpt-project-catalog.ts', 'chatgpt-project-navigation.ts', 'chatgpt-conversation-name.ts', 'chatgpt-wakeup.ts', 'gpt-web-provider.ts', 'index.ts']) {
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

const zero3GptWeb = new Zero3GptWebProvider(zero3WorkspaceEntries, zero3Projects, broadcastZero3GptWebEvent)

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
ipcMain.handle('zero3:gpt-web:list-remote-projects', event => zero3GptWeb.listRemoteProjects(zero3GptWebParent(event)))
ipcMain.handle('zero3:gpt-web:rename', (_event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  return zero3GptWeb.rename(zero3GptWebId(input), input.title)
})
ipcMain.handle('zero3:gpt-web:set-archived', (_event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  return zero3GptWeb.setArchived(zero3GptWebId(input), input.archived)
})
ipcMain.handle('zero3:gpt-web:show', (event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  return zero3GptWeb.show(zero3GptWebParent(event), {
    id: zero3GptWebId(input),
    bounds: input.bounds
  })
})
ipcMain.handle('zero3:gpt-web:warm', (_event, request: unknown) => zero3GptWeb.warm(zero3GptWebId(request)))
ipcMain.handle('zero3:gpt-web:snapshot', (_event, request: unknown) => zero3GptWeb.snapshot(zero3GptWebId(request)))
ipcMain.handle('zero3:gpt-web:hide', (_event, request: unknown) => zero3GptWeb.hide(zero3GptWebId(request)))
ipcMain.handle('zero3:gpt-web:set-chrome-visible', (_event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  return zero3GptWeb.setChromeVisible(zero3GptWebId(input), input.visible)
})
ipcMain.handle('zero3:gpt-web:toolbar-action', (_event, request: unknown) => {
  const input = zero3GptWebRecord(request)
  return zero3GptWeb.invokeToolbarAction(zero3GptWebId(input), input.action)
})
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
  listRemoteProjects: () => ipcRenderer.invoke('zero3:gpt-web:list-remote-projects'),
  rename: request => ipcRenderer.invoke('zero3:gpt-web:rename', request),
  setArchived: request => ipcRenderer.invoke('zero3:gpt-web:set-archived', request),
  show: request => ipcRenderer.invoke('zero3:gpt-web:show', request),
  warm: request => ipcRenderer.invoke('zero3:gpt-web:warm', request),
  snapshot: request => ipcRenderer.invoke('zero3:gpt-web:snapshot', request),
  hide: request => ipcRenderer.invoke('zero3:gpt-web:hide', request),
  setChromeVisible: request => ipcRenderer.invoke('zero3:gpt-web:set-chrome-visible', request),
  toolbarAction: request => ipcRenderer.invoke('zero3:gpt-web:toolbar-action', request),
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
type Zero3ChatGptRemoteProject = { id: string; name: string; url: string }
type Zero3GptWebBounds = { x: number; y: number; width: number; height: number }
type Zero3GptWebToolbarAction = 'sidebar' | 'new_chat' | 'share' | 'more'
type Zero3GptWebEvent =
  | {
      kind: 'state'
      entryId: string
      state:
        | 'cold'
        | 'warming'
        | 'warm'
        | 'visible'
        | 'created'
        | 'loading'
        | 'ready'
        | 'shown'
        | 'hidden'
        | 'suspended'
        | 'error'
      detail?: string
    }
  | {
      kind: 'navigation'
      entryId: string
      previousEntryId: string | null
      currentUrl: string
      conversationUrl: string | null
      pageTitle: string | null
    }
  | { kind: 'execution'; entryId: string; executing: boolean; health: 'active' | 'idle' | 'stalled' | null; lastProgressAt: number | null; idleForMs: number }
`

const globalWindowSurface = String.raw`    zero3GptWeb: {
      create: (request?: { projectId?: string | null }) => Promise<Zero3WorkspaceEntry>
      listRemoteProjects: () => Promise<Zero3ChatGptRemoteProject[]>
      rename: (request: { id: string; title: string }) => Promise<Zero3WorkspaceEntry>
      setArchived: (request: { id: string; archived: boolean }) => Promise<Zero3WorkspaceEntry>
      show: (request: { id: string; bounds: Zero3GptWebBounds }) => Promise<Zero3WorkspaceEntry>
      warm: (request: { id: string }) => Promise<{ state: 'warming' | 'warm' | 'visible' }>
      snapshot: (request: { id: string }) => Promise<{ dataUrl: string | null }>
      executionStatus: (request: { id: string }) => Promise<{ executing: boolean; health: 'active' | 'idle' | 'stalled' | null; lastProgressAt: number | null; idleForMs: number }>
      hide: (request: { id: string }) => Promise<{ hidden: boolean }>
      setChromeVisible: (request: { id: string; visible: boolean }) => Promise<{ visible: boolean }>
      toolbarAction: (request: { id: string; action: Zero3GptWebToolbarAction }) => Promise<{ action: Zero3GptWebToolbarAction; invoked: true }>
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
      already: "import { Zero3GptWebProvider } from './zero3/gpt-web/index'",
      from: "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'",
      to:
        "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'\n" +
        "import { Zero3GptWebProvider } from './zero3/gpt-web/index'"
    },
    {
      label: 'GPT Web provider handlers before Codex singleton',
      already: 'const zero3GptWeb = new Zero3GptWebProvider',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()',
      to: mainHandlers + '\nconst zero3CodexAppServer = createZero3CodexAppServer()'
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'GPT Web preload surface before workspace surface',
      already: "contextBridge.exposeInMainWorld('zero3GptWeb'",
      from: "contextBridge.exposeInMainWorld('zero3Workspace', {",
      to: preloadBridge
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'GPT Web renderer type definitions',
      already: 'type Zero3GptWebEvent =',
      from: 'type Zero3WorkspaceEntry = Zero3GptWebWorkspaceEntry | Zero3GeminiWebWorkspaceEntry',
      to:
        globalTypeDefinitions +
        '\ntype Zero3WorkspaceEntry = Zero3GptWebWorkspaceEntry | Zero3GeminiWebWorkspaceEntry'
    },
    {
      label: 'GPT Web renderer window surface',
      already: '    zero3GptWeb: {',
      from: '    zero3Workspace: {',
      to: globalWindowSurface
    }
  ])


  // Upgrade an already-prepared pinned Hermes tree in place. The main overlay
  // is intentionally rerunnable during development, so changing the generated
  // bridge must not duplicate the entire provider block on the next prepare.
  patchFile('electron/main.ts', [{
    label: 'GPT Web promoted toolbar IPC handler',
    already: "ipcMain.handle('zero3:gpt-web:toolbar-action'",
    from: "ipcMain.handle('zero3:gpt-web:set-bounds', (_event, request: unknown) => {",
    to: "ipcMain.handle('zero3:gpt-web:toolbar-action', (_event, request: unknown) => {\n  const input = zero3GptWebRecord(request)\n  return zero3GptWeb.invokeToolbarAction(zero3GptWebId(input), input.action)\n})\nipcMain.handle('zero3:gpt-web:set-bounds', (_event, request: unknown) => {"
  }])
  patchFile('electron/preload.ts', [{
    label: 'GPT Web promoted toolbar preload method',
    already: "  toolbarAction: request => ipcRenderer.invoke('zero3:gpt-web:toolbar-action'",
    from: "  setBounds: request => ipcRenderer.invoke('zero3:gpt-web:set-bounds', request),",
    to: "  toolbarAction: request => ipcRenderer.invoke('zero3:gpt-web:toolbar-action', request),\n  setBounds: request => ipcRenderer.invoke('zero3:gpt-web:set-bounds', request),"
  }])
  patchFile('src/global.d.ts', [
    {
      label: 'GPT Web promoted toolbar action type',
      already: 'type Zero3GptWebToolbarAction =',
      from: 'type Zero3GptWebBounds = { x: number; y: number; width: number; height: number }',
      to: "type Zero3GptWebBounds = { x: number; y: number; width: number; height: number }\ntype Zero3GptWebToolbarAction = 'sidebar' | 'new_chat' | 'share' | 'more'"
    },
    {
      label: 'GPT Web promoted toolbar renderer method',
      already: '      toolbarAction: (request:',
      from: '      setBounds: (request: { id: string; bounds: Zero3GptWebBounds }) => Promise<{ ok: true }>',
      to: '      toolbarAction: (request: { id: string; action: Zero3GptWebToolbarAction }) => Promise<{ action: Zero3GptWebToolbarAction; invoked: true }>\n      setBounds: (request: { id: string; bounds: Zero3GptWebBounds }) => Promise<{ ok: true }>'
    }
  ])
  patchFile('electron/main.ts', [
    {
      label: 'GPT Web warm/snapshot IPC handlers',
      already: "ipcMain.handle('zero3:gpt-web:warm'",
      from: "ipcMain.handle('zero3:gpt-web:hide', (_event, request: unknown) => zero3GptWeb.hide(zero3GptWebId(request)))",
      to:
        "ipcMain.handle('zero3:gpt-web:warm', (_event, request: unknown) => zero3GptWeb.warm(zero3GptWebId(request)))\n" +
        "ipcMain.handle('zero3:gpt-web:snapshot', (_event, request: unknown) => zero3GptWeb.snapshot(zero3GptWebId(request)))\n" +
        "ipcMain.handle('zero3:gpt-web:hide', (_event, request: unknown) => zero3GptWeb.hide(zero3GptWebId(request)))"
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'GPT Web warm/snapshot preload methods',
      already: "  warm: request => ipcRenderer.invoke('zero3:gpt-web:warm'",
      from: "  hide: request => ipcRenderer.invoke('zero3:gpt-web:hide', request),",
      to:
        "  warm: request => ipcRenderer.invoke('zero3:gpt-web:warm', request),\n" +
        "  snapshot: request => ipcRenderer.invoke('zero3:gpt-web:snapshot', request),\n" +
        "  hide: request => ipcRenderer.invoke('zero3:gpt-web:hide', request),"
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'GPT Web lifecycle state expansion',
      already: "        | 'cold'",
      from: "      state: 'created' | 'loading' | 'ready' | 'shown' | 'hidden' | 'suspended' | 'error'",
      to:
        "      state:\n" +
        "        | 'cold'\n" +
        "        | 'warming'\n" +
        "        | 'warm'\n" +
        "        | 'visible'\n" +
        "        | 'created'\n" +
        "        | 'loading'\n" +
        "        | 'ready'\n" +
        "        | 'shown'\n" +
        "        | 'hidden'\n" +
        "        | 'suspended'\n" +
        "        | 'error'"
    },
    {
      label: 'GPT Web warm/snapshot renderer methods',
      already: '      snapshot: (request: { id: string }) => Promise<{ dataUrl: string | null }>',
      from: "      show: (request: { id: string; bounds: Zero3GptWebBounds }) => Promise<Zero3WorkspaceEntry>\n" +
        "      hide: (request: { id: string }) => Promise<{ hidden: boolean }>",
      to:
        "      show: (request: { id: string; bounds: Zero3GptWebBounds }) => Promise<Zero3WorkspaceEntry>\n" +
        "      warm: (request: { id: string }) => Promise<{ state: 'warming' | 'warm' | 'visible' }>\n" +
        "      snapshot: (request: { id: string }) => Promise<{ dataUrl: string | null }>\n" +
        "      hide: (request: { id: string }) => Promise<{ hidden: boolean }>"
    }
  ])

  patchFile('electron/main.ts', [{
    label: 'GPT Web authenticated project-list parent window',
    already: "zero3GptWeb.listRemoteProjects(zero3GptWebParent(event))",
    from: "ipcMain.handle('zero3:gpt-web:list-remote-projects', () => zero3GptWeb.listRemoteProjects())",
    to: "ipcMain.handle('zero3:gpt-web:list-remote-projects', event => zero3GptWeb.listRemoteProjects(zero3GptWebParent(event)))"
  }])

  patchFile('electron/main.ts', [{
    label: 'GPT Web verified rename handler',
    already: "ipcMain.handle('zero3:gpt-web:rename'",
    from: "ipcMain.handle('zero3:gpt-web:list-remote-projects', event => zero3GptWeb.listRemoteProjects(zero3GptWebParent(event)))",
    to: "ipcMain.handle('zero3:gpt-web:list-remote-projects', event => zero3GptWeb.listRemoteProjects(zero3GptWebParent(event)))\nipcMain.handle('zero3:gpt-web:rename', (_event, request: unknown) => {\n  const input = zero3GptWebRecord(request)\n  return zero3GptWeb.rename(zero3GptWebId(input), input.title)\n})"
  }])
  patchFile('electron/preload.ts', [{
    label: 'GPT Web rename preload method',
    already: "  rename: request => ipcRenderer.invoke('zero3:gpt-web:rename'",
    from: "  listRemoteProjects: () => ipcRenderer.invoke('zero3:gpt-web:list-remote-projects'),",
    to: "  listRemoteProjects: () => ipcRenderer.invoke('zero3:gpt-web:list-remote-projects'),\n  rename: request => ipcRenderer.invoke('zero3:gpt-web:rename', request),"
  }])
  patchFile('src/global.d.ts', [{
    label: 'GPT Web rename renderer method',
    from: '      listRemoteProjects: () => Promise<Zero3ChatGptRemoteProject[]>',
    to: '      listRemoteProjects: () => Promise<Zero3ChatGptRemoteProject[]>\n      rename: (request: { id: string; title: string }) => Promise<Zero3WorkspaceEntry>'
  }])

  patchFile('electron/main.ts', [{
    label: 'GPT Web execution status IPC handler',
    from: "ipcMain.handle('zero3:gpt-web:hide', (_event, request: unknown) => zero3GptWeb.hide(zero3GptWebId(request)))",
    to: "ipcMain.handle('zero3:gpt-web:execution-status', (_event, request: unknown) => zero3GptWeb.executionStatus(zero3GptWebId(request)))\n" +
      "ipcMain.handle('zero3:gpt-web:hide', (_event, request: unknown) => zero3GptWeb.hide(zero3GptWebId(request)))"
  }])

  patchFile('electron/preload.ts', [{
    label: 'GPT Web execution status preload method',
    from: "  hide: request => ipcRenderer.invoke('zero3:gpt-web:hide', request),",
    to: "  executionStatus: request => ipcRenderer.invoke('zero3:gpt-web:execution-status', request),\n" +
      "  hide: request => ipcRenderer.invoke('zero3:gpt-web:hide', request),"
  }])
  patchFile('src/global.d.ts', [{
    label: 'GPT Web execution event health fields',
    already: "health: 'active' | 'idle' | 'stalled' | null",
    from: "  | { kind: 'execution'; entryId: string; executing: boolean }",
    to: "  | { kind: 'execution'; entryId: string; executing: boolean; health: 'active' | 'idle' | 'stalled' | null; lastProgressAt: number | null; idleForMs: number }"
  }])
  patchFile('src/global.d.ts', [{
    label: 'GPT Web execution status renderer method',
    already: "executionStatus: (request: { id: string }) => Promise<{ executing: boolean; health:",
    from: "      executionStatus: (request: { id: string }) => Promise<{ executing: boolean }>",
    to: "      executionStatus: (request: { id: string }) => Promise<{ executing: boolean; health: 'active' | 'idle' | 'stalled' | null; lastProgressAt: number | null; idleForMs: number }>"
  }])

  applyZero3GptWebUi()
  applyZero3ProjectContextMcp()
}

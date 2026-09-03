import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const executorSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'executor-runtime')
const groupSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'group-runtime')
const rendererSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'renderer', 'development-group')
const electronZero3 = path.join(hermesDesktopDir, 'electron', 'zero3')
const rendererTarget = path.join(hermesDesktopDir, 'src', 'zero3', 'development-group')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function copyProductionTree(source, target) {
  if (!fs.statSync(source).isDirectory()) throw new Error(`Development Group source directory missing: ${source}`)
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyProductionTree(from, to)
    else if (entry.isFile() && /\.(ts|tsx)$/u.test(entry.name)) write(to, read(from))
  }
}

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Development Group overlay drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the pinned Hermes/Codex desktop boundary before updating the upstream pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

const mainRuntime = String.raw`
const zero3DevelopmentGroups = new DevelopmentGroupProductService(
  app.getPath('userData') + '/development-groups',
  zero3CodexAppServer
)

zero3DevelopmentGroups.subscribe(event => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('zero3:development-groups:event', event)
    }
  }
})

ipcMain.handle('zero3:development-groups:list', () => zero3DevelopmentGroups.list())
ipcMain.handle('zero3:development-groups:get', (_event, groupId: string) => zero3DevelopmentGroups.get(groupId))
ipcMain.handle('zero3:development-groups:create', (_event, request: unknown) => zero3DevelopmentGroups.create(request as never))
ipcMain.handle('zero3:development-groups:session:start', (_event, request: { groupId: string; sessionId: string }) =>
  zero3DevelopmentGroups.startSession(request.groupId, request.sessionId)
)
ipcMain.handle('zero3:development-groups:session:retry', (_event, request: { groupId: string; sessionId: string }) =>
  zero3DevelopmentGroups.retrySession(request.groupId, request.sessionId)
)
ipcMain.handle('zero3:development-groups:session:permission', (_event, request: { groupId: string; sessionId: string; response: never }) =>
  zero3DevelopmentGroups.respondPermission(request.groupId, request.sessionId, request.response)
)
ipcMain.handle('zero3:development-groups:session:cancel', (_event, request: { groupId: string; sessionId: string }) =>
  zero3DevelopmentGroups.cancelSession(request.groupId, request.sessionId)
)
ipcMain.handle('zero3:development-groups:delivery:finalize', (_event, request: unknown) =>
  zero3DevelopmentGroups.finalizeDelivery(request as never)
)
ipcMain.handle('zero3:development-groups:integrate', (_event, groupId: string) => zero3DevelopmentGroups.integrate(groupId))
ipcMain.handle('zero3:development-groups:verify', (_event, groupId: string) => zero3DevelopmentGroups.verify(groupId))
`

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3DevelopmentGroups', {
  list: () => ipcRenderer.invoke('zero3:development-groups:list'),
  get: groupId => ipcRenderer.invoke('zero3:development-groups:get', groupId),
  create: request => ipcRenderer.invoke('zero3:development-groups:create', request),
  startSession: request => ipcRenderer.invoke('zero3:development-groups:session:start', request),
  retrySession: request => ipcRenderer.invoke('zero3:development-groups:session:retry', request),
  respondPermission: request => ipcRenderer.invoke('zero3:development-groups:session:permission', request),
  cancelSession: request => ipcRenderer.invoke('zero3:development-groups:session:cancel', request),
  finalizeDelivery: request => ipcRenderer.invoke('zero3:development-groups:delivery:finalize', request),
  integrate: groupId => ipcRenderer.invoke('zero3:development-groups:integrate', groupId),
  verify: groupId => ipcRenderer.invoke('zero3:development-groups:verify', groupId),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('zero3:development-groups:event', listener)
    return () => ipcRenderer.removeListener('zero3:development-groups:event', listener)
  }
})

contextBridge.exposeInMainWorld('hermesDesktop', {`

const globalBridge = String.raw`    zero3DevelopmentGroups: {
      list: () => Promise<any[]>
      get: (groupId: string) => Promise<any>
      create: (request: any) => Promise<any>
      startSession: (request: { groupId: string; sessionId: string }) => Promise<any>
      retrySession: (request: { groupId: string; sessionId: string }) => Promise<any>
      respondPermission: (request: { groupId: string; sessionId: string; response: { requestId: string; decision: 'approve_once' | 'approve_session' | 'deny' } }) => Promise<void>
      cancelSession: (request: { groupId: string; sessionId: string }) => Promise<void>
      finalizeDelivery: (request: { groupId: string; sessionId: string; testsAdded?: string[]; testsExecuted?: string[]; artifacts?: string[]; knownIssues?: string[]; downstreamNotes?: string[] }) => Promise<{ accepted: boolean; gate: { decision: string; reasons: string[] }; handoffCheckpointHash?: string }>
      integrate: (groupId: string) => Promise<any[]>
      verify: (groupId: string) => Promise<any>
      onEvent: (callback: (event: any) => void) => () => void
    }
    hermesDesktop:`

export function applyZero3DevelopmentGroupRuntime() {
  copyProductionTree(executorSource, path.join(electronZero3, 'executor-runtime'))
  copyProductionTree(groupSource, path.join(electronZero3, 'group-runtime'))
  copyProductionTree(rendererSource, rendererTarget)

  patchFile('electron/main.ts', [
    {
      label: 'end of Electron import block',
      from: "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR",
      to: "import { DevelopmentGroupProductService } from './zero3/group-runtime/runtime/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
    },
    {
      label: 'Codex app-server singleton',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()\n',
      to: 'const zero3CodexAppServer = createZero3CodexAppServer()\n' + mainRuntime
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'desktop preload bridge',
      from: "contextBridge.exposeInMainWorld('hermesDesktop', {",
      to: preloadBridge
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Window hermesDesktop type boundary',
      from: '    hermesDesktop:',
      to: globalBridge
    }
  ])

  patchFile('src/app/contrib/wiring.tsx', [
    {
      label: 'Contrib wiring imports',
      from: "import { ContribWiringContext } from './context'",
      to: "import '@/zero3/development-group/register'\n\nimport { ContribWiringContext } from './context'"
    }
  ])
}

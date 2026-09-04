import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const executorSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'executor-runtime')
const groupSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'group-runtime')
const electronZero3 = path.join(hermesDesktopDir, 'electron', 'zero3')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function normalizeRelativeTypeScriptSpecifiers(source) {
  return source.replace(/(['"])(\.\.?\/[^'"\r\n]+)\.(?:ts|tsx)\1/gu, '$1$2$1')
}

function copyProductionTree(source, target) {
  if (!fs.statSync(source).isDirectory()) throw new Error(`Development Group authority source directory missing: ${source}`)
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyProductionTree(from, to)
    else if (entry.isFile() && /\.(ts|tsx)$/u.test(entry.name)) write(to, normalizeRelativeTypeScriptSpecifiers(read(from)))
  }
}

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Development Group desktop bridge drift in ${relativePath}: missing ${replacement.label}. ` +
        'Review the pinned Hermes/Codex boundary before updating the upstream pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

const mainRuntime = String.raw`const zero3DevelopmentGroupRuntime = createDevelopmentGroupDesktopRuntime(
  app.getPath('userData') + '/development-groups',
  zero3CodexAppServer
)
const disposeZero3DevelopmentGroupIpc = registerDevelopmentGroupDesktopIpc(zero3DevelopmentGroupRuntime)
app.on('before-quit', () => disposeZero3DevelopmentGroupIpc())
`

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3DevelopmentGroup', {
  listGroups: () => ipcRenderer.invoke('zero3:development-group:list'),
  getGroup: groupId => ipcRenderer.invoke('zero3:development-group:get', groupId),
  createGroup: (request, proposal) => ipcRenderer.invoke('zero3:development-group:create', request, proposal),
  startWave: (groupId, waveId) => ipcRenderer.invoke('zero3:development-group:start-wave', groupId, waveId),
  retrySession: (groupId, sessionId) => ipcRenderer.invoke('zero3:development-group:retry-session', groupId, sessionId),
  respondPermission: (groupId, sessionId, response) => ipcRenderer.invoke('zero3:development-group:respond-permission', groupId, sessionId, response),
  cancelSession: (groupId, sessionId) => ipcRenderer.invoke('zero3:development-group:cancel-session', groupId, sessionId),
  resolveOutcomeUnknown: (groupId, sessionId, resolution, evidence) => ipcRenderer.invoke('zero3:development-group:resolve-outcome-unknown', groupId, sessionId, resolution, evidence),
  integrateDelivery: (groupId, sessionId) => ipcRenderer.invoke('zero3:development-group:integrate-delivery', groupId, sessionId),
  runVerification: groupId => ipcRenderer.invoke('zero3:development-group:run-verification', groupId),
  getCompletionProof: groupId => ipcRenderer.invoke('zero3:development-group:completion-proof', groupId),
  completeGroup: groupId => ipcRenderer.invoke('zero3:development-group:complete', groupId)
})

contextBridge.exposeInMainWorld('hermesDesktop', {`

const globalBridge = String.raw`  interface Window {
    zero3DevelopmentGroup: {
      listGroups: () => Promise<unknown>
      getGroup: (groupId: string) => Promise<unknown>
      createGroup: (request: Record<string, unknown>, proposal: Record<string, unknown>) => Promise<unknown>
      startWave: (groupId: string, waveId: string) => Promise<unknown>
      retrySession: (groupId: string, sessionId: string) => Promise<unknown>
      respondPermission: (groupId: string, sessionId: string, response: { requestId: string; decision: 'approve_once' | 'approve_session' | 'deny' }) => Promise<void>
      cancelSession: (groupId: string, sessionId: string) => Promise<void>
      resolveOutcomeUnknown: (groupId: string, sessionId: string, resolution: 'failed' | 'cancelled' | 'superseded', evidence: string) => Promise<unknown>
      integrateDelivery: (groupId: string, sessionId: string) => Promise<unknown>
      runVerification: (groupId: string) => Promise<unknown>
      getCompletionProof: (groupId: string) => Promise<unknown>
      completeGroup: (groupId: string) => Promise<unknown>
    }
    hermesDesktop: {`

export function applyDevelopmentGroupBridge() {
  copyProductionTree(executorSource, path.join(electronZero3, 'executor-runtime'))
  copyProductionTree(groupSource, path.join(electronZero3, 'group-runtime'))

  patchFile('electron/main.ts', [
    {
      label: 'Development Group runtime import boundary',
      from: "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR",
      to: "import { createDevelopmentGroupDesktopRuntime, registerDevelopmentGroupDesktopIpc } from './zero3/group-runtime/desktop/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
    },
    {
      label: 'single pinned Codex app-server composition boundary',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()\n',
      to: 'const zero3CodexAppServer = createZero3CodexAppServer()\n' + mainRuntime
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'Development Group explicit preload API',
      from: "contextBridge.exposeInMainWorld('hermesDesktop', {",
      to: preloadBridge
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'Development Group renderer bridge types',
      from: `  interface Window {
    hermesDesktop: {`,
      to: globalBridge
    }
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  applyDevelopmentGroupBridge()
}

import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'workspace-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'workspace')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 workspace-entry overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function copyRuntimeSources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['workspace-entry-types.ts', 'workspace-entry-store.ts', 'index.ts']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 workspace runtime source template missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

const mainHandlers = String.raw`
const zero3WorkspaceEntries = new Zero3WorkspaceEntryStore(
  path.join(app.getPath('userData'), 'zero3', 'workspace-entries-v1.json')
)

function zero3WorkspaceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function zero3WorkspaceRequestId(value: unknown): string {
  const id = zero3WorkspaceRecord(value).id
  if (typeof id !== 'string' || !id.trim() || id.trim().length > 256) throw new Error('workspace entry id is required and must be at most 256 characters')
  return id.trim()
}
function zero3WorkspaceProjectId(input: Record<string, unknown>): string | null {
  const projectId = input.projectId == null ? null : input.projectId
  if (projectId != null && typeof projectId !== 'string') throw new Error('projectId must be a string or null')
  return projectId as string | null
}

ipcMain.handle('zero3:workspace:list', () => zero3WorkspaceEntries.list())
ipcMain.handle('zero3:workspace:get', (_event, request: unknown) => zero3WorkspaceEntries.get(zero3WorkspaceRequestId(request)))
ipcMain.handle('zero3:workspace:gpt-web:create', (_event, request: unknown) => {
  const input = zero3WorkspaceRecord(request)
  return zero3WorkspaceEntries.createGptWeb({ projectId: zero3WorkspaceProjectId(input) })
})
ipcMain.handle('zero3:workspace:gemini-web:create', (_event, request: unknown) => {
  const input = zero3WorkspaceRecord(request)
  const logicalSessionId = input.logicalSessionId == null ? null : input.logicalSessionId
  if (logicalSessionId != null && typeof logicalSessionId !== 'string') throw new Error('logicalSessionId must be a string or null')
  return zero3WorkspaceEntries.createGeminiWeb({
    projectId: zero3WorkspaceProjectId(input),
    logicalSessionId: logicalSessionId as string | null
  })
})
ipcMain.handle('zero3:workspace:rename', (_event, request: unknown) => {
  const input = zero3WorkspaceRecord(request)
  const id = zero3WorkspaceRequestId(input)
  const title = input.title == null ? null : input.title
  if (title != null && typeof title !== 'string') throw new Error('title must be a string or null')
  return zero3WorkspaceEntries.rename({ id, title: title as string | null })
})
ipcMain.handle('zero3:workspace:set-project', (_event, request: unknown) => {
  const input = zero3WorkspaceRecord(request)
  return zero3WorkspaceEntries.setProject({
    id: zero3WorkspaceRequestId(input),
    projectId: zero3WorkspaceProjectId(input)
  })
})
ipcMain.handle('zero3:workspace:remove', (_event, request: unknown) => zero3WorkspaceEntries.remove(zero3WorkspaceRequestId(request)))
`

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3Workspace', {
  list: () => ipcRenderer.invoke('zero3:workspace:list'),
  get: request => ipcRenderer.invoke('zero3:workspace:get', request),
  createGptWeb: request => ipcRenderer.invoke('zero3:workspace:gpt-web:create', request),
  createGeminiWeb: request => ipcRenderer.invoke('zero3:workspace:gemini-web:create', request),
  rename: request => ipcRenderer.invoke('zero3:workspace:rename', request),
  setProject: request => ipcRenderer.invoke('zero3:workspace:set-project', request),
  remove: request => ipcRenderer.invoke('zero3:workspace:remove', request)
})

contextBridge.exposeInMainWorld('zero3Codex', {`

const globalTypeDefinitions = String.raw`
type Zero3GptWebWorkspaceEntry = {
  id: string
  kind: 'gpt_web'
  projectId: string | null
  browserProfileId: string
  conversationUrl: string | null
  currentUrl: string
  pageTitle: string | null
  localDisplayTitle: string | null
  createdAt: string
  lastActiveAt: string
}
type Zero3GeminiWebWorkspaceEntry = {
  id: string
  kind: 'gemini_web'
  logicalSessionId: string
  projectId: string | null
  browserProfileId: string
  conversationUrl: string | null
  currentUrl: string
  pageTitle: string | null
  localDisplayTitle: string | null
  createdAt: string
  lastActiveAt: string
}
type Zero3WorkspaceEntry = Zero3GptWebWorkspaceEntry | Zero3GeminiWebWorkspaceEntry
`

const globalWindowSurface = String.raw`    zero3Workspace: {
      list: () => Promise<Zero3WorkspaceEntry[]>
      get: (request: { id: string }) => Promise<Zero3WorkspaceEntry | null>
      createGptWeb: (request?: { projectId?: string | null }) => Promise<Zero3GptWebWorkspaceEntry>
      createGeminiWeb: (request?: { projectId?: string | null; logicalSessionId?: string | null }) => Promise<Zero3GeminiWebWorkspaceEntry>
      rename: (request: { id: string; title: string | null }) => Promise<Zero3WorkspaceEntry>
      setProject: (request: { id: string; projectId: string | null }) => Promise<Zero3WorkspaceEntry>
      remove: (request: { id: string }) => Promise<{ removed: boolean }>
    }
    zero3Codex: {`

export function applyZero3WorkspaceEntryRuntime() {
  copyRuntimeSources()
  patchFile('electron/main.ts', [
    { label: 'workspace runtime import before user-data override', from: 'const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR', to: "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR" },
    { label: 'workspace registry before Codex app-server singleton', from: 'const zero3CodexAppServer = createZero3CodexAppServer()', to: mainHandlers + '\nconst zero3CodexAppServer = createZero3CodexAppServer()' }
  ])
  patchFile('electron/preload.ts', [{ label: 'workspace preload surface before Codex surface', from: "contextBridge.exposeInMainWorld('zero3Codex', {", to: preloadBridge }])
  patchFile('src/global.d.ts', [
    { label: 'workspace renderer type definitions', from: 'type Zero3CodexStatus = {', to: globalTypeDefinitions + '\ntype Zero3CodexStatus = {' },
    { label: 'workspace renderer window surface', from: '    zero3Codex: {', to: globalWindowSurface }
  ])
}

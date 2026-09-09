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
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 project-store overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}
function copyProjectRuntimeSources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['atomic-file.ts', 'project-types.ts', 'project-store.ts']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 project runtime source template missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
  const indexFile = path.join(targetDir, 'index.ts')
  let index = read(indexFile)
  for (const line of ["export * from './project-store'", "export * from './project-types'"]) if (!index.includes(line)) index = `${line}\n${index}`
  write(indexFile, index)
}
const mainHandlers = String.raw`
const zero3Projects = new Zero3ProjectStore(path.join(app.getPath('userData'), 'zero3', 'projects.json'))
function zero3ProjectRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function zero3ProjectRequestId(value: unknown): string { const id = zero3ProjectRecord(value).id; if (typeof id !== 'string' || !id.trim() || id.trim().length > 256) throw new Error('project id is required and must be at most 256 characters'); return id.trim() }
ipcMain.handle('zero3:project:list', () => zero3Projects.list())
ipcMain.handle('zero3:project:get', (_event, request: unknown) => zero3Projects.get(zero3ProjectRequestId(request)))
ipcMain.handle('zero3:project:create', (_event, request: unknown) => { const input = zero3ProjectRecord(request); if (typeof input.name !== 'string') throw new Error('project name is required'); if (typeof input.rootPath !== 'string') throw new Error('project rootPath is required'); return zero3Projects.create({ name: input.name, rootPath: input.rootPath }) })
ipcMain.handle('zero3:project:update', (_event, request: unknown) => { const input = zero3ProjectRecord(request); const id = zero3ProjectRequestId(input); if (input.name !== undefined && typeof input.name !== 'string') throw new Error('project name must be a string'); if (input.chatGptProjectUrl !== undefined && input.chatGptProjectUrl !== null && typeof input.chatGptProjectUrl !== 'string') throw new Error('project chatGptProjectUrl must be a string or null'); return zero3Projects.update({ id, ...(input.name !== undefined ? { name: input.name as string } : {}), ...(input.chatGptProjectUrl !== undefined ? { chatGptProjectUrl: input.chatGptProjectUrl as string | null } : {}) }) })
ipcMain.handle('zero3:project:remove', (_event, request: unknown) => zero3Projects.remove(zero3ProjectRequestId(request)))
ipcMain.handle('zero3:project:pickDirectory', async () => { const response = await dialog.showOpenDialog({ properties: ['openDirectory'] }); if (response.canceled || response.filePaths.length === 0) return null; return response.filePaths[0] ?? null })
`
const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3Project', {
  list: () => ipcRenderer.invoke('zero3:project:list'), get: request => ipcRenderer.invoke('zero3:project:get', request),
  create: request => ipcRenderer.invoke('zero3:project:create', request), update: request => ipcRenderer.invoke('zero3:project:update', request),
  remove: request => ipcRenderer.invoke('zero3:project:remove', request), pickDirectory: () => ipcRenderer.invoke('zero3:project:pickDirectory')
})

contextBridge.exposeInMainWorld('zero3Workspace', {`
const globalTypeDefinitions = String.raw`
type Zero3Project = { id: string; name: string; rootPath: string; chatGptProjectUrl: string | null; createdAt: string; lastActiveAt: string }
`
const globalWindowSurface = String.raw`    zero3Project: {
      list: () => Promise<Zero3Project[]>; get: (request: { id: string }) => Promise<Zero3Project | null>
      create: (request: { name: string; rootPath: string }) => Promise<Zero3Project>
      update: (request: { id: string; name?: string; chatGptProjectUrl?: string | null }) => Promise<Zero3Project>
      remove: (request: { id: string }) => Promise<{ removed: boolean }>; pickDirectory: () => Promise<string | null>
    }
    zero3Workspace: {`
export function applyZero3ProjectStore() {
  copyProjectRuntimeSources()
  patchFile('electron/main.ts', [
    { label: 'project store import beside workspace store', appliedMarker: "import { Zero3ProjectStore } from './zero3/workspace/index'", from: "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'", to: "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'\nimport { Zero3ProjectStore } from './zero3/workspace/index'" },
    { label: 'project handlers before Codex app-server singleton', appliedMarker: "ipcMain.handle('zero3:project:list'", from: 'const zero3CodexAppServer = createZero3CodexAppServer()', to: mainHandlers + '\nconst zero3CodexAppServer = createZero3CodexAppServer()' }
  ])
  patchFile('electron/preload.ts', [{ label: 'project preload surface before workspace surface', appliedMarker: "contextBridge.exposeInMainWorld('zero3Project'", from: "contextBridge.exposeInMainWorld('zero3Workspace', {", to: preloadBridge }])
  patchFile('src/global.d.ts', [
    { label: 'project renderer type definitions', appliedMarker: 'type Zero3Project = {', from: 'type Zero3GptWebWorkspaceEntry = {', to: globalTypeDefinitions + '\ntype Zero3GptWebWorkspaceEntry = {' },
    { label: 'project renderer window surface', appliedMarker: '    zero3Project: {', from: '    zero3Workspace: {', to: globalWindowSurface }
  ])
}

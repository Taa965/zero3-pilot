import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'project-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'projects')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 project-runtime overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function stageSources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['project-types.ts', 'project-store.ts', 'index.ts']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 project runtime source missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

const mainHandlers = String.raw`
const zero3ProjectStore = new Zero3ProjectStore(
  path.join(app.getPath('userData'), 'zero3', 'projects-v1.json')
)

function zero3ProjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

ipcMain.handle('zero3:projects:list', () => zero3ProjectStore.list())
ipcMain.handle('zero3:projects:get', (_event, request: unknown) => {
  const input = zero3ProjectRecord(request)
  return zero3ProjectStore.get(input.id)
})
ipcMain.handle('zero3:projects:active:get', () => zero3ProjectStore.getActive())
ipcMain.handle('zero3:projects:create', (_event, request: unknown) => {
  const input = zero3ProjectRecord(request)
  return zero3ProjectStore.create({
    id: input.id as string,
    name: input.name as string,
    repositoryPath: input.repositoryPath as string,
    defaultWorktreePath: input.defaultWorktreePath as string | null | undefined,
    defaultBranch: input.defaultBranch as string | null | undefined,
    baseRef: input.baseRef as string | null | undefined,
    contextSummary: input.contextSummary as string | null | undefined
  })
})
ipcMain.handle('zero3:projects:update', (_event, request: unknown) => {
  const input = zero3ProjectRecord(request)
  return zero3ProjectStore.update({
    id: input.id as string,
    ...(Object.prototype.hasOwnProperty.call(input, 'name') ? { name: input.name as string } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'repositoryPath') ? { repositoryPath: input.repositoryPath as string } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'defaultWorktreePath') ? { defaultWorktreePath: input.defaultWorktreePath as string | null } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'defaultBranch') ? { defaultBranch: input.defaultBranch as string | null } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'baseRef') ? { baseRef: input.baseRef as string | null } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'contextSummary') ? { contextSummary: input.contextSummary as string | null } : {})
  })
})
ipcMain.handle('zero3:projects:remove', (_event, request: unknown) => {
  const input = zero3ProjectRecord(request)
  return zero3ProjectStore.remove(input.id)
})
ipcMain.handle('zero3:projects:active:set', (_event, request: unknown) => {
  const input = zero3ProjectRecord(request)
  return zero3ProjectStore.setActive(input.id)
})
`

const preloadSurface = String.raw`contextBridge.exposeInMainWorld('zero3Projects', {
  list: () => ipcRenderer.invoke('zero3:projects:list'),
  get: request => ipcRenderer.invoke('zero3:projects:get', request),
  getActive: () => ipcRenderer.invoke('zero3:projects:active:get'),
  create: request => ipcRenderer.invoke('zero3:projects:create', request),
  update: request => ipcRenderer.invoke('zero3:projects:update', request),
  remove: request => ipcRenderer.invoke('zero3:projects:remove', request),
  setActive: request => ipcRenderer.invoke('zero3:projects:active:set', request)
})

contextBridge.exposeInMainWorld('zero3Workspace', {`

const globalTypes = String.raw`
type Zero3Project = {
  id: string
  name: string
  repositoryPath: string
  defaultWorktreePath: string | null
  defaultBranch: string | null
  baseRef: string | null
  contextSummary: string | null
  createdAt: string
  updatedAt: string
}
type Zero3CreateProjectRequest = {
  id: string
  name: string
  repositoryPath: string
  defaultWorktreePath?: string | null
  defaultBranch?: string | null
  baseRef?: string | null
  contextSummary?: string | null
}
type Zero3UpdateProjectRequest = Partial<Omit<Zero3CreateProjectRequest, 'id'>> & { id: string }
`

const globalSurface = String.raw`    zero3Projects: {
      list: () => Promise<Zero3Project[]>
      get: (request: { id: string }) => Promise<Zero3Project | null>
      getActive: () => Promise<Zero3Project | null>
      create: (request: Zero3CreateProjectRequest) => Promise<Zero3Project>
      update: (request: Zero3UpdateProjectRequest) => Promise<Zero3Project>
      remove: (request: { id: string }) => Promise<{ removed: boolean; activeProjectId: string | null }>
      setActive: (request: { id: string }) => Promise<Zero3Project>
    }
    zero3Workspace: {`

export function applyZero3ProjectRuntime() {
  stageSources()
  patchFile('electron/main.ts', [
    {
      label: 'project store import beside workspace store',
      from: "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'",
      to: "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'\nimport { Zero3ProjectStore } from './zero3/projects/index'"
    },
    {
      label: 'project registry before workspace registry',
      appliedMarker: 'const zero3ProjectStore = new Zero3ProjectStore(',
      from: 'const zero3WorkspaceEntries = new Zero3WorkspaceEntryStore(',
      to: mainHandlers + '\nconst zero3WorkspaceEntries = new Zero3WorkspaceEntryStore('
    }
  ])
  patchFile('electron/preload.ts', [
    {
      label: 'project preload before workspace preload',
      from: "contextBridge.exposeInMainWorld('zero3Workspace', {",
      to: preloadSurface
    }
  ])
  patchFile('src/global.d.ts', [
    {
      label: 'project renderer types before workspace types',
      from: 'type Zero3GptWebWorkspaceEntry = {',
      to: globalTypes + '\ntype Zero3GptWebWorkspaceEntry = {'
    },
    {
      label: 'project renderer surface before workspace surface',
      from: '    zero3Workspace: {',
      to: globalSurface
    }
  ])
  console.log('Zero3 project registry staged: active project, repository/worktree defaults and project context metadata are available through a typed renderer bridge.')
}

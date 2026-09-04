import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'control-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'control')

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
      throw new Error(`Zero3 control overlay drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function copySources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['control-client.ts', 'index.ts']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 control runtime source missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

const mainSurface = String.raw`
const zero3Control = new Zero3ControlClient()

ipcMain.handle('zero3:control:status', () => zero3Control.status())
ipcMain.handle('zero3:control:task:list', () => zero3Control.listTasks())
ipcMain.handle('zero3:control:task:get', (_event, request: unknown) => {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? (request as Record<string, unknown>) : {}
  return zero3Control.getTask(input.taskId)
})
ipcMain.handle('zero3:control:task:extension:get', (_event, request: unknown) => {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? (request as Record<string, unknown>) : {}
  return zero3Control.getTaskExtension(input.taskId)
})
ipcMain.handle('zero3:control:task:dispatch-codex', (_event, request: unknown) => zero3Control.dispatchCodex(request))
`

const preloadSurface = String.raw`contextBridge.exposeInMainWorld('zero3Control', {
  status: () => ipcRenderer.invoke('zero3:control:status'),
  tasks: {
    list: () => ipcRenderer.invoke('zero3:control:task:list'),
    get: request => ipcRenderer.invoke('zero3:control:task:get', request),
    getExtension: request => ipcRenderer.invoke('zero3:control:task:extension:get', request),
    dispatchCodex: request => ipcRenderer.invoke('zero3:control:task:dispatch-codex', request)
  }
})

contextBridge.exposeInMainWorld('zero3GptWeb', {`

const globalTypes = String.raw`
type Zero3ControlStatus = { configured: boolean; baseUrl: string | null }
type Zero3ControlTaskDispatchRequest = {
  task: Record<string, unknown>
  extension?: {
    project_context?: unknown
    handoff?: unknown
    provider?: unknown
    review?: unknown
  }
}
`

const globalWindow = String.raw`    zero3Control: {
      status: () => Promise<Zero3ControlStatus>
      tasks: {
        list: () => Promise<unknown>
        get: (request: { taskId: string }) => Promise<unknown>
        getExtension: (request: { taskId: string }) => Promise<unknown>
        dispatchCodex: (request: Zero3ControlTaskDispatchRequest) => Promise<unknown>
      }
    }
    zero3GptWeb: {`

export function applyZero3ControlRuntime() {
  copySources()
  patchFile('electron/main.ts', [
    {
      label: 'control runtime import',
      from: "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'",
      to:
        "import { Zero3WorkspaceEntryStore } from './zero3/workspace/index'\n" +
        "import { Zero3ControlClient } from './zero3/control/index'"
    },
    {
      label: 'control IPC before GPT Web provider',
      from: 'const zero3GptWeb = new Zero3GptWebProvider(zero3WorkspaceEntries, broadcastZero3GptWebEvent)',
      to: mainSurface + '\nconst zero3GptWeb = new Zero3GptWebProvider(zero3WorkspaceEntries, broadcastZero3GptWebEvent)'
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'control preload before GPT Web preload',
      from: "contextBridge.exposeInMainWorld('zero3GptWeb', {",
      to: preloadSurface
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'control renderer type definitions',
      from: 'type Zero3GptWebBounds = { x: number; y: number; width: number; height: number }',
      to: globalTypes + '\ntype Zero3GptWebBounds = { x: number; y: number; width: number; height: number }'
    },
    {
      label: 'control renderer window surface',
      from: '    zero3GptWeb: {',
      to: globalWindow
    }
  ])
}

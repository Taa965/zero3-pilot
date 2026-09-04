import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const artifactSourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'artifact-runtime')
const artifactTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'artifacts')
const mcpSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'mcp-runtime', 'task-mcp-server.mjs')
const mcpTarget = path.join(hermesDesktopDir, 'electron', 'zero3', 'mcp', 'task-mcp-server.mjs')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 artifact overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}
function copySources() {
  fs.mkdirSync(artifactTargetDir, { recursive: true })
  for (const file of ['artifact-store.ts', 'antigravity-mcp-lease.ts', 'verification.ts', 'index.ts']) {
    const source = path.join(artifactSourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 artifact runtime source missing: ${source}`)
    write(path.join(artifactTargetDir, file), read(source))
  }
  if (!fs.statSync(mcpSource).isFile()) throw new Error(`Zero3 task MCP server missing: ${mcpSource}`)
  write(mcpTarget, read(mcpSource))
}

const main = String.raw`
const zero3ArtifactRoot = path.join(app.getPath('userData'), 'zero3', 'artifacts')
const zero3ReviewRoot = path.join(app.getPath('userData'), 'zero3', 'reviews')
const zero3AgentTaskStateRoot = path.join(app.getPath('userData'), 'zero3', 'agent-task-state')
const zero3ProjectContextRoot = path.join(app.getPath('userData'), 'zero3', 'project-context')
const zero3TaskMcpServerPath = path.join(app.getAppPath(), 'electron', 'zero3', 'mcp', 'task-mcp-server.mjs')
const zero3ArtifactStore = new Zero3ArtifactStore(zero3ArtifactRoot)

function zero3ArtifactRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
ipcMain.handle('zero3:artifact:list', (_event, request: unknown) => zero3ArtifactStore.list(zero3ArtifactRecord(request).taskId))
ipcMain.handle('zero3:artifact:get', (_event, request: unknown) => {
  const input = zero3ArtifactRecord(request)
  return zero3ArtifactStore.get(input.taskId, input.artifactId)
})
ipcMain.handle('zero3:artifact:verify', async (_event, request: unknown) => {
  const input = zero3ArtifactRecord(request)
  const artifact = await zero3ArtifactStore.get(input.taskId, input.artifactId)
  return { ok: artifact ? await zero3ArtifactStore.verify(artifact) : false }
})
`

const preload = String.raw`contextBridge.exposeInMainWorld('zero3Artifacts', {
  list: request => ipcRenderer.invoke('zero3:artifact:list', request),
  get: request => ipcRenderer.invoke('zero3:artifact:get', request),
  verify: request => ipcRenderer.invoke('zero3:artifact:verify', request)
})

contextBridge.exposeInMainWorld('zero3Review', {`
const windowSurface = String.raw`    zero3Artifacts: {
      list: (request: { taskId: string }) => Promise<unknown[]>
      get: (request: { taskId: string; artifactId: string }) => Promise<unknown | null>
      verify: (request: { taskId: string; artifactId: string }) => Promise<{ ok: boolean }>
    }
    zero3Review: {`

export function applyZero3ArtifactRuntime() {
  copySources()
  patchFile('electron/main.ts', [
    { label: 'artifact runtime import', from: "import { Zero3ReviewLoopStore } from './zero3/agent-routing/index'", to: "import { Zero3ReviewLoopStore } from './zero3/agent-routing/index'\nimport { Zero3ArtifactStore, Zero3AntigravityMcpLease } from './zero3/artifacts/index'" },
    { label: 'artifact IPC', from: 'const zero3CodexAppServer = createZero3CodexAppServer()', to: main + '\nconst zero3CodexAppServer = createZero3CodexAppServer()' }
  ])
  patchFile('electron/preload.ts', [{ label: 'artifact preload', from: "contextBridge.exposeInMainWorld('zero3Review', {", to: preload }])
  patchFile('src/global.d.ts', [{ label: 'artifact renderer surface', from: '    zero3Review: {', to: windowSurface }])
}

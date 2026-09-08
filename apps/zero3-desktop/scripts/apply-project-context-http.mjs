import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'mcp-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'mcp')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 project-context HTTP overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}
function copySources() {
  for (const file of ['project-context-core.mjs', 'project-context-http-policy.mjs', 'project-context-http.mjs']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 project-context HTTP source is missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}
function addDependencies() {
  const packageFile = path.join(hermesDesktopDir, 'package.json')
  const packageJson = JSON.parse(read(packageFile))
  packageJson.dependencies = packageJson.dependencies ?? {}
  packageJson.dependencies['@modelcontextprotocol/server'] = '^2.0.0'
  packageJson.dependencies['@modelcontextprotocol/node'] = '^2.0.0'
  packageJson.dependencies.zod = packageJson.dependencies.zod ?? '^4.2.0'
  write(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`)
}

const mainRuntime = String.raw`
type Zero3McpHttpPolicyFile = { schemaVersion: 1; projects: Record<string, true> }
let zero3ProjectContextHttpChild: ReturnType<typeof spawn> | null = null
const ZERO3_MCP_HTTP_PORT = (() => {
  const parsed = Number.parseInt(process.env.ZERO3_MCP_HTTP_PORT ?? '8789', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8789
})()
function zero3McpHttpStateDir() { return path.join(app.getPath('userData'), 'zero3') }
function zero3McpHttpTokenFile() { return path.join(zero3McpHttpStateDir(), 'mcp-http-token') }
function zero3McpHttpPolicyFile() { return path.join(zero3McpHttpStateDir(), 'mcp-http-access.json') }
function zero3McpHttpAtomicWrite(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.tmp-' + String(process.pid) + '-' + crypto.randomUUID()
  fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, file)
}
function zero3McpHttpToken() {
  const file = zero3McpHttpTokenFile()
  try {
    const token = fs.readFileSync(file, 'utf8').trim()
    if (/^[a-f0-9]{64}$/.test(token)) return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const token = crypto.randomBytes(32).toString('hex')
  zero3McpHttpAtomicWrite(file, token + '\n')
  return token
}
function zero3McpHttpReadPolicy(): Zero3McpHttpPolicyFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(zero3McpHttpPolicyFile(), 'utf8')) as Partial<Zero3McpHttpPolicyFile>
    if (parsed.schemaVersion !== 1 || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) throw new Error('invalid MCP HTTP access policy')
    const projects: Record<string, true> = {}
    for (const [projectId, enabled] of Object.entries(parsed.projects)) {
      if (!/^[A-Za-z0-9._:-]{1,256}$/.test(projectId) || enabled !== true) throw new Error('invalid MCP HTTP access policy entry')
      projects[projectId] = true
    }
    return { schemaVersion: 1, projects }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, projects: {} }
    throw error
  }
}
function zero3McpHttpSetAccess(projectId: string, enabled: boolean) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(projectId)) throw new Error('projectId is invalid')
  const policy = zero3McpHttpReadPolicy()
  if (enabled) policy.projects[projectId] = true
  else delete policy.projects[projectId]
  zero3McpHttpAtomicWrite(zero3McpHttpPolicyFile(), JSON.stringify(policy, null, 2) + '\n')
  return { projectId, enabled }
}
function zero3McpHttpStatus() {
  const policy = zero3McpHttpReadPolicy()
  return {
    running: Boolean(zero3ProjectContextHttpChild && zero3ProjectContextHttpChild.exitCode == null),
    host: '127.0.0.1', port: ZERO3_MCP_HTTP_PORT,
    endpoint: 'http://127.0.0.1:' + String(ZERO3_MCP_HTTP_PORT) + '/mcp',
    bearerToken: zero3McpHttpToken(),
    writeVerified: process.env.ZERO3_MCP_HTTP_WRITE_VERIFIED === '1',
    enabledProjectIds: Object.keys(policy.projects)
  }
}
function zero3StartProjectContextHttp() {
  if (process.env.ZERO3_MCP_HTTP_ENABLED === '0') return
  if (zero3ProjectContextHttpChild && zero3ProjectContextHttpChild.exitCode == null) return
  const serverPath = path.join(app.getAppPath(), 'electron', 'zero3', 'mcp', 'project-context-http.mjs')
  zero3McpHttpToken()
  zero3ProjectContextHttpChild = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...zero3MemoryAuthorityChildEnv('gpt_web'), ELECTRON_RUN_AS_NODE: '1', ZERO3_PROJECT_CONTEXT_DIR: path.join(app.getPath('userData'), 'zero3', 'project-context'), ZERO3_MCP_HTTP_STATE_DIR: zero3McpHttpStateDir(), ZERO3_MCP_HTTP_HOST: '127.0.0.1', ZERO3_MCP_HTTP_PORT: String(ZERO3_MCP_HTTP_PORT) },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  })
  zero3ProjectContextHttpChild.stderr?.on('data', chunk => console.error('[zero3-project-context-http]', String(chunk).trimEnd()))
  zero3ProjectContextHttpChild.once('exit', () => { zero3ProjectContextHttpChild = null })
}
function zero3StopProjectContextHttp() { zero3ProjectContextHttpChild?.kill(); zero3ProjectContextHttpChild = null }
ipcMain.handle('zero3:mcp-http:status', () => zero3McpHttpStatus())
ipcMain.handle('zero3:mcp-http:set-project-access', (_event, request: unknown) => {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {}
  if (typeof input.projectId !== 'string' || typeof input.enabled !== 'boolean') throw new Error('projectId and enabled are required')
  return zero3McpHttpSetAccess(input.projectId, input.enabled)
})
ipcMain.handle('zero3:mcp-http:rotate-token', () => {
  const token = crypto.randomBytes(32).toString('hex')
  zero3McpHttpAtomicWrite(zero3McpHttpTokenFile(), token + '\n')
  return { bearerToken: token }
})
app.on('before-quit', zero3StopProjectContextHttp)
`
const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3McpHttp', {
  status: () => ipcRenderer.invoke('zero3:mcp-http:status'),
  setProjectAccess: request => ipcRenderer.invoke('zero3:mcp-http:set-project-access', request),
  rotateToken: () => ipcRenderer.invoke('zero3:mcp-http:rotate-token')
})

contextBridge.exposeInMainWorld('zero3Workspace', {`
const globalTypes = String.raw`
type Zero3McpHttpStatus = {
  running: boolean
  host: string
  port: number
  endpoint: string
  bearerToken: string
  writeVerified: boolean
  enabledProjectIds: string[]
}
`
const globalSurface = String.raw`    zero3McpHttp: {
      status: () => Promise<Zero3McpHttpStatus>
      setProjectAccess: (request: { projectId: string; enabled: boolean }) => Promise<{ projectId: string; enabled: boolean }>
      rotateToken: () => Promise<{ bearerToken: string }>
    }
    zero3Workspace: {`

export function applyZero3ProjectContextHttp() {
  copySources()
  addDependencies()
  patchFile('electron/main.ts', [
    { label: 'project-context HTTP runtime before Codex singleton', appliedMarker: 'function zero3StartProjectContextHttp() {', from: 'const zero3CodexAppServer = createZero3CodexAppServer()', to: mainRuntime + '\nconst zero3CodexAppServer = createZero3CodexAppServer()' },
    { label: 'start project-context HTTP server on Electron ready', appliedMarker: '  zero3StartProjectContextHttp()\n', from: "app.whenReady().then(() => {", to: "app.whenReady().then(() => {\n  zero3StartProjectContextHttp()" }
  ])
  patchFile('electron/preload.ts', [{ label: 'project-context HTTP preload surface', appliedMarker: "contextBridge.exposeInMainWorld('zero3McpHttp'", from: "contextBridge.exposeInMainWorld('zero3Workspace', {", to: preloadBridge }])
  patchFile('src/global.d.ts', [
    { label: 'project-context HTTP renderer type definitions', appliedMarker: 'type Zero3McpHttpStatus = {', from: 'type Zero3GptWebWorkspaceEntry = {', to: globalTypes + '\ntype Zero3GptWebWorkspaceEntry = {' },
    { label: 'project-context HTTP renderer surface', appliedMarker: '    zero3McpHttp: {', from: '    zero3Workspace: {', to: globalSurface }
  ])
}

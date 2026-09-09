import fs from 'node:fs'
import path from 'node:path'
import { hermesDesktopDir, repoRoot } from './config.mjs'

const block = String.raw`
// BEGIN ZERO3 PROJECT LINKS
let zero3ProjectLinkOpening: Promise<any> | null = null
function zero3ProjectLinkRuntime() {
  if (!zero3ProjectLinkOpening) zero3ProjectLinkOpening = (async () => {
    const { pathToFileURL } = await import('node:url')
    const { ProjectLinks } = await import(pathToFileURL(path.join(app.getAppPath(), 'electron', 'zero3', 'project-link-runtime', 'project-links.mjs')).href)
    const stateDir = path.join(app.getPath('userData'), 'zero3')
    return new ProjectLinks({ stateDir, home: app.getPath('home'), getProject: (id: string) => zero3Projects.get(id),
      resolveCommand: resolveWindowsCommand, codexEnv: zero3OfficialCodexCliEnv(),
      mcp: { command: process.execPath, args: [path.join(app.getAppPath(), 'electron', 'zero3', 'mcp', 'project-context-server.mjs')],
        env: { ELECTRON_RUN_AS_NODE: '1', ZERO3_PROJECT_CONTEXT_DIR: path.join(stateDir, 'project-context'), ZERO3_SHARED_MEMORY_CONFIG: process.env.ZERO3_SHARED_MEMORY_CONFIG || path.join(stateDir, 'shared-memory.json') } }
    })
  })().catch(error => { zero3ProjectLinkOpening = null; throw error })
  return zero3ProjectLinkOpening
}
ipcMain.handle('zero3:project-links:list', async (_event, input: { projectId: string }) => (await zero3ProjectLinkRuntime()).list(input?.projectId))
ipcMain.handle('zero3:project-links:connect', async (_event, input: unknown) => (await zero3ProjectLinkRuntime()).connect(input))
ipcMain.handle('zero3:project-links:resolve', async (_event, input: { projectId: string; provider: string }) => (await zero3ProjectLinkRuntime()).resolve(input?.projectId,input?.provider))
ipcMain.handle('zero3:project-links:attach-codex', async (_event, input: unknown) => (await zero3ProjectLinkRuntime()).attachCodexThread(input))
app.on('before-quit', () => { void zero3ProjectLinkOpening?.then(runtime => runtime.close()).catch(() => {}) })
// END ZERO3 PROJECT LINKS
`
export function applyZero3ProjectLinks() {
  const source = path.join(repoRoot, 'apps', 'zero3-desktop', 'project-link-runtime')
  const target = path.join(hermesDesktopDir, 'electron', 'zero3', 'project-link-runtime')
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(source).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) fs.copyFileSync(path.join(source,name),path.join(target,name))
  const file = path.join(hermesDesktopDir,'electron','main.ts')
  let main = fs.readFileSync(file,'utf8')
  const begin = main.indexOf('// BEGIN ZERO3 PROJECT LINKS'), end = main.indexOf('// END ZERO3 PROJECT LINKS')
  if (begin >= 0) {
    if (end < begin) throw new Error('project links overlay end missing')
    main = main.slice(0,begin) + block.trim() + main.slice(end + '// END ZERO3 PROJECT LINKS'.length)
  } else {
    const marker = 'const zero3CodexAppServer = createZero3CodexAppServer()'
    if (!main.includes(marker)) throw new Error('project links overlay anchor missing')
    main = main.replace(marker,block + '\n' + marker)
  }
  fs.writeFileSync(file,main)
  const globalFile = path.join(hermesDesktopDir, 'src', 'global.d.ts')
  const global = fs.readFileSync(globalFile, 'utf8').replace('projectId?: string | null; cwd: string; prompt:', 'projectId?: string | null; providerProjectId?: string | null; cwd: string; prompt:')
  fs.writeFileSync(globalFile, global)
  const preloadFile = path.join(hermesDesktopDir,'electron','preload.ts')
  let preload = fs.readFileSync(preloadFile,'utf8')
  if (!preload.includes("exposeInMainWorld('zero3ProjectLinks'")) {
    preload += `\ncontextBridge.exposeInMainWorld('zero3ProjectLinks', {\nlist: request => ipcRenderer.invoke('zero3:project-links:list', request),\nconnect: request => ipcRenderer.invoke('zero3:project-links:connect', request),\nresolve: request => ipcRenderer.invoke('zero3:project-links:resolve', request),\nattachCodexThread: request => ipcRenderer.invoke('zero3:project-links:attach-codex', request),\npickDirectory: () => ipcRenderer.invoke('zero3:project:pickDirectory')\n})\n`
    fs.writeFileSync(preloadFile,preload)
  }
}

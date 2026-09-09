import fs from 'node:fs'
import path from 'node:path'
import { hermesDesktopDir } from './config.mjs'

const runtime = String.raw`
const zero3SharedDefaultConfig = path.join(app.getPath('userData'), 'zero3', 'shared-memory.json')
if (!process.env.ZERO3_SHARED_MEMORY_CONFIG && fs.existsSync(zero3SharedDefaultConfig)) process.env.ZERO3_SHARED_MEMORY_CONFIG = zero3SharedDefaultConfig
const zero3SharedReaders = new Map<string, Promise<any>>()
async function zero3SharedModule() {
  const { pathToFileURL } = await import('node:url')
  return import(pathToFileURL(path.join(app.getAppPath(), 'electron', 'zero3', 'memory-sync-runtime', 'shared-memory-runtime.mjs')).href)
}
ipcMain.handle('zero3:shared-memory:read', async (_event, request: unknown) => {
  const input = request as { projectId?: string }
  const projectId = input?.projectId
  if (!projectId || !zero3Projects.get(projectId)) throw new Error('请选择已登记的项目')
  const configPath = process.env.ZERO3_SHARED_MEMORY_CONFIG
  if (!configPath) return { mode: 'unconfigured' }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!Array.isArray(config.projects) || !config.projects.includes(projectId)) return { mode: 'unconfigured' }
  if (!zero3SharedReaders.has(projectId)) {
    zero3SharedReaders.set(projectId, zero3SharedModule().then(m => m.openSharedMemory({ configPath, projectId })).catch(error => { zero3SharedReaders.delete(projectId); throw error }))
  }
  const memory = await zero3SharedReaders.get(projectId)!
  try { return { mode: 'shared', context: await memory.getProject(projectId), status: memory.status() } }
  catch { return { mode: 'shared', context: null, status: memory.status(), error: '共享记忆服务暂时不可用；已保留待同步内容。' } }
})
ipcMain.handle('zero3:shared-memory:import', async () => {
  const chosen = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '共享记忆连接配置', extensions: ['json'] }] })
  if (chosen.canceled || !chosen.filePaths[0]) return { imported: false }
  const text = fs.readFileSync(chosen.filePaths[0], 'utf8')
  if (Buffer.byteLength(text) > 32768) throw new Error('连接配置过大')
  const config = JSON.parse(text)
  if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('连接配置需要指定项目')
  const { validateSharedMemoryConfig } = await zero3SharedModule()
  validateSharedMemoryConfig(config, config.projects[0])
  fs.mkdirSync(path.dirname(zero3SharedDefaultConfig), { recursive: true, mode: 0o700 })
  const temporary = zero3SharedDefaultConfig + '.tmp-' + crypto.randomUUID()
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, zero3SharedDefaultConfig)
  await Promise.allSettled([...zero3SharedReaders.values()].map(async item => (await item).close()))
  zero3SharedReaders.clear()
  process.env.ZERO3_SHARED_MEMORY_CONFIG = zero3SharedDefaultConfig
  return { imported: true }
})
app.on('before-quit', () => { for (const opening of zero3SharedReaders.values()) void opening.then(memory => memory.close()).catch(() => {}) })
`

export function applyZero3SharedMemory() {
  const mainFile = path.join(hermesDesktopDir, 'electron', 'main.ts')
  let main = fs.readFileSync(mainFile, 'utf8')
  if (!main.includes("ipcMain.handle('zero3:shared-memory:read'")) {
    const marker = 'const zero3CodexAppServer = createZero3CodexAppServer()'
    if (!main.includes(marker)) throw new Error('shared memory overlay: missing main anchor')
    main = main.replace(marker, runtime + '\n' + marker)
    fs.writeFileSync(mainFile, main)
  }
  const preloadFile = path.join(hermesDesktopDir, 'electron', 'preload.ts')
  let preload = fs.readFileSync(preloadFile, 'utf8')
  if (!preload.includes("exposeInMainWorld('zero3SharedMemory'")) {
    preload += `\ncontextBridge.exposeInMainWorld('zero3SharedMemory', {\n  read: request => ipcRenderer.invoke('zero3:shared-memory:read', request),\n  importConfig: () => ipcRenderer.invoke('zero3:shared-memory:import')\n})\n`
    fs.writeFileSync(preloadFile, preload)
  }
}

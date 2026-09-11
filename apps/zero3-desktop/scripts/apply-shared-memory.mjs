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
async function zero3SharedMemoryForProject(projectId: string) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(projectId) || !zero3Projects.get(projectId)) throw new Error('请选择已登记的项目')
  const configPath = process.env.ZERO3_SHARED_MEMORY_CONFIG
  if (!configPath) return null
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!Array.isArray(config.projects) || (!config.projects.includes(projectId) && !config.projects.includes('*'))) return null
  if (!zero3SharedReaders.has(projectId)) {
    zero3SharedReaders.set(projectId, zero3SharedModule().then(m => m.openSharedMemory({ configPath, projectId })).catch(error => { zero3SharedReaders.delete(projectId); throw error }))
  }
  return zero3SharedReaders.get(projectId)!
}
ipcMain.handle('zero3:shared-memory:read', async (_event, request: unknown) => {
  const input = request as { projectId?: string }
  const projectId = input?.projectId
  if (!projectId) throw new Error('请选择已登记的项目')
  const memory = await zero3SharedMemoryForProject(projectId)
  if (!memory) return { mode: 'unconfigured' }
  try { return { mode: 'shared', context: await memory.getProject(projectId), status: memory.status() } }
  catch { return { mode: 'shared', context: null, status: memory.status(), error: '共享记忆服务暂时不可用；已保留待同步内容。' } }
})
ipcMain.handle('zero3:shared-memory:flush', async (_event, request: unknown) => {
  const input = request as { projectId?: string }
  const projectId = input?.projectId
  if (!projectId) throw new Error('请选择已登记的项目')
  const memory = await zero3SharedMemoryForProject(projectId)
  if (!memory) return { mode: 'unconfigured' }
  const status = await memory.flush()
  return { mode: 'shared', status }
})
ipcMain.handle('zero3:shared-memory:import', async () => {
  const chosen = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '共享记忆连接配置', extensions: ['json'] }] })
  if (chosen.canceled || !chosen.filePaths[0]) return { imported: false }
  const text = fs.readFileSync(chosen.filePaths[0], 'utf8')
  if (Buffer.byteLength(text) > 32768) throw new Error('连接配置过大')
  const config = JSON.parse(text)
  if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('连接配置需要指定项目')
  const { validateSharedMemoryConfig } = await zero3SharedModule()
  validateSharedMemoryConfig(config, config.projects.find(id => id !== '*') ?? 'config-validation')
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
  const start = main.indexOf('const zero3SharedDefaultConfig =')
  if (start >= 0) {
    const endMarker = "app.on('before-quit', () => { for (const opening of zero3SharedReaders.values()) void opening.then(memory => memory.close()).catch(() => {}) })"
    const end = main.indexOf(endMarker, start)
    if (end < 0) throw new Error('shared memory overlay: missing owned block end')
    main = main.slice(0, start) + runtime.trim() + main.slice(end + endMarker.length)
    fs.writeFileSync(mainFile, main)
  }
  if (!main.includes("ipcMain.handle('zero3:shared-memory:read'")) {
    const marker = 'const zero3CodexAppServer = createZero3CodexAppServer()'
    if (!main.includes(marker)) throw new Error('shared memory overlay: missing main anchor')
    main = main.replace(marker, runtime + '\n' + marker)
    fs.writeFileSync(mainFile, main)
  }
  const preloadFile = path.join(hermesDesktopDir, 'electron', 'preload.ts')
  let preload = fs.readFileSync(preloadFile, 'utf8')
  if (!preload.includes("exposeInMainWorld('zero3SharedMemory'")) {
    preload += `\ncontextBridge.exposeInMainWorld('zero3SharedMemory', {\n  read: request => ipcRenderer.invoke('zero3:shared-memory:read', request),\n  flush: request => ipcRenderer.invoke('zero3:shared-memory:flush', request),\n  importConfig: () => ipcRenderer.invoke('zero3:shared-memory:import')\n})\n`
    fs.writeFileSync(preloadFile, preload)
  }
}

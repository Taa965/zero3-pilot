import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'memory-sync-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'memory-sync-runtime')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 Memory Authority V2.1 overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}
function copySources() {
  for (const file of ['memory-sync-client.mjs', 'memory-sync-sqlite-store.mjs', 'memory-sync-daemon.mjs']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 memory sync source is missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}
function addDependencies() {
  const packageFile = path.join(hermesDesktopDir, 'package.json')
  const packageJson = JSON.parse(read(packageFile))
  packageJson.dependencies = packageJson.dependencies ?? {}
  packageJson.dependencies.ws = packageJson.dependencies.ws ?? '8.21.1'
  write(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`)
}

const mainRuntime = String.raw`
let zero3MemorySyncChild: ReturnType<typeof spawn> | null = null
function zero3MemoryAuthorityEnabled() { return process.env.ZERO3_MEMORY_AUTHORITY_V2 === '1' }
function zero3MemoryRoot() { return path.join(app.getPath('userData'), 'zero3', 'memory') }
function zero3MemorySyncDbPath() { return path.join(zero3MemoryRoot(), 'memory-sync.sqlite') }
function zero3MemoryTokenFile() { return path.join(zero3MemoryRoot(), 'authority-token') }
function zero3MemoryRequired(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(name + ' is required when ZERO3_MEMORY_AUTHORITY_V2=1')
  return value
}
function zero3MemoryEnsureTokenFile() {
  const configured = process.env.ZERO3_MEMORY_AUTHORITY_TOKEN_FILE?.trim()
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('ZERO3_MEMORY_AUTHORITY_TOKEN_FILE must be absolute')
    delete process.env.ZERO3_MEMORY_AUTHORITY_TOKEN
    return configured
  }
  const token = zero3MemoryRequired('ZERO3_MEMORY_AUTHORITY_TOKEN')
  const file = zero3MemoryTokenFile()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.tmp-' + String(process.pid) + '-' + String(Date.now())
  fs.writeFileSync(temporary, token + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, file)
  process.env.ZERO3_MEMORY_AUTHORITY_TOKEN_FILE = file
  delete process.env.ZERO3_MEMORY_AUTHORITY_TOKEN
  return file
}
`
const mainRuntime2 = String.raw`
function zero3MemoryAuthorityChildEnv(agentType: string): Record<string, string> {
  if (!zero3MemoryAuthorityEnabled()) return {}
  const deviceId = process.env.ZERO3_MEMORY_DEVICE_ID?.trim() || process.env.COMPUTERNAME?.trim() || process.env.HOSTNAME?.trim() || 'zero3-desktop'
  const syncDb = zero3MemorySyncDbPath()
  process.env.ZERO3_MEMORY_SYNC_DB = syncDb
  process.env.ZERO3_MEMORY_DEVICE_ID = deviceId
  const caFile = process.env.ZERO3_MEMORY_AUTHORITY_CA_FILE?.trim() || ''
  if (caFile && !path.isAbsolute(caFile)) throw new Error('ZERO3_MEMORY_AUTHORITY_CA_FILE must be absolute')
  return {
    ZERO3_MEMORY_AUTHORITY_V2: '1',
    ZERO3_MEMORY_AUTHORITY_URL: zero3MemoryRequired('ZERO3_MEMORY_AUTHORITY_URL'),
    ZERO3_MEMORY_AUTHORITY_TOKEN_FILE: zero3MemoryEnsureTokenFile(),
    ZERO3_MEMORY_SYNC_DB: syncDb,
    ZERO3_MEMORY_DEVICE_ID: deviceId,
    ZERO3_MEMORY_AGENT_ID: agentType + ':' + deviceId,
    ZERO3_MEMORY_AGENT_TYPE: agentType,
    ZERO3_MEMORY_MAX_AUTHORITY: process.env.ZERO3_MEMORY_MAX_AUTHORITY?.trim() || '60',
    ...(caFile ? { ZERO3_MEMORY_AUTHORITY_CA_FILE: caFile, NODE_EXTRA_CA_CERTS: caFile } : {})
  }
}
function zero3StartMemorySync() {
  if (!zero3MemoryAuthorityEnabled() || zero3MemorySyncChild) return
  try {
    const env = zero3MemoryAuthorityChildEnv('zero3')
    env.ZERO3_MEMORY_CLIENT_ID = zero3MemoryRequired('ZERO3_MEMORY_CLIENT_ID')
    env.ZERO3_MEMORY_PROJECTS = process.env.ZERO3_MEMORY_PROJECTS?.trim() || '["*"]'
    const daemon = path.join(app.getAppPath(), 'electron', 'zero3', 'memory-sync-runtime', 'memory-sync-daemon.mjs')
    zero3MemorySyncChild = spawn(process.execPath, [daemon], {
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    })
    zero3MemorySyncChild.stderr?.on('data', chunk => console.error('[zero3-memory-sync]', chunk.toString().trimEnd()))
    zero3MemorySyncChild.once('exit', (code, signal) => {
      console.error('[zero3-memory-sync] exited', { code, signal })
      zero3MemorySyncChild = null
    })
  } catch (error) {
    console.error('[zero3-memory-sync] failed to start:', error)
  }
}
function zero3StopMemorySync() {
  const child = zero3MemorySyncChild
  zero3MemorySyncChild = null
  if (child && !child.killed) child.kill()
}
`
export function applyZero3MemoryAuthorityV21() {
  copySources()
  addDependencies()
  patchFile('electron/main.ts', [
    {
      label: 'Memory Authority V2.1 main runtime',
      appliedMarker: 'function zero3MemoryAuthorityChildEnv(agentType: string): Record<string, string> {',
      from: 'const zero3CodexAppServer = createZero3CodexAppServer()',
      to: mainRuntime + mainRuntime2 + '\nconst zero3CodexAppServer = createZero3CodexAppServer()'
    },
    {
      label: 'Memory Authority V2.1 lifecycle',
      appliedMarker: "app.on('before-quit', zero3StopMemorySync)",
      from: 'app.whenReady().then(() => {',
      to: "app.on('before-quit', zero3StopMemorySync)\n\napp.whenReady().then(() => {\n  zero3StartMemorySync()"
    }
  ])
}

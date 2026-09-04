import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'agent-routing-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'agent-routing')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 agent-routing overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}
function copySources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const file of ['agent-contracts.ts', 'agent-router.ts', 'review-loop-store.ts', 'index.ts']) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 agent-routing source missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

const main = String.raw`
const zero3ReviewStore = new Zero3ReviewLoopStore(path.join(app.getPath('userData'), 'zero3', 'reviews'))
ipcMain.handle('zero3:review:get', (_event, request: unknown) => {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {}
  return zero3ReviewStore.get(input.taskId)
})
ipcMain.handle('zero3:review:latest-fix', (_event, request: unknown) => {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {}
  return zero3ReviewStore.latestFixRequest(input.taskId)
})
ipcMain.handle('zero3:review:decision', (_event, request: unknown) => {
  const input = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {}
  return zero3ReviewStore.submitDecision(input.taskId, input.decision as never, Number(input.contextVersion))
})
`

const preload = String.raw`contextBridge.exposeInMainWorld('zero3Review', {
  get: request => ipcRenderer.invoke('zero3:review:get', request),
  latestFix: request => ipcRenderer.invoke('zero3:review:latest-fix', request),
  submitDecision: request => ipcRenderer.invoke('zero3:review:decision', request)
})

contextBridge.exposeInMainWorld('zero3Antigravity', {`

const types = String.raw`
type Zero3ReviewDecisionInput = {
  protocol: 'zero3.pilot.review-decision.v1'
  reviewId: string
  taskId: string
  cycle: number
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED' | 'ESCALATE_HUMAN'
  findings: Array<Record<string, unknown>>
  requiredFixes: string[]
  optionalSuggestions: string[]
  reviewerSessionId: string
  createdAt: string
}
`
const windowSurface = String.raw`    zero3Review: {
      get: (request: { taskId: string }) => Promise<unknown>
      latestFix: (request: { taskId: string }) => Promise<unknown>
      submitDecision: (request: { taskId: string; contextVersion: number; decision: Zero3ReviewDecisionInput }) => Promise<unknown>
    }
    zero3Antigravity: {`

export function applyZero3AgentRoutingRuntime() {
  copySources()
  patchFile('electron/main.ts', [
    { label: 'review runtime import', from: "import { Zero3AntigravityAdapter } from './zero3/antigravity/index'", to: "import { Zero3AntigravityAdapter } from './zero3/antigravity/index'\nimport { Zero3ReviewLoopStore } from './zero3/agent-routing/index'" },
    { label: 'review IPC', from: 'const zero3CodexAppServer = createZero3CodexAppServer()', to: main + '\nconst zero3CodexAppServer = createZero3CodexAppServer()' }
  ])
  patchFile('electron/preload.ts', [{ label: 'review preload', from: "contextBridge.exposeInMainWorld('zero3Antigravity', {", to: preload }])
  patchFile('src/global.d.ts', [
    { label: 'review renderer types', from: 'type Zero3AntigravityEvent = {', to: types + '\ntype Zero3AntigravityEvent = {' },
    { label: 'review renderer surface', from: '    zero3Antigravity: {', to: windowSurface }
  ])
}

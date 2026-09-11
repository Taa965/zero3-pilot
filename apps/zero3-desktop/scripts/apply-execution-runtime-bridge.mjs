import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'

const executionSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'execution-runtime')
const electronZero3 = path.join(hermesDesktopDir, 'electron', 'zero3')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function normalizeRelativeTypeScriptSpecifiers(source) {
  return source.replace(/(['"])(\.\.?\/[^'"\r\n]+)\.(?:ts|tsx)\1/gu, '$1$2$1')
}
function copyProductionTree(source, target) {
  if (!fs.statSync(source).isDirectory()) throw new Error(`Execution runtime source directory missing: ${source}`)
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyProductionTree(from, to)
    else if (entry.isFile() && /\.(ts|tsx)$/u.test(entry.name)) write(to, overlayRuntimeSource(normalizeRelativeTypeScriptSpecifiers(read(from))))
  }
}
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Execution runtime desktop bridge drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

const mainRuntime = String.raw`const zero3ExecutionReporterClientPath =
  app.isPackaged && process.platform === 'win32'
    ? path.join(process.resourcesPath, 'zero3-execution-tools', 'zero3-exec.ps1')
    : path.join(process.env.ZERO3_CODEX_CWD ?? process.cwd(), 'apps', 'zero3-desktop', 'execution-runtime', process.platform === 'win32' ? 'zero3-exec.ps1' : 'zero3-exec.mjs')
function zero3ExecutionSkillAdapterMode(executor: string) {
  if (executor === 'CODEX' || executor === 'ZERO3') return 'native' as const
  if (executor === 'CLAUDE' || executor === 'ANTIGRAVITY') return 'instruction-adapter' as const
  if (executor === 'GPT_WEB' && ['1','true','yes','on'].includes((process.env.ZERO3_SKILL_TUNNEL_ENABLED ?? '').trim().toLowerCase())) return 'web-mcp' as const
  return 'unsupported' as const
}
function zero3ExecutionSkillBindingTarget(executor: string) {
  return executor === 'ANTIGRAVITY' ? 'GEMINI' : executor
}
function zero3ExecutionWorkspace(task: any): string | null {
  const direct = typeof task.workspace === 'string' ? task.workspace.trim() : ''
  const metadata = task.metadata && typeof task.metadata === 'object' && typeof task.metadata.workspace === 'string' ? task.metadata.workspace.trim() : ''
  return direct || metadata || null
}
async function zero3ExecutionSkillCatalog(task: any) {
  const workspace = zero3ExecutionWorkspace(task)
  const listing = await zero3CodexAppServer.request('skills/list', { cwds: workspace ? [workspace] : [], forceReload: false })
  return zero3NativeSkillCatalog(listing)
}
async function zero3ExecutionAutoExecutor(step: any, bindings: any[]) {
  const availability = await zero3ProviderAvailability()
  const candidates = [
    { executor: 'CODEX', ok: availability.codex.available && availability.codex.authenticated === true, base: 300 },
    { executor: 'CLAUDE', ok: availability.claude.available && availability.claude.authenticated === true, base: 200 },
    { executor: 'ANTIGRAVITY', ok: availability.gemini.available && availability.gemini.authenticated === true, base: 100 }
  ].filter(item => item.ok)
  const selectors = new Set([...(step.requiredSkills ?? []), ...(step.optionalSkills ?? [])])
  for (const candidate of candidates) {
    const target = zero3ExecutionSkillBindingTarget(candidate.executor)
    const boost = bindings.filter(binding => binding.enabled && binding.autoInvoke && binding.targetType === 'agent' && binding.targetId.toUpperCase() === target && (!selectors.size || selectors.has(binding.skillName))).reduce((sum, binding) => sum + 1000 + Number(binding.priority ?? 0), 0)
    candidate.base += boost
  }
  candidates.sort((a, b) => b.base - a.base)
  return candidates[0]?.executor ?? null
}
const zero3ExecutionSkillCapabilityProvider = {
  async preflight(task: any, step: any) {
    const [catalog, bindings] = await Promise.all([zero3ExecutionSkillCatalog(task), zero3SkillBindingStore.list()])
    const executor = step.executor === 'AUTO' ? await zero3ExecutionAutoExecutor(step, bindings) : step.executor
    return evaluateExecutionSkillPreflight({
      step,
      executor,
      adapterMode: zero3ExecutionSkillAdapterMode(executor ?? ''),
      catalog
    })
  },
  async matrix() {
    const [catalog, bindings, availability] = await Promise.all([
      zero3ExecutionSkillCatalog({}),
      zero3SkillBindingStore.list(),
      zero3ProviderAvailability()
    ])
    const skillCount = catalog.filter(skill => skill.enabled).length
    const rows = [
      ['CODEX', 'native', availability.codex.available && availability.codex.authenticated === true],
      ['CLAUDE', 'instruction-adapter', availability.claude.available && availability.claude.authenticated === true],
      ['ANTIGRAVITY', 'instruction-adapter', availability.gemini.available && availability.gemini.authenticated === true],
      ['GPT_WEB', zero3ExecutionSkillAdapterMode('GPT_WEB'), zero3ExecutionSkillAdapterMode('GPT_WEB') !== 'unsupported'],
      ['ZERO3', 'native', availability.codex.available && availability.codex.authenticated === true]
    ]
    return {
      generatedAt: new Date().toISOString(),
      agents: rows.map(([executor, adapterMode, available]) => {
        const target = zero3ExecutionSkillBindingTarget(String(executor))
        const boundSkills = bindings.filter(binding => binding.enabled && binding.targetType === 'agent' && binding.targetId.toUpperCase() === target).map(binding => binding.skillName)
        return { executor, adapterMode, available, skillCount: available ? skillCount : 0, boundSkills: [...new Set(boundSkills)] }
      })
    }
  }
}
const zero3ExecutionRuntime = createExecutionDesktopRuntime(
  path.join(app.getPath('userData'), 'execution'),
  {
    reporterClientPath: zero3ExecutionReporterClientPath,
    reporterClientKind: process.platform === 'win32' ? 'powershell' : 'node',
    nodeExecutable: process.env.ZERO3_NODE_BIN ?? 'node',
    powershellExecutable: process.env.ZERO3_POWERSHELL_BIN ?? 'powershell.exe',
    skillCapabilityProvider: zero3ExecutionSkillCapabilityProvider
  }
)
void zero3ExecutionRuntime.start().catch(error => console.error('[Zero3 Execution] reporter start failed', error))
const disposeZero3ExecutionIpc = registerExecutionDesktopIpc(zero3ExecutionRuntime)
app.on('before-quit', () => {
  disposeZero3ExecutionIpc()
  void zero3ExecutionRuntime.stop().catch(() => undefined)
})
`

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3Execution', {
  runtimeCapabilities: () => ipcRenderer.invoke('zero3:execution:runtime-capabilities'),
  skillCapabilities: () => ipcRenderer.invoke('zero3:execution:skill-capabilities'),
  refreshSkillPreflight: taskId => ipcRenderer.invoke('zero3:execution:refresh-skill-preflight', taskId),
  reconcileReadiness: taskId => ipcRenderer.invoke('zero3:execution:reconcile-readiness', taskId),
  listTasks: () => ipcRenderer.invoke('zero3:execution:list'),
  getTask: taskId => ipcRenderer.invoke('zero3:execution:get', taskId),
  listTaskWorkflows: () => ipcRenderer.invoke('zero3:execution:workflow:list'),
  createWorkflowTask: input => ipcRenderer.invoke('zero3:execution:workflow:create-task', input),
  createTask: input => ipcRenderer.invoke('zero3:execution:create', input),
  addSteps: (taskId, steps) => ipcRenderer.invoke('zero3:execution:add-steps', taskId, steps),
  createAssignment: (taskId, stepId, executor, executorId) => ipcRenderer.invoke('zero3:execution:create-assignment', taskId, stepId, executor, executorId),
  createRoutedAssignment: (taskId, stepId, executorId) => ipcRenderer.invoke('zero3:execution:create-routed-assignment', taskId, stepId, executorId),
  bindSession: (assignmentId, input) => ipcRenderer.invoke('zero3:execution:bind-session', assignmentId, input),
  updateSessionState: (taskId, bindingId, state) => ipcRenderer.invoke('zero3:execution:update-session-state', taskId, bindingId, state),
  transitionStep: (taskId, stepId, status, reason) => ipcRenderer.invoke('zero3:execution:transition-step', taskId, stepId, status, reason),
  gatePassed: (taskId, stepId, evidence) => ipcRenderer.invoke('zero3:execution:gate-passed', taskId, stepId, evidence),
  gateFailed: (taskId, stepId, reason) => ipcRenderer.invoke('zero3:execution:gate-failed', taskId, stepId, reason),
  issueReporterTicket: (assignmentId, request) => ipcRenderer.invoke('zero3:execution:issue-reporter-ticket', assignmentId, request)
})

contextBridge.exposeInMainWorld('hermesDesktop', {`

const globalBridgeProperty = String.raw`    zero3Execution: {
      runtimeCapabilities: () => Promise<unknown>
      skillCapabilities: () => Promise<unknown>
      refreshSkillPreflight: (taskId: string) => Promise<unknown>
      reconcileReadiness: (taskId: string) => Promise<unknown>
      listTasks: () => Promise<unknown>
      getTask: (taskId: string) => Promise<unknown>
      listTaskWorkflows: () => Promise<Array<{ id: string; name: string; description: string; category: string; revision: number }>>
      createWorkflowTask: (input: { title: string; description: string; projectId: string | null; workspace?: string | null; workflowId: string }) => Promise<unknown>
      createTask: (input: Record<string, unknown>) => Promise<unknown>
      addSteps: (taskId: string, steps: Record<string, unknown>[]) => Promise<unknown>
      createAssignment: (taskId: string, stepId: string, executor: string, executorId?: string | null) => Promise<unknown>
      createRoutedAssignment: (taskId: string, stepId: string, executorId?: string | null) => Promise<unknown>
      bindSession: (assignmentId: string, input: Record<string, unknown>) => Promise<unknown>
      updateSessionState: (taskId: string, bindingId: string, state: string) => Promise<unknown>
      transitionStep: (taskId: string, stepId: string, status: string, reason?: string) => Promise<unknown>
      gatePassed: (taskId: string, stepId: string, evidence?: Record<string, unknown>) => Promise<unknown>
      gateFailed: (taskId: string, stepId: string, reason: string) => Promise<unknown>
      issueReporterTicket: (assignmentId: string, request?: Record<string, unknown>) => Promise<{ ticket: string; endpointFile: string; client: { kind: 'node' | 'powershell'; command: string; argsPrefix: string[] } }>
    }
    hermesDesktop: {`

export function applyExecutionRuntimeBridge() {
  copyProductionTree(executionSource, path.join(electronZero3, 'execution-runtime'))
  patchFile('electron/main.ts', [
    {
      label: 'Execution runtime import boundary',
      from: "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR",
      to: "import { createExecutionDesktopRuntime, evaluateExecutionSkillPreflight, registerExecutionDesktopIpc } from './zero3/execution-runtime/desktop/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
    },
    {
      label: 'Development Group composition boundary',
      from: 'const disposeZero3DevelopmentGroupIpc = registerDevelopmentGroupDesktopIpc(zero3DevelopmentGroupRuntime)\n',
      to: 'const disposeZero3DevelopmentGroupIpc = registerDevelopmentGroupDesktopIpc(zero3DevelopmentGroupRuntime)\n' + mainRuntime
    }
  ])
  patchFile('electron/preload.ts', [
    { label: 'Execution preload bridge', from: "contextBridge.exposeInMainWorld('hermesDesktop', {", to: preloadBridge }
  ])
  patchFile('src/global.d.ts', [
    { label: 'Execution renderer bridge types', from: '    hermesDesktop: {', to: globalBridgeProperty }
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) applyExecutionRuntimeBridge()

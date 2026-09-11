import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'worker-runtime', 'v2')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'worker-runtime', 'v2')
const workflowSourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'workflow-runtime')
const workflowTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'workflow-runtime')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function normalizeRelativeTypeScriptSpecifiers(source) {
  return source.replace(/(['"])(\.\.?\/[^'"\r\n]+)\.(?:ts|tsx)\1/gu, '$1$2$1')
}
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 Agent Lifecycle overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function copySources() {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    write(path.join(targetDir, entry.name), overlayRuntimeSource(normalizeRelativeTypeScriptSpecifiers(read(path.join(sourceDir, entry.name)))))
  }
  fs.mkdirSync(workflowTargetDir, { recursive: true })
  for (const entry of fs.readdirSync(workflowSourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    write(path.join(workflowTargetDir, entry.name), overlayRuntimeSource(normalizeRelativeTypeScriptSpecifiers(read(path.join(workflowSourceDir, entry.name)))))
  }
}

const mainRuntime = String.raw`
function zero3WorkerBindingSecret() {
  const file = path.join(app.getPath('userData'), 'zero3', 'worker-binding-secret')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    const existing = fs.readFileSync(file)
    if (existing.byteLength < 32) throw new Error('worker binding secret is too short')
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const created = crypto.randomBytes(48)
  try { fs.writeFileSync(file, created, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return zero3WorkerBindingSecret()
  }
  return created
}
const zero3WorkflowWorkerStore = new Zero3WorkflowWorkerStore(path.join(app.getPath('userData'), 'zero3', 'workflow-worker.sqlite3'))
const zero3WorkflowWorkerRuntime = new Zero3WorkflowWorkerRuntime(zero3WorkflowWorkerStore, { ticketSecret: zero3WorkerBindingSecret() })
const zero3WorkerStationManager = new Zero3WorkerStationManager(zero3WorkflowWorkerRuntime, {
  create: projectId => zero3GptWeb.create(projectId),
  executionStatus: entryId => zero3GptWeb.executionStatus(entryId),
  sendWakeup: (entryId, message) => zero3GptWeb.sendWakeup(entryId, message)
})
void app.whenReady().then(() => zero3WorkerStationManager.start())
const zero3WorkerWakeupController = new Zero3WorkerWakeupController(zero3WorkflowWorkerRuntime, {
  executionStatus: entryId => zero3GptWeb.executionStatus(entryId),
  sendWakeup: (entryId, message) => zero3GptWeb.sendWakeup(entryId, message)
})
zero3WorkerWakeupController.start()
const zero3AgentLifecycleStore = new Zero3AgentLifecycleStore(path.join(app.getPath('userData'), 'zero3', 'agent-lifecycle.sqlite3'))
const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(
  zero3AgentLifecycleStore,
  {
    listTasks: async () => await zero3ExecutionRuntime.listTasks() as any[],
    getTask: taskId => zero3ExecutionRuntime.getTask(taskId),
    refreshSkillPreflight: taskId => zero3ExecutionRuntime.refreshSkillPreflight(taskId) as any,
    createTask: input => zero3ExecutionRuntime.createTask(input as any),
    createAssignment: (taskId, stepId, executor, executorId) => zero3ExecutionRuntime.createAssignment(taskId, stepId, executor, executorId),
    bindSession: (assignmentId, input) => zero3ExecutionRuntime.bindSession(assignmentId, input as any),
    recordProgress: (taskId, stepId, progress, activity, identity) => zero3ExecutionRuntime.runtime.recordProgress(taskId, stepId, progress, activity, identity),
    recordArtifact: (taskId, stepId, artifact, identity) => zero3ExecutionRuntime.runtime.recordArtifact(taskId, stepId, artifact, identity),
    requestCompletion: (taskId, stepId, identity) => zero3ExecutionRuntime.runtime.requestCompletion(taskId, stepId, identity),
    updateSessionState: (taskId, bindingId, state) => zero3ExecutionRuntime.updateSessionState(taskId, bindingId, state),
    transitionStep: (taskId, stepId, status, reason) => zero3ExecutionRuntime.transitionStep(taskId, stepId, status as any, reason)
  },
  {
    register: input => zero3ArtifactReferenceStore.register(input as any),
    list: async taskId => {
      const [references, localFiles] = await Promise.all([zero3ArtifactReferenceStore.list(taskId), zero3ArtifactStore.list(taskId)])
      return [
        ...references,
        ...localFiles.map(record => ({
          ...record,
          logicalName: path.basename(record.originalPath),
          storage: { provider: 'LOCAL', path: record.storedPath },
          version: 1,
          status: 'produced'
        }))
      ]
    },
    get: async (taskId, artifactId) => {
      const reference = await zero3ArtifactReferenceStore.get(taskId, artifactId)
      if (reference) return reference
      const record = await zero3ArtifactStore.get(taskId, artifactId)
      return record ? { ...record, logicalName: path.basename(record.originalPath), storage: { provider: 'LOCAL', path: record.storedPath }, version: 1, status: 'produced' } : null
    }
  },
  { memoryForProject: projectId => zero3SharedMemoryForProject(projectId) }
)
function zero3WorkflowWorkerInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow worker request must be an object')
  return value as Record<string, unknown>
}
ipcMain.handle('zero3:workflow-worker:ensure-run', (_event, request: unknown) => zero3WorkflowWorkerRuntime.ensureWorkflowRun(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:ensure-binding', (_event, request: unknown) => zero3WorkflowWorkerRuntime.ensureWorkerBinding(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:add-items', (_event, request: unknown) => zero3WorkflowWorkerRuntime.addWorkItems(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:install-cognitive-store', async (_event, request: unknown) => {
  const input = zero3WorkflowWorkerInput(request)
  const installed = installCognitiveStoreWorkflow(zero3WorkflowWorkerRuntime, input as never)
  const stations = await zero3WorkerStationManager.reconcileRun(String(input.workflowRunId), String(input.projectId))
  return { ...installed, stations }
})
ipcMain.handle('zero3:workflow-worker:open-session', (_event, request: unknown) => zero3WorkflowWorkerRuntime.openPhysicalSession(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:rotate-session', (_event, request: unknown) => zero3WorkflowWorkerRuntime.rotatePhysicalSession(zero3WorkflowWorkerInput(request)))
ipcMain.handle('zero3:workflow-worker:snapshot', (_event, workflowRunId: unknown) => zero3WorkflowWorkerRuntime.workflowSnapshot(workflowRunId))
ipcMain.handle('zero3:workflow-worker:expire-leases', (_event, request: unknown) => zero3WorkflowWorkerRuntime.expireLeases(zero3WorkflowWorkerInput(request)))

async function zero3WorkerRpcRuntime() {
  const v1 = await zero3WorkerAdmin()
  return {
    registerWorker: input => v1.registerWorker(input),
    claimWork: input => ('bindingTicket' in input || 'ticket' in input) ? zero3WorkflowWorkerRuntime.claimWorkV2(input) : v1.claimWork(input),
    reportProgress: input => ('bindingTicket' in input || 'ticket' in input) ? zero3WorkflowWorkerRuntime.reportProgressV2(input) : v1.reportProgress(input),
    completeAndClaimNext: input => v1.completeAndClaimNext(input),
    reportFailure: input => v1.reportFailure(input),
    getTaskContext: input => v1.getTaskContext(input),
    sessionStart: input => zero3AgentLifecycleRuntime.sessionStart(input),
    contextResolve: input => zero3AgentLifecycleRuntime.contextResolve(input),
    taskClaim: input => zero3AgentLifecycleRuntime.taskClaim(input),
    eventRecord: input => zero3AgentLifecycleRuntime.eventRecord(input),
    artifactRegister: input => zero3AgentLifecycleRuntime.artifactRegister(input),
    taskComplete: input => zero3AgentLifecycleRuntime.taskComplete(input),
    memoryCommit: input => zero3AgentLifecycleRuntime.memoryCommit(input),
    handoffCreate: input => zero3AgentLifecycleRuntime.handoffCreate(input),
    bootstrapWorker: input => zero3WorkflowWorkerRuntime.bootstrapWorker(input),
    commitAndClaimNextV2: input => zero3WorkflowWorkerRuntime.commitAndClaimNext(input),
    reportBlockedV2: input => zero3WorkflowWorkerRuntime.reportBlockedV2(input),
    recoverWorker: input => zero3WorkflowWorkerRuntime.recoverWorker(input),
    claimWorkV2: input => zero3WorkflowWorkerRuntime.claimWorkV2(input),
    reportProgressV2: input => zero3WorkflowWorkerRuntime.reportProgressV2(input)
  }
}
app.on('before-quit', () => { zero3WorkerStationManager.stop(); zero3WorkerWakeupController.stop(); zero3AgentLifecycleStore.close(); zero3WorkflowWorkerStore.close() })
`

const preloadBridge = String.raw`contextBridge.exposeInMainWorld('zero3WorkflowWorkers', {
  ensureRun: input => ipcRenderer.invoke('zero3:workflow-worker:ensure-run', input),
  ensureBinding: input => ipcRenderer.invoke('zero3:workflow-worker:ensure-binding', input),
  addItems: input => ipcRenderer.invoke('zero3:workflow-worker:add-items', input),
  installCognitiveStore: input => ipcRenderer.invoke('zero3:workflow-worker:install-cognitive-store', input),
  openSession: input => ipcRenderer.invoke('zero3:workflow-worker:open-session', input),
  rotateSession: input => ipcRenderer.invoke('zero3:workflow-worker:rotate-session', input),
  snapshot: workflowRunId => ipcRenderer.invoke('zero3:workflow-worker:snapshot', workflowRunId),
  expireLeases: input => ipcRenderer.invoke('zero3:workflow-worker:expire-leases', input)
})

contextBridge.exposeInMainWorld('hermesDesktop', {`

const globalBridge = String.raw`    zero3WorkflowWorkers: {
      ensureRun: (input: Record<string, unknown>) => Promise<unknown>
      ensureBinding: (input: Record<string, unknown>) => Promise<unknown>
      addItems: (input: Record<string, unknown>) => Promise<unknown>
      installCognitiveStore: (input: Record<string, unknown>) => Promise<unknown>
      openSession: (input: Record<string, unknown>) => Promise<unknown>
      rotateSession: (input: Record<string, unknown>) => Promise<unknown>
      snapshot: (workflowRunId: string) => Promise<unknown>
      expireLeases: (input: Record<string, unknown>) => Promise<unknown>
    }
    hermesDesktop: {`

export function applyZero3AgentLifecycleRuntime() {
  copySources()
  patchFile('electron/main.ts', [
    {
      label: 'Agent Lifecycle runtime import',
      appliedMarker: "from './zero3/worker-runtime/v2/index'",
      from: "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR",
      to: "import { Zero3AgentLifecycleRuntime, Zero3AgentLifecycleStore, Zero3WorkflowWorkerRuntime, Zero3WorkflowWorkerStore } from './zero3/worker-runtime/v2/index'\nimport { Zero3WorkerStationManager, Zero3WorkerWakeupController, installCognitiveStoreWorkflow } from './zero3/workflow-runtime/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
    },
    {
      label: 'Agent Lifecycle composition after Execution Runtime',
      appliedMarker: 'const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(',
      from: 'const disposeZero3ExecutionIpc = registerExecutionDesktopIpc(zero3ExecutionRuntime)\n',
      to: 'const disposeZero3ExecutionIpc = registerExecutionDesktopIpc(zero3ExecutionRuntime)\n' + mainRuntime
    },
    {
      label: 'Remote Worker RPC composite runtime provider',
      appliedMarker: '}, () => zero3WorkerRpcRuntime())',
      from: '}, () => zero3WorkerAdmin())',
      to: '}, () => zero3WorkerRpcRuntime())'
    }
  ])
  patchFile('electron/preload.ts', [
    { label: 'Workflow Worker local admin preload', appliedMarker: "exposeInMainWorld('zero3WorkflowWorkers'", from: "contextBridge.exposeInMainWorld('hermesDesktop', {", to: preloadBridge }
  ])
  patchFile('src/global.d.ts', [
    { label: 'Workflow Worker local admin renderer types', appliedMarker: '    zero3WorkflowWorkers: {', from: '    hermesDesktop: {', to: globalBridge }
  ])
}

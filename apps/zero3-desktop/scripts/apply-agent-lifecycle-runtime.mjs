import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'worker-runtime', 'v2')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'worker-runtime', 'v2')

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
}

const mainRuntime = String.raw`
const zero3AgentLifecycleStore = new Zero3AgentLifecycleStore(path.join(app.getPath('userData'), 'zero3', 'agent-lifecycle.sqlite3'))
const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(
  zero3AgentLifecycleStore,
  {
    listTasks: async () => await zero3ExecutionRuntime.listTasks() as any[],
    getTask: taskId => zero3ExecutionRuntime.getTask(taskId),
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
async function zero3WorkerRpcRuntime() {
  const v1 = await zero3WorkerAdmin()
  return {
    registerWorker: input => v1.registerWorker(input),
    claimWork: input => v1.claimWork(input),
    reportProgress: input => v1.reportProgress(input),
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
    handoffCreate: input => zero3AgentLifecycleRuntime.handoffCreate(input)
  }
}
app.on('before-quit', () => zero3AgentLifecycleStore.close())
`

export function applyZero3AgentLifecycleRuntime() {
  copySources()
  patchFile('electron/main.ts', [
    {
      label: 'Agent Lifecycle runtime import',
      appliedMarker: "from './zero3/worker-runtime/v2/index'",
      from: "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR",
      to: "import { Zero3AgentLifecycleRuntime, Zero3AgentLifecycleStore } from './zero3/worker-runtime/v2/index'\n\nconst USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
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
}

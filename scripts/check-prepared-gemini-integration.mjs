import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const desktop = path.join(root, 'upstream', 'hermes-agent', 'apps', 'desktop')

function file(relative) { return path.join(desktop, ...relative.split('/')) }
function read(relative) { return fs.readFileSync(file(relative), 'utf8') }
function requireFile(relative) { if (!fs.statSync(file(relative)).isFile()) throw new Error(`prepared desktop is missing ${relative}`) }
function requireAll(source, relative, patterns) { for (const pattern of patterns) if (!source.includes(pattern)) throw new Error(`${relative}: prepared output is missing ${pattern}`) }
function forbid(source, relative, patterns) { for (const pattern of patterns) if (source.includes(pattern)) throw new Error(`${relative}: prepared output still contains forbidden marker ${pattern}`) }
function count(source, value) { return source.split(value).length - 1 }

const staged = [
  'electron/zero3/gemini-web/gemini-web-provider.ts',
  'electron/zero3/antigravity/antigravity-adapter.ts',
  'electron/zero3/agent-routing/agent-contracts.ts',
  'electron/zero3/agent-routing/agent-router.ts',
  'electron/zero3/agent-routing/agent-task-store.ts',
  'electron/zero3/agent-routing/git-authority.ts',
  'electron/zero3/agent-routing/agent-runtime-orchestrator.ts',
  'electron/zero3/agent-routing/agent-recovery-controller.ts',
  'electron/zero3/agent-routing/codex-task-adapter.ts',
  'electron/zero3/agent-routing/authoritative-result-finalizer.ts',
  'electron/zero3/agent-routing/verification-collector.ts',
  'electron/zero3/agent-routing/task-prompt.ts',
  'electron/zero3/agent-routing/task-mcp-candidate-store.ts',
  'electron/zero3/agent-desktop-bridge/bridge.ts',
  'electron/zero3/artifacts/artifact-store.ts',
  'electron/zero3/artifacts/antigravity-mcp-lease.ts',
  'electron/zero3/mcp/task-mcp-server.mjs',
  'electron/zero3/mcp/project-context-server.mjs',
  'electron/zero3/remote-host/remote-task-runner.ts',
  'src/app/chat/sidebar/gpt-web-handoff-actions.tsx',
  'src/app/chat/sidebar/gemini-session-section.tsx'
]
for (const relative of staged) requireFile(relative)

const mainPath = 'electron/main.ts'
const main = read(mainPath)
requireAll(main, mainPath, [
  "import { Zero3RemoteNode, Zero3RemoteTaskRunner } from './zero3/remote-host/index'",
  'Zero3TaskMcpCandidateStore',
  'zero3ResultCandidatesEqual',
  'renderZero3AgentTaskPrompt',
  'assertZero3GitPreflight',
  'const zero3TaskAwareAntigravity = {',
  'const zero3FixAwareCodex = {',
  'const zero3TaskMcpCandidates = new Zero3TaskMcpCandidateStore(zero3AgentTaskStateRoot)',
  'const zero3AgentMcpLeases = new Map',
  'async function zero3ResetAntigravityRuntime',
  'await zero3TaskMcpCandidates.beginTurn(taskId)',
  'const lease = new Zero3AntigravityMcpLease()',
  'await lease.install({',
  'zero3AgentMcpLeases.set(started.turnId',
  'consumeResult(scoped.taskId)',
  'Antigravity terminal structured output conflicts with the task-scoped MCP result candidate.',
  'finally { await scoped.lease.restore() }',
  'const zero3AgentRuntime = new Zero3AgentRuntimeOrchestrator({',
  'const zero3AgentRecovery = new Zero3AgentRecoveryController({',
  'const zero3AgentDesktopHandlers = createZero3AgentDesktopHandlers({',
  "ipcMain.handle('zero3:agent-tasks:dispatch'",
  "ipcMain.removeHandler('zero3:review:decision')",
  'AUTO fix cycle would change provider',
  'assertZero3GitPreflight(preflight, record.task.baseSha ?? null, true)',
  'assertZero3GitPreflight(preflight, task.baseSha ?? null, true)'
])
if (count(main, 'const zero3CodexAppServer = createZero3CodexAppServer()') !== 1) throw new Error('electron/main.ts: Codex App Server singleton count drifted')
const oldReview = main.indexOf("ipcMain.handle('zero3:review:decision'")
const removeReview = main.lastIndexOf("ipcMain.removeHandler('zero3:review:decision')")
const newReview = main.lastIndexOf("ipcMain.handle('zero3:review:decision'")
if (!(oldReview >= 0 && oldReview < removeReview && removeReview < newReview)) throw new Error('electron/main.ts: legacy review decision handler is not safely replaced by authoritative task-state handler')
forbid(main, mainPath, ["child_process.exec", 'shell: true'])

const preloadPath = 'electron/preload.ts'
const preload = read(preloadPath)
requireAll(preload, preloadPath, ["contextBridge.exposeInMainWorld('zero3AgentTask'", "contextBridge.exposeInMainWorld('zero3AgentTasks'", "ipcRenderer.invoke('zero3:agent-task:dispatch'", "ipcRenderer.invoke('zero3:agent-task:review-decision'", "ipcRenderer.invoke('zero3:agent-task:recovery-inspect'", "ipcRenderer.invoke('zero3:agent-task:recovery-resolve'", "ipcRenderer.invoke('zero3:agent-tasks:dispatch'"])

const globalPath = 'src/global.d.ts'
const global = read(globalPath)
requireAll(global, globalPath, ["type Zero3AgentTaskTarget = 'CODEX' | 'GEMINI' | 'AUTO'",'zero3AgentTask: {','zero3AgentTasks: {','recoveryInspect:','recoveryResolve:'])

const handoffPath = 'src/app/chat/sidebar/gpt-web-handoff-actions.tsx'
const handoff = read(handoffPath)
requireAll(handoff, handoffPath, ["completionGate: ['result.summary','git.clean','verification.no-failures','artifact.hashes']",'Commit intended changes and leave the isolated task worktree clean before reporting completion.','taskId: dispatched.taskId'])
forbid(handoff, handoffPath, ["completionGate: target === 'CODEX' ?", "['result.json.valid','scope.valid','review.packet.generated']"])

const geminiUiPath = 'src/app/chat/sidebar/gemini-session-section.tsx'
const geminiUi = read(geminiUiPath)
requireAll(geminiUi, geminiUiPath, ['CustomEvent<{ entryId: string; taskId?: string }>','if (detail?.taskId) setTaskId(detail.taskId)','诊断：直接启动 Antigravity'])
forbid(geminiUi, geminiUiPath, ['executeJavaScript(', 'sendInputEvent('])

const packagedBridge = read('electron/zero3/agent-desktop-bridge/bridge.ts')
requireAll(packagedBridge, 'electron/zero3/agent-desktop-bridge/bridge.ts', ["../agent-routing/agent-contracts"])
forbid(packagedBridge, 'electron/zero3/agent-desktop-bridge/bridge.ts', ['../agent-routing-runtime/agent-contracts'])

const packagedCandidate = read('electron/zero3/agent-routing/task-mcp-candidate-store.ts')
requireAll(packagedCandidate, 'electron/zero3/agent-routing/task-mcp-candidate-store.ts', ['beginTurn(taskIdValue','consumeResult(taskIdValue','task MCP result candidate identity mismatch','zero3ResultCandidatesEqual'])

const packagedArtifacts = read('electron/zero3/artifacts/artifact-store.ts')
requireAll(packagedArtifacts, 'electron/zero3/artifacts/artifact-store.ts', ["createHash('sha256')",'artifact index task identity mismatch','storageName(logicalTaskId)'])
const packagedLease = read('electron/zero3/artifacts/antigravity-mcp-lease.ts')
requireAll(packagedLease, 'electron/zero3/artifacts/antigravity-mcp-lease.ts', ["createHash('sha256')",'storageName(taskId)','this.taskSnapshotPath = null','await fs.unlink(taskSnapshotPath)','already installed or pending cleanup'])
const packagedTaskMcp = read('electron/zero3/mcp/task-mcp-server.mjs')
requireAll(packagedTaskMcp, 'electron/zero3/mcp/task-mcp-server.mjs', ["import { createHash } from 'node:crypto'",'storageName(id)','Zero3 task snapshot identity mismatch','artifact index task identity mismatch','review record task identity mismatch'])
const packagedProjectMcp = read('electron/zero3/mcp/project-context-server.mjs')
requireAll(packagedProjectMcp, 'electron/zero3/mcp/project-context-server.mjs', ["createHash('sha256')",'storageName(id)','invalid persisted project context','invalid persisted handoff'])

console.log('Prepared Gemini/Antigravity desktop composition gate passed.')
console.log(`Verified ${staged.length} staged runtime/UI files plus Electron main/preload/global/MCP composition.`)

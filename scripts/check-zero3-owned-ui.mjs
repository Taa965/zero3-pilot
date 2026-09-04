import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8')
}

function requireAll(source, markers, label) {
  const missing = markers.filter(marker => !source.includes(marker))
  if (missing.length) throw new Error(`${label} is missing required markers:\n${missing.map(marker => `- ${marker}`).join('\n')}`)
}

function reject(source, patterns, label) {
  for (const pattern of patterns) {
    if (pattern.test(source)) throw new Error(`${label} violates Zero3 owned-renderer policy: ${String(pattern)}`)
  }
}

const app = read('apps/zero3-desktop/zero3-ui/App.tsx')
const productApp = read('apps/zero3-desktop/zero3-ui/ProductApp.tsx')
const handoff = read('apps/zero3-desktop/zero3-ui/HandoffDock.tsx')
const projectDock = read('apps/zero3-desktop/zero3-ui/ProjectDock.tsx')
const taskDock = read('apps/zero3-desktop/zero3-ui/TaskDock.tsx')
const projectStore = read('apps/zero3-desktop/project-runtime/project-store.ts')
const projectOverlay = read('apps/zero3-desktop/scripts/apply-project-runtime.mjs')
const projectTaskOverlay = read('apps/zero3-desktop/scripts/apply-project-task-loop-runtime.mjs')
const workspaceOverlay = read('apps/zero3-desktop/scripts/apply-workspace-entry-runtime.mjs')
const contextMcp = read('apps/zero3-desktop/mcp-runtime/project-context-server.mjs')
const contextOverlay = read('apps/zero3-desktop/scripts/apply-project-context-mcp.mjs')
const taskStore = read('apps/zero3-desktop/agent-routing-runtime/agent-task-store.ts')
const agentBridge = read('apps/zero3-desktop/agent-desktop-bridge/bridge.ts')
const apply = read('apps/zero3-desktop/scripts/apply-zero3-owned-ui.mjs')
const prepare = read('apps/zero3-desktop/scripts/prepare-upstream.mjs')
const geminiPrepare = read('apps/zero3-desktop/scripts/prepare-gemini-integration.mjs')
const constitution = read('docs/ARCHITECTURE_CONSTITUTION.md')

requireAll(app, [
  'data-zero3-owned-renderer="three-column-v1"',
  'zero3Codex?: CodexBridge',
  'zero3Workspace?: WorkspaceBridge',
  'zero3GptWeb?: WebBridge',
  'zero3GeminiWeb?: WebBridge',
  "const APPROVAL_POLICY = 'on-request'",
  "const SANDBOX_POLICY = 'workspace-write'",
  'thread.list({ archived: false, limit: 100 })',
  'thread.read({ threadId, includeTurns: true })',
  'codex.turn.start({ threadId, text: value, approvalPolicy: APPROVAL_POLICY })',
  "method === 'item/commandExecution/requestApproval'",
  "method === 'item/tool/requestUserInput'",
  'bridge.setBounds({ id, bounds })'
], 'Zero3 three-column renderer')

requireAll(productApp, ['<App />', '<HandoffDock />', '<ProjectDock />', '<TaskDock />'], 'Zero3 product renderer composition')

requireAll(projectDock, [
  "ZERO3_ACTIVE_PROJECT_CHANGED = 'zero3:active-project-changed'",
  'bridge.getActive()',
  'bridge.create(payload)',
  'bridge.setActive({ id: project.id })',
  'defaultWorktreePath',
  'repositoryPath'
], 'Zero3 Project/Workspace manager')

requireAll(projectStore, [
  'ZERO3_PROJECT_REGISTRY_SCHEMA_VERSION',
  'async getActive()',
  'create(input: Zero3CreateProjectInput)',
  'setActive(idValue: unknown)',
  'defaultWorktreePath',
  'repositoryPath'
], 'Zero3 canonical project store')

requireAll(projectOverlay, [
  "contextBridge.exposeInMainWorld('zero3Projects'",
  "ipcMain.handle('zero3:projects:active:get'",
  "ipcMain.handle('zero3:projects:active:set'",
  'const zero3ProjectStore = new Zero3ProjectStore(',
  "import { Zero3ProjectStore } from './zero3/projects/index'"
], 'Zero3 typed project runtime bridge')

requireAll(contextMcp, [
  "'project_get_active'",
  'ZERO3_PROJECT_REGISTRY_FILE',
  'mergeCanonicalProject',
  'activeProjectId'
], 'Zero3 project-context MCP')
requireAll(contextOverlay, [
  'ZERO3_PROJECT_REGISTRY_FILE: zero3ProjectStore.registryFile()',
  "enabled_tools: ['project_get_active', 'project_get_context', 'handoff_get']",
  'const activeProject = await zero3ProjectStore.getActive()',
  'await zero3WithProjectContextMcp(method, params)'
], 'Zero3 active-project Codex injection')

requireAll(handoff, [
  "protocol: 'zero3.pilot.task-spec.v2'",
  'bridges.zero3AgentTasks.dispatch({ taskSpec, originEntryId: dispatchSource.id })',
  "completionGate: ['result.summary', 'git.clean', 'verification.no-failures', 'artifact.hashes']",
  'Commit intended changes and leave the isolated task worktree clean before reporting completion.',
  "target === 'GEMINI'",
  'bridges.zero3AgentTask.get({ taskId: id })',
  'bridges.zero3Projects?.getActive()',
  'bridges.zero3Workspace.setProject({ id: source.id, projectId: project.id })',
  'next?.defaultWorktreePath',
  'next?.baseRef ?? next?.defaultBranch'
], 'Zero3 project-aware real task handoff surface')

requireAll(taskStore, [
  'async list(input: Zero3AgentTaskListInput = {})',
  'projectId && record.task.projectId !== projectId',
  '.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))'
], 'Zero3 durable task list')
requireAll(agentBridge, [
  "taskList: 'zero3:agent-task:list'",
  "reviewGet: 'zero3:agent-task:review-get'",
  'taskList(request: unknown)',
  'reviewGet(request: unknown)'
], 'Zero3 task authority bridge')
requireAll(projectTaskOverlay, [
  'zero3AgentTaskStore.list(input as never)',
  'zero3ReviewStore.get(taskId)',
  'ZERO3_AGENT_DESKTOP_CHANNELS.taskList',
  'ZERO3_AGENT_DESKTOP_CHANNELS.reviewGet'
], 'Zero3 staged task list/review bridge')
requireAll(taskDock, [
  'bridges.tasks.list({ projectId: active?.id ?? null, limit: 300 })',
  'bridges.tasks.reviewGet({ taskId })',
  "protocol: 'zero3.pilot.review-decision.v1'",
  "decisionKind: 'APPROVED' | 'CHANGES_REQUESTED'",
  'CHANGES_REQUESTED 会进入现有同 Provider 自动返工链路'
], 'Zero3 durable task/review board')

requireAll(workspaceOverlay, [
  "ipcMain.handle('zero3:workspace:set-project'",
  "setProject: request => ipcRenderer.invoke('zero3:workspace:set-project', request)",
  'setProject: (request: { id: string; projectId: string | null }) => Promise<Zero3WorkspaceEntry>'
], 'Zero3 workspace project-binding bridge')

reject(app + '\n' + handoff + '\n' + projectDock + '\n' + taskDock, [
  /mockSessions/i,
  /sampleSessions/i,
  /fake execution/i,
  /danger-full-access/,
  /approvalPolicy:\s*['"]never['"]/
], 'Zero3 owned renderer')

requireAll(apply, [
  "write(path.join(hermesDesktopDir, 'src', 'main.tsx'), entry)",
  "import { ProductApp } from './zero3-ui/ProductApp'",
  'applyZero3ProjectTaskLoopRuntime()',
  "'ProjectDock.tsx'",
  "'TaskDock.tsx'",
  "'project-task.css'",
  "tsconfig.zero3-renderer.json",
  "packageJson.scripts.typecheck = 'tsc -p tsconfig.zero3-renderer.json --noEmit && tsc -p tsconfig.electron.json --noEmit'",
  "current.productRenderer = 'zero3-owned-three-column-v1'",
  "current.hermesRenderer = 'disabled'",
  "current.codexUi = 'disabled-app-server-only'"
], 'owned renderer staging overlay')

requireAll(prepare, ["import { applyZero3OwnedUi }", 'applyZero3OwnedUi()'], 'base desktop prepare')
requireAll(geminiPrepare, ["import { applyZero3OwnedUi }", 'applyZero3OwnedUi()'], 'Gemini integration prepare')
requireAll(constitution, ['Zero3-owned three-column renderer', 'Hermes React application/router', 'Codex stock UI/TUI'], 'architecture constitution')

console.log('Zero3 owned-renderer guard passed: sole three-column UI, active Project/Workspace context, real Codex/GPT/Gemini bridges, project-derived TaskSpec handoff and durable Task/Review board.')

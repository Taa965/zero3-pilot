import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function requireAll(source, relative, patterns) {
  for (const pattern of patterns) {
    if (!source.includes(pattern)) throw new Error(`${relative}: missing required architecture marker: ${pattern}`)
  }
}

function forbid(source, relative, patterns) {
  for (const pattern of patterns) {
    if (source.includes(pattern)) throw new Error(`${relative}: forbidden architecture marker present: ${pattern}`)
  }
}

const geminiTypesPath = 'apps/zero3-desktop/gemini-web-runtime/gemini-web-types.ts'
const geminiProviderPath = 'apps/zero3-desktop/gemini-web-runtime/gemini-web-provider.ts'
const antigravityPath = 'apps/zero3-desktop/antigravity-runtime/antigravity-adapter.ts'
const routerPath = 'apps/zero3-desktop/agent-routing-runtime/agent-router.ts'
const taskStorePath = 'apps/zero3-desktop/agent-routing-runtime/agent-task-store.ts'
const reviewPath = 'apps/zero3-desktop/agent-routing-runtime/review-loop-store.ts'
const gitPath = 'apps/zero3-desktop/agent-routing-runtime/git-authority.ts'
const verificationPath = 'apps/zero3-desktop/artifact-runtime/verification.ts'
const taskMcpPath = 'apps/zero3-desktop/mcp-runtime/task-mcp-server.mjs'
const uiPath = 'apps/zero3-desktop/gpt-web-ui/gemini-session-section.tsx'

const geminiTypes = read(geminiTypesPath)
requireAll(geminiTypes, geminiTypesPath, ["'persist:zero3-gemini'"])
forbid(geminiTypes, geminiTypesPath, ['persist:zero3-chatgpt'])

const geminiProvider = read(geminiProviderPath)
requireAll(geminiProvider, geminiProviderPath, [
  'new WebContentsView',
  'electronSession.fromPartition(ZERO3_GEMINI_WEB_PARTITION',
  'contextIsolation: true',
  'nodeIntegration: false',
  'sandbox: true',
  "const GEMINI_HOST = 'gemini.google.com'"
])
forbid(geminiProvider, geminiProviderPath, [
  'executeJavaScript(',
  'querySelector(',
  'sendInputEvent(',
  'persist:zero3-chatgpt',
  'chatgpt.com/backend-api',
  'gemini.google.com/_/BardChatUi/'
])

const antigravity = read(antigravityPath)
requireAll(antigravity, antigravityPath, [
  "'--input-format', 'stream-json'",
  "'--output-format', 'stream-json'",
  "status: 'OUTCOME_UNKNOWN'",
  'process exited before a terminal result',
  'authenticate with the official interactive agy client'
])
forbid(antigravity, antigravityPath, ['npx ', '@latest', 'GOOGLE_APPLICATION_CREDENTIALS=', 'refresh_token'])

const router = read(routerPath)
requireAll(router, routerPath, [
  'explicit targets are never silently changed',
  "const GEMINI_PREFERRED = new Set<Zero3TaskType>(['DESIGN', 'RESEARCH', 'REVIEW'])",
  "const CODEX_PREFERRED = new Set<Zero3TaskType>(['IMPLEMENT', 'VERIFY', 'FIX', 'INTEGRATE'])"
])

const taskStore = read(taskStorePath)
requireAll(taskStore, taskStorePath, [
  'agent task identity is immutable',
  'taskId is already bound to a different task/execution',
  'await fs.rename(temporary, target)'
])

const review = read(reviewPath)
requireAll(review, reviewPath, [
  'current review cycle already has an immutable decision',
  'ReviewDecision must target the current review cycle',
  "record.state = 'FIX_DISPATCHED'",
  'runtimeConversationId: record.binding.runtimeConversationId ?? null'
])
forbid(review, reviewPath, ['current.decision = null'])

const gitAuthority = read(gitPath)
requireAll(gitAuthority, gitPath, [
  'executor.execCommand({',
  "command: ['git', ...args]",
  "sandboxPolicy: { type: 'readOnly', networkAccess: false }",
  'task worktree must start clean'
])
forbid(gitAuthority, gitPath, ["from 'node:child_process'", 'execFile(', 'spawn('])

const verification = read(verificationPath)
requireAll(verification, verificationPath, [
  "'PASSED' | 'FAILED' | 'NOT_RUN' | 'BLOCKED'",
  'PASSED verification requires authoritative evidence or exitCode=0',
  'NOT_RUN verification requires a reason',
  'no terminal result was observed'
])

const taskMcp = read(taskMcpPath)
const tools = [...taskMcp.matchAll(/registerTool\('([^']+)'/g)].map(match => match[1])
const expectedTools = [
  'task_get',
  'project_get_context',
  'artifact_list',
  'artifact_get',
  'review_get',
  'task_publish_progress',
  'task_publish_result'
]
if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
  throw new Error(`${taskMcpPath}: task-scoped MCP surface drifted: ${JSON.stringify(tools)}`)
}
requireAll(taskMcp, taskMcpPath, [
  'cannot mutate review decisions',
  'Zero3 CompletionGate remains authoritative',
  "assertTask(id)",
  "assertProject(value)"
])
forbid(taskMcp, taskMcpPath, ['review_set', 'review_decision', 'completion_gate_set', 'shell_exec', 'run_command'])

const ui = read(uiPath)
forbid(ui, uiPath, ['executeJavaScript(', 'querySelector(', 'sendInputEvent('])
requireAll(ui, uiPath, ['zero3GeminiWeb', 'zero3Antigravity'])

console.log('Gemini/Antigravity architecture gate passed.')
console.log(`Checked ${10} provider/runtime/evidence/UI boundaries from ${process.cwd()}.`)

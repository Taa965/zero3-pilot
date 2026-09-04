import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')

function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8') }
function requireAll(source, relative, patterns) {
  for (const pattern of patterns) if (!source.includes(pattern)) throw new Error(`${relative}: missing required architecture marker: ${pattern}`)
}
function forbid(source, relative, patterns) {
  for (const pattern of patterns) if (source.includes(pattern)) throw new Error(`${relative}: forbidden architecture marker present: ${pattern}`)
}

const paths = {
  geminiTypes: 'apps/zero3-desktop/gemini-web-runtime/gemini-web-types.ts',
  geminiProvider: 'apps/zero3-desktop/gemini-web-runtime/gemini-web-provider.ts',
  antigravity: 'apps/zero3-desktop/antigravity-runtime/antigravity-adapter.ts',
  router: 'apps/zero3-desktop/agent-routing-runtime/agent-router.ts',
  taskStore: 'apps/zero3-desktop/agent-routing-runtime/agent-task-store.ts',
  review: 'apps/zero3-desktop/agent-routing-runtime/review-loop-store.ts',
  orchestrator: 'apps/zero3-desktop/agent-routing-runtime/agent-runtime-orchestrator.ts',
  recovery: 'apps/zero3-desktop/agent-routing-runtime/agent-recovery-controller.ts',
  codexAdapter: 'apps/zero3-desktop/agent-routing-runtime/codex-task-adapter.ts',
  git: 'apps/zero3-desktop/agent-routing-runtime/git-authority.ts',
  finalizer: 'apps/zero3-desktop/agent-routing-runtime/authoritative-result-finalizer.ts',
  verificationCollector: 'apps/zero3-desktop/agent-routing-runtime/verification-collector.ts',
  taskPrompt: 'apps/zero3-desktop/agent-routing-runtime/task-prompt.ts',
  mcpCandidate: 'apps/zero3-desktop/agent-routing-runtime/task-mcp-candidate-store.ts',
  bridge: 'apps/zero3-desktop/agent-desktop-bridge/bridge.ts',
  artifactStore: 'apps/zero3-desktop/artifact-runtime/artifact-store.ts',
  mcpLease: 'apps/zero3-desktop/artifact-runtime/antigravity-mcp-lease.ts',
  verification: 'apps/zero3-desktop/artifact-runtime/verification.ts',
  taskMcp: 'apps/zero3-desktop/mcp-runtime/task-mcp-server.mjs',
  projectMcp: 'apps/zero3-desktop/mcp-runtime/project-context-server.mjs',
  ui: 'apps/zero3-desktop/gpt-web-ui/gemini-session-section.tsx',
  integrationApply: 'apps/zero3-desktop/scripts/apply-agent-integration-runtime.mjs',
  reviewApply: 'apps/zero3-desktop/scripts/apply-agent-review-loop.mjs',
  worktreeApply: 'apps/zero3-desktop/scripts/apply-agent-worktree-guard.mjs',
  mcpLifecycleApply: 'apps/zero3-desktop/scripts/apply-agent-mcp-lifecycle.mjs',
  prepare: 'apps/zero3-desktop/scripts/prepare-gemini-integration.mjs'
}

const geminiTypes = read(paths.geminiTypes)
requireAll(geminiTypes, paths.geminiTypes, ["'persist:zero3-gemini'"])
forbid(geminiTypes, paths.geminiTypes, ['persist:zero3-chatgpt'])

const geminiProvider = read(paths.geminiProvider)
requireAll(geminiProvider, paths.geminiProvider, ['new WebContentsView','electronSession.fromPartition(ZERO3_GEMINI_WEB_PARTITION','contextIsolation: true','nodeIntegration: false','sandbox: true',"const GEMINI_HOST = 'gemini.google.com'"])
forbid(geminiProvider, paths.geminiProvider, ['executeJavaScript(', 'querySelector(', 'sendInputEvent(', 'persist:zero3-chatgpt', 'chatgpt.com/backend-api', 'gemini.google.com/_/BardChatUi/'])

const antigravity = read(paths.antigravity)
requireAll(antigravity, paths.antigravity, ["'--input-format', 'stream-json'","'--output-format', 'stream-json'","status: 'OUTCOME_UNKNOWN'",'process exited before a terminal result','authenticate with the official interactive agy client'])
forbid(antigravity, paths.antigravity, ['npx ', '@latest', 'GOOGLE_APPLICATION_CREDENTIALS=', 'refresh_token'])

const router = read(paths.router)
requireAll(router, paths.router, ['authenticated: boolean | null','explicit targets are never silently changed','provider runtime must verify authentication before sending the task prompt','authentication is not yet proven; AUTO fallback',"const GEMINI_PREFERRED = new Set<Zero3TaskType>(['DESIGN', 'RESEARCH', 'REVIEW'])", "const CODEX_PREFERRED = new Set<Zero3TaskType>(['IMPLEMENT', 'VERIFY', 'FIX', 'INTEGRATE'])"])

const taskStore = read(paths.taskStore)
requireAll(taskStore, paths.taskStore, ["createHash('sha256')",'agent task record identity mismatch','agent task identity is immutable','taskId is already bound to a different task/execution','await fs.rename(temporary, target)'])

const review = read(paths.review)
requireAll(review, paths.review, ["createHash('sha256')",'review record identity mismatch','current review cycle already has an immutable decision','ReviewDecision must target the current review cycle',"record.state = 'FIX_DISPATCHED'",'logicalSessionId: record.binding.targetLogicalSessionId','runtimeConversationId: record.binding.runtimeConversationId ?? null'])
forbid(review, paths.review, ['current.decision = null'])

const orchestrator = read(paths.orchestrator)
requireAll(orchestrator, paths.orchestrator, ['finalizeResult: (task: Zero3TaskSpecV2, candidate: Zero3ExecutionResultV2)','candidate = await this.deps.finalizeResult(task, candidate)',"case 'OUTCOME_UNKNOWN': return 'OUTCOME_UNKNOWN'",'targetLogicalSessionId: context.targetLogicalSessionId'])
forbid(orchestrator, paths.orchestrator, ["from 'node:child_process'", 'shell: true'])

const recovery = read(paths.recovery)
requireAll(recovery, paths.recovery, ["export type Zero3RecoveryResolution = 'KEEP_UNKNOWN' | 'ACCEPT_PARTIAL' | 'MARK_FAILED'","record.state === 'OUTCOME_UNKNOWN' || record.result?.status === 'OUTCOME_UNKNOWN'",'recovery controller requires state and ExecutionResultV2 to both be OutcomeUnknown',"recoveredResult(before, 'PARTIAL'", "recoveredResult(before, 'FAILED'",'automatic retry is forbidden while OutcomeUnknown is unresolved'])

const codexAdapter = read(paths.codexAdapter)
requireAll(codexAdapter, paths.codexAdapter, ["protocol: 'zero3.pilot.remote-task.v1'","'codex.turn.completed'","'git.preflight'","'git.postflight'","'execution.result'","if (task.completionGate.includes('git.clean')) evidence.add('git.clean')","providerRuntime: 'CODEX_LOCAL'"])
forbid(codexAdapter, paths.codexAdapter, ['required_evidence: [...task.completionGate]', "from 'node:child_process'"])

const gitAuthority = read(paths.git)
requireAll(gitAuthority, paths.git, ['executor.execCommand({',"command: ['git', ...args]","sandboxPolicy: { type: 'readOnly', networkAccess: false }","['rev-parse', '--git-dir']","['rev-parse', '--git-common-dir']",'linkedWorktree','writable agent tasks require an isolated linked Git worktree','task worktree must start clean'])
forbid(gitAuthority, paths.git, ["from 'node:child_process'", 'execFile(', 'spawn('])

const finalizer = read(paths.finalizer)
requireAll(finalizer, paths.finalizer, ['OutcomeUnknown is unresolved; authoritative completion finalization is intentionally withheld.','verifyArtifact(task, artifact)','collectVerification(task, candidate)',"case 'git.clean'","case 'artifact.hashes'","case 'verification.all-passed'",'unknown completion gate or missing verification evidence','changedFiles: git ? [...git.changedFiles] : []'])

const verificationCollector = read(paths.verificationCollector)
requireAll(verificationCollector, paths.verificationCollector, ['this.executor.execCommand({',"sandboxPolicy: { type: 'readOnly', networkAccess: false }","state: 'PASSED'","state: 'FAILED'","state: 'BLOCKED'",'verification could not be proven through Codex command/exec'])
forbid(verificationCollector, paths.verificationCollector, ["from 'node:child_process'", 'shell: true'])

const taskPrompt = read(paths.taskPrompt)
requireAll(taskPrompt, paths.taskPrompt, ['ZERO3_TASK_EXECUTION_ENVELOPE:','Do not infer task instructions from ChatGPT or Gemini webpage DOM.','commit the intended task changes and leave the task worktree clean','Zero3 independently re-runs authoritative verification through Codex command/exec','If a FixRequest is present, address every requiredFix in the same logical task/session'])

const mcpCandidate = read(paths.mcpCandidate)
requireAll(mcpCandidate, paths.mcpCandidate, ["createHash('sha256')",'beginTurn(taskIdValue','consumeResult(taskIdValue','task MCP result candidate identity mismatch','await unlinkIfPresent(file)','zero3ResultCandidatesEqual'])

const bridge = read(paths.bridge)
requireAll(bridge, paths.bridge, ["taskGet: 'zero3:agent-task:get'","dispatch: 'zero3:agent-task:dispatch'","reviewDecision: 'zero3:agent-task:review-decision'","recoveryInspect: 'zero3:agent-task:recovery-inspect'","recoveryResolve: 'zero3:agent-task:recovery-resolve'","value === 'KEEP_UNKNOWN' || value === 'ACCEPT_PARTIAL' || value === 'MARK_FAILED'"])
forbid(bridge, paths.bridge, ['shell', 'command:', 'credential', 'token'])

const artifactStore = read(paths.artifactStore)
requireAll(artifactStore, paths.artifactStore, ["createHash('sha256')",'artifact index task identity mismatch','storageName(logicalTaskId)','artifact source is outside the task workspace'])

const mcpLease = read(paths.mcpLease)
requireAll(mcpLease, paths.mcpLease, ["createHash('sha256')",'storageName(taskId)','this.taskSnapshotPath = null','await fs.unlink(taskSnapshotPath)','Antigravity MCP lease is already installed or pending cleanup'])

const verification = read(paths.verification)
requireAll(verification, paths.verification, ["'PASSED' | 'FAILED' | 'NOT_RUN' | 'BLOCKED'",'PASSED verification requires authoritative evidence or exitCode=0','NOT_RUN verification requires a reason','no terminal result was observed'])

const taskMcp = read(paths.taskMcp)
const tools = [...taskMcp.matchAll(/registerTool\('([^']+)'/g)].map(match => match[1])
const expectedTools = ['task_get','project_get_context','artifact_list','artifact_get','review_get','task_publish_progress','task_publish_result']
if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) throw new Error(`${paths.taskMcp}: task-scoped MCP surface drifted: ${JSON.stringify(tools)}`)
requireAll(taskMcp, paths.taskMcp, ['cannot mutate review decisions','Zero3 CompletionGate remains authoritative','assertTask(id)','assertProject(value)','storageName(id)','Zero3 task snapshot identity mismatch','artifact index task identity mismatch','review record task identity mismatch'])
forbid(taskMcp, paths.taskMcp, ['review_set', 'review_decision', 'completion_gate_set', 'shell_exec', 'run_command'])

const projectMcp = read(paths.projectMcp)
requireAll(projectMcp, paths.projectMcp, ["createHash('sha256')",'storageName(id)','invalid persisted project context','invalid persisted handoff'])

const ui = read(paths.ui)
forbid(ui, paths.ui, ['executeJavaScript(', 'querySelector(', 'sendInputEvent('])
requireAll(ui, paths.ui, ['zero3GeminiWeb', 'zero3Antigravity'])

const integrationApply = read(paths.integrationApply)
requireAll(integrationApply, paths.integrationApply, ['new Zero3RemoteTaskRunner','new Zero3AgentRuntimeOrchestrator','new Zero3AuthoritativeResultFinalizer','new Zero3VerificationCollector',"contextBridge.exposeInMainWorld('zero3AgentTask'", "contextBridge.exposeInMainWorld('zero3AgentTasks'", "ipcMain.removeHandler('zero3:review:decision')",'zero3AgentDesktopHandlers.reviewDecision(request)'])
forbid(integrationApply, paths.integrationApply, ["from 'node:child_process'", 'shell: true'])

const reviewApply = read(paths.reviewApply)
requireAll(reviewApply, paths.reviewApply, ['renderZero3AgentTaskPrompt(record.task, fixRequest)','renderZero3AgentTaskPrompt(task, fixRequest)','AUTO fix cycle would change provider',"completionGate: ['result.summary','git.clean','verification.no-failures','artifact.hashes']",'Commit intended changes and leave the isolated task worktree clean before reporting completion.','taskId: dispatched.taskId'])

const worktreeApply = read(paths.worktreeApply)
requireAll(worktreeApply, paths.worktreeApply, ['assertZero3GitPreflight(preflight, record.task.baseSha ?? null, true)','assertZero3GitPreflight(preflight, task.baseSha ?? null, true)'])

const mcpLifecycleApply = read(paths.mcpLifecycleApply)
requireAll(mcpLifecycleApply, paths.mcpLifecycleApply, ['new Zero3TaskMcpCandidateStore(zero3AgentTaskStateRoot)','await zero3TaskMcpCandidates.beginTurn(taskId)','consumeResult(scoped.taskId)','Antigravity terminal structured output conflicts with the task-scoped MCP result candidate.','await lease.install({','finally { await scoped.lease.restore() }'])

const prepare = read(paths.prepare)
requireAll(prepare, paths.prepare, ['applyZero3AgentIntegrationRuntime()','applyZero3AgentReviewLoop()','applyZero3AgentWorktreeGuard()','applyZero3AgentMcpLifecycle()'])
if (!(prepare.indexOf('applyZero3AgentIntegrationRuntime()') < prepare.indexOf('applyZero3AgentReviewLoop()') && prepare.indexOf('applyZero3AgentReviewLoop()') < prepare.indexOf('applyZero3AgentWorktreeGuard()') && prepare.indexOf('applyZero3AgentWorktreeGuard()') < prepare.indexOf('applyZero3AgentMcpLifecycle()'))) {
  throw new Error(`${paths.prepare}: final integration/review/worktree/MCP overlay order drifted`)
}

console.log('Gemini/Antigravity architecture gate passed.')
console.log(`Checked ${Object.keys(paths).length} provider/runtime/evidence/UI/integration boundaries from ${process.cwd()}.`)

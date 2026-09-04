import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()

function read(relative) {
  const file = path.join(repoRoot, ...relative.split('/'))
  if (!fs.existsSync(file)) throw new Error(`Development Group architecture guard missing required file: ${relative}`)
  return fs.readFileSync(file, 'utf8')
}

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Development Group architecture guard: missing ${label}`)
}

function forbid(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`Development Group architecture guard: forbidden ${label}`)
}

const c1Dir = 'apps/zero3-desktop/group-runtime/contracts'
const c1Files = fs.readdirSync(path.join(repoRoot, c1Dir)).filter(name => name.endsWith('.ts')).sort()
if (c1Files.length < 3) throw new Error('Development Group C1 contract surface unexpectedly small')

const facade = read('apps/zero3-desktop/group-runtime/runtime/runtime-facade.ts')
requireText(facade, 'mandatoryCommandIds:', 'mandatory verification binding')
requireText(facade, 'initialIntegratedSessionIds', 'durable integration restart seed')
requireText(facade, 'outcomeUnknownCount', 'OutcomeUnknown gate')
requireText(facade, 'deliveryMaterializer', 'post-executor Delivery materialization')
requireText(facade, 'DevelopmentGroupWorkerSupervisor', 'non-blocking worker supervision')
forbid(facade, /spawn\s*\(|exec\s*\(|execFile\s*\(/u, 'second process/shell authority in Runtime Facade')
forbid(facade, /codex\s+app-server|@openai\/codex/iu, 'second Codex kernel in Runtime Facade')

const supervisor = read('apps/zero3-desktop/group-runtime/runtime/worker-supervisor.ts')
requireText(supervisor, 'markOutcomeUnknown', 'supervisor fail-closed ambiguity handling')
forbid(supervisor, /setInterval|setTimeout\([^,]+,\s*0\)/u, 'polling/retry loop in worker supervisor')

const lifecycle = read('apps/zero3-desktop/group-runtime/runtime/session-lifecycle.ts')
requireText(lifecycle, 'runtime_restart_without_authoritative_executor_outcome', 'restart ambiguity evidence')
requireText(lifecycle, "transition(runtime, 'outcome_unknown'", 'restart OutcomeUnknown transition')

const deliveryGate = read('apps/zero3-desktop/group-runtime/workspace/delivery-gate.ts')
requireText(deliveryGate, 'handoffWorkspaceFingerprint', 'R4E-compatible Handoff fingerprint')
requireText(deliveryGate, 'verifyHandoff(checkpoint, observed)', 'Handoff verification')
forbid(deliveryGate, /dirtyWorktreeFingerprint:\s*fingerprint/u, 'P03 fingerprint being reused as R4E Handoff fingerprint')

const handoffStore = read('apps/zero3-desktop/executor-runtime/handoff/handoff-store.ts')
requireText(handoffStore, "createHash('sha256')", 'unsafe logical identity path encoding')
requireText(handoffStore, 'parsed.task_id !== taskId', 'logical task identity verification after storage encoding')
requireText(handoffStore, 'parsed.execution_id !== executionId', 'logical execution identity verification after storage encoding')

const desktopPort = read('apps/zero3-desktop/group-runtime/desktop/desktop-port.ts')
const desktopIpc = read('apps/zero3-desktop/group-runtime/desktop/desktop-ipc.ts')
const expectedChannels = [
  'zero3:development-group:list',
  'zero3:development-group:get',
  'zero3:development-group:create',
  'zero3:development-group:start-wave',
  'zero3:development-group:integrate-delivery',
  'zero3:development-group:run-verification',
  'zero3:development-group:completion-proof',
  'zero3:development-group:complete'
]
for (const channel of expectedChannels) requireText(desktopPort, `'${channel}'`, `desktop channel ${channel}`)
forbid(desktopPort + desktopIpc, /generic|rpc\s*\(|executeCommand|shell|child_process|codex.*request\s*\(/iu, 'generic Renderer execution/RPC authority')
requireText(desktopIpc, 'plainRecord(request', 'create payload object validation')
requireText(desktopIpc, 'requiredId(groupId', 'Group identity validation')

const plugin = JSON.parse(read('plugins/zero3-development-group/.codex-plugin/plugin.json'))
if (plugin.name !== 'zero3-development-group') throw new Error('Development Group Plugin identity changed')
if (plugin.skills !== './skills/') throw new Error('Skills-only first-review bundle must point at ./skills/')
for (const forbiddenField of ['apps', 'app', 'mcp', 'mcpServers', 'connections']) {
  if (Object.hasOwn(plugin, forbiddenField)) throw new Error(`Skills-only first-review plugin must not require ${forbiddenField}`)
}

const skill = read('plugins/zero3-development-group/skills/development-group/SKILL.md')
requireText(skill, 'skills-only', 'skills-only review mode')
requireText(skill, '`NOT_RUN`', 'truthful NOT_RUN semantics')
requireText(skill, 'Never automatically retry an OutcomeUnknown operation', 'OutcomeUnknown non-retry rule')
requireText(skill, 'do not claim durable persistence', 'no fake persistence without runtime')
forbid(skill, /auth\.json|access[_ -]?token|refresh[_ -]?token/iu, 'credential handling in public Skill')

const reviewReadiness = read('plugins/zero3-development-group/REVIEW_READINESS.md')
requireText(reviewReadiness, 'First submission mode: **Skills only**.', 'first submission mode')
requireText(reviewReadiness, 'not blockers for the first Skills-only submission', 'MCP phase-2 non-blocker')

const reviewCases = read('plugins/zero3-development-group/REVIEW_TEST_CASES.md')
const positiveCount = (reviewCases.match(/^## Positive /gmu) ?? []).length
const negativeCount = (reviewCases.match(/^## Negative /gmu) ?? []).length
if (positiveCount !== 5 || negativeCount !== 3) throw new Error(`OpenAI review test spec must contain exactly 5 positive and 3 negative cases; got ${positiveCount}+${negativeCount}`)
requireText(reviewCases, '`NOT_RUN`', 'review NOT_RUN semantics')

const mcpServerPath = path.join(repoRoot, 'plugins', 'zero3-development-group', 'mcp-server', 'src', 'server.mjs')
if (fs.existsSync(mcpServerPath)) {
  const mcp = fs.readFileSync(mcpServerPath, 'utf8')
  const toolNames = [...mcp.matchAll(/name:\s*'(development_group_[a-z_]+)'/gu)].map(match => match[1])
  const expectedTools = [
    'development_group_create',
    'development_group_get',
    'development_group_list_sessions',
    'development_group_start_wave',
    'development_group_validate_delivery',
    'development_group_integrate_delivery',
    'development_group_run_verification',
    'development_group_get_completion_proof'
  ]
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) throw new Error(`MCP tool surface drift: ${JSON.stringify(toolNames)}`)
  requireText(mcp, 'fromJsonSchema', 'MCP v2 JSON schema registration')
  requireText(mcp, 'readOnlyHint:', 'MCP tool annotations')
  forbid(mcp, /child_process|execFile|spawn\s*\(|shell\s*:/u, 'shell/process authority in review-facing MCP server')
  forbid(mcp, /properties:\s*\{[^}]*command\s*:/su, 'arbitrary command input in MCP tool schema')
}

console.log('Development Group V1 architecture guard: PASS (static)')

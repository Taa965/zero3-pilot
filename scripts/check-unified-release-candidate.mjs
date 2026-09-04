import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()

function read(relative) {
  const file = path.join(root, ...relative.split('/'))
  if (!fs.existsSync(file)) throw new Error(`Unified release guard missing required file: ${relative}`)
  return fs.readFileSync(file, 'utf8')
}

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Unified release guard: missing ${label}`)
}

function requireOrder(source, values, label) {
  let cursor = -1
  for (const value of values) {
    const next = source.indexOf(value)
    if (next < 0) throw new Error(`Unified release guard: ${label} is missing ${value}`)
    if (next <= cursor) throw new Error(`Unified release guard: ${label} order drift at ${value}`)
    cursor = next
  }
}

const pkg = JSON.parse(read('apps/zero3-desktop/package.json'))
const expectedPrepare = 'node ./scripts/prepare-upstream.mjs && node ./scripts/prepare-gemini-integration.mjs && node ./scripts/prepare-codex-upstream.mjs'
if (pkg.scripts?.prepare !== expectedPrepare) {
  throw new Error(`Unified release guard: desktop prepare order changed: ${String(pkg.scripts?.prepare)}`)
}

const run = read('apps/zero3-desktop/scripts/run.mjs')
requireOrder(run, [
  "scripts', 'prepare-upstream.mjs",
  "scripts', 'prepare-gemini-integration.mjs",
  "scripts', 'prepare-codex-upstream.mjs"
], 'run.mjs prepare pipeline')
requireText(run, 'ZERO3_DESKTOP_ALREADY_PREPARED', 'acceptance prepared-tree reuse guard')

const geminiPrepare = read('apps/zero3-desktop/scripts/prepare-gemini-integration.mjs')
for (const call of [
  'applyZero3GeminiWebProvider()',
  'applyZero3AntigravityRuntime()',
  'applyZero3AgentRoutingRuntime()',
  'applyZero3ArtifactRuntime()',
  'applyZero3ProjectContextMcp()',
  'applyZero3GptWebUi()',
  'applyZero3AgentIntegrationRuntime()',
  'applyZero3AgentReviewLoop()',
  'applyZero3AgentWorktreeGuard()',
  'applyZero3AgentMcpLifecycle()'
]) requireText(geminiPrepare, call, `Gemini/agent overlay ${call}`)

const codexPrepare = read('apps/zero3-desktop/scripts/prepare-codex-upstream.mjs')
requireText(codexPrepare, "import { applyDevelopmentGroupBridge }", 'Development Group bridge import')
requireOrder(codexPrepare, ['applyDevelopmentGroupBridge()', 'prepareCodexOverlay('], 'final Codex/Development Group prepare')

const dgBridge = read('apps/zero3-desktop/scripts/apply-development-group-bridge.mjs')
requireText(dgBridge, "from: '    hermesDesktop: {'", 'provider-compatible Window type anchor')
requireText(dgBridge, 'copyProductionTree(executorSource', 'Executor authority staging')
requireText(dgBridge, 'copyProductionTree(groupSource', 'Development Group authority staging')
requireText(dgBridge, "from: 'const zero3CodexAppServer = createZero3CodexAppServer()\\n'", 'shared Codex singleton composition anchor')
requireText(dgBridge, "contextBridge.exposeInMainWorld('zero3DevelopmentGroup'", 'purpose-specific Development Group preload surface')

const reset = read('apps/zero3-desktop/scripts/reset-upstream.mjs')
requireText(reset, "path.join(hermesDesktopDir, 'electron', 'zero3')", 'whole generated Electron Zero3 tree reset')
requireText(reset, 'recursive: true, force: true', 'recursive generated-tree cleanup')
for (const generated of [
  'zero3-gpt-web-section.tsx',
  'gpt-web-handoff-actions.tsx',
  'gemini-session-section.tsx'
]) requireText(reset, generated, `generated UI reset for ${generated}`)

const remoteNode = read('apps/zero3-desktop/host-runtime/remote-node.ts')
const agentFinalizer = read('apps/zero3-desktop/agent-routing-runtime/authoritative-result-finalizer.ts')
const dgFacade = read('apps/zero3-desktop/group-runtime/runtime/runtime-facade.ts')
requireText(remoteNode, 'Zero3RemoteTaskRunner', 'Remote Host authoritative task runner')
requireText(agentFinalizer, 'completionGate', 'TaskSpec completion gate finalizer')
requireText(dgFacade, 'mandatoryCommandIds:', 'Development Group mandatory verification binding')
requireText(dgFacade, 'outcomeUnknownCount', 'Development Group OutcomeUnknown gate')

for (const file of [
  'scripts/acceptance/development-group-windows.ps1',
  'scripts/acceptance/gemini-antigravity-windows.ps1',
  'docs/GeminiAntigravity/FINAL_ACCEPTANCE.md',
  'plugins/zero3-development-group/.codex-plugin/plugin.json'
]) read(file)

console.log('Unified Zero3 release candidate guard: PASS (static)')

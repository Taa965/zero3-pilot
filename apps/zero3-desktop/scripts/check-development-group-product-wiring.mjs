import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

function read(relative) {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8')
}

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Development Group wiring audit failed: missing ${label}`)
}

function forbidText(source, needle, label) {
  if (source.includes(needle)) throw new Error(`Development Group wiring audit failed: forbidden ${label}`)
}

const prepare = read('apps/zero3-desktop/scripts/prepare-upstream.mjs')
const overlay = read('apps/zero3-desktop/scripts/apply-development-group-runtime.mjs')
const service = read('apps/zero3-desktop/group-runtime/runtime/product-service.ts')
const inputBoundary = read('apps/zero3-desktop/group-runtime/runtime/product-input.ts')
const gitWorkspace = read('apps/zero3-desktop/group-runtime/workspace/git-workspace.ts')
const deliveryGate = read('apps/zero3-desktop/group-runtime/workspace/delivery-gate.ts')
const workspaceTests = read('apps/zero3-desktop/group-runtime/workspace/workspace.test.ts')
const prompt = read('apps/zero3-desktop/group-runtime/session/prompt-builder.ts')
const route = read('apps/zero3-desktop/renderer/development-group/register.tsx')
const page = read('apps/zero3-desktop/renderer/development-group/page.tsx')
const windowsCloseout = read('apps/zero3-desktop/scripts/windows-development-group-closeout.mjs')
const gitignore = read('.gitignore')
const policy = JSON.parse(read('.zero3/verification-policy.json'))

requireText(prepare, "import { applyZero3DevelopmentGroupRuntime } from './apply-development-group-runtime.mjs'", 'prepare import')
requireText(prepare, 'applyZero3DevelopmentGroupRuntime()', 'prepare invocation')
requireText(overlay, "new DevelopmentGroupProductService(\n  app.getPath('userData') + '/development-groups',\n  zero3CodexAppServer", 'shared Codex app-server composition')
requireText(overlay, 'validateDevelopmentGroupCreateRequest(request)', 'main-process create request validation')
requireText(overlay, 'normalizeRelativeTypeScriptSpecifiers', 'Hermes-compatible copied TypeScript import normalization')
requireText(overlay, "zero3:development-groups:delivery:finalize", 'bounded Delivery finalization IPC')
requireText(overlay, "zero3:development-groups:session:retry", 'bounded RepairTask retry IPC')
requireText(overlay, "import '@/zero3/development-group/register'", 'renderer contribution registration')
forbidText(overlay, 'zero3:development-groups:codex:request', 'generic Renderer to Codex RPC')
forbidText(overlay, 'acceptDelivery:', 'legacy renderer-supplied Delivery evidence bridge')

requireText(service, 'new NativeCodexExecutor(new NativeCodexAppServerDriver', 'Native Codex executor registration')
requireText(service, 'new DevelopmentSessionRunner(', 'direct Development Session runner composition')
requireText(service, 'buildHandoffCheckpoint({', 'main-process Handoff generation')
requireText(service, 'computeDeliveryHash(unsigned)', 'main-process Delivery hash generation')
requireText(service, 'attributeFailure(', 'failure attribution wiring')
requireText(service, 'planRepairWave({', 'bounded repair planning wiring')
requireText(service, 'async retrySession(', 'bounded Session retry entrypoint')
requireText(service, 'mergedDeliveryHashes', 'repair Delivery re-integration by delivery hash')
requireText(service, "status: 'outcome_unknown'", 'restart OutcomeUnknown reconciliation')
requireText(service, "shell: false", 'shellless verification execution')
requireText(service, 'verification policy changed after Group planning', 'frozen verification policy gate')
forbidText(service, 'zero3CodexAppServer.request(', 'second/direct Codex transport path')

requireText(inputBoundary, 'pathHints', 'Requirement ownership scope validation')
requireText(inputBoundary, 'must contain at least one item', 'missing ownership scope rejection')
requireText(inputBoundary, "['*', '**', '**/*', '**/**']", 'over-broad ownership scope rejection')
requireText(inputBoundary, "segments.includes('.git')", 'Git protected-path rejection')
requireText(inputBoundary, "segments.includes('.zero3')", 'Zero3 protected-path rejection')

requireText(gitWorkspace, "import { captureWorkspaceState }", 'shared Handoff fingerprint capture algorithm')
requireText(gitWorkspace, 'async handoffDirtyWorktreeFingerprint()', 'live Handoff-compatible worktree fingerprint adapter')
requireText(deliveryGate, 'git.handoffDirtyWorktreeFingerprint', 'Delivery Gate live Handoff re-sampling')
requireText(deliveryGate, 'handoffDirtyWorktreeFingerprint', 'separate Handoff fingerprint evidence')
requireText(workspaceTests, 'rejects a stale Handoff fingerprint', 'stale Handoff fingerprint regression test')

requireText(prompt, 'Commit all intended changes to the bound Session branch', 'clean committed delivery instruction')
requireText(prompt, 'product runtime, not agent text', 'runtime evidence authority instruction')
requireText(route, "ZERO3_DEVELOPMENT_GROUP_ROUTE = '/development-groups'", 'Development Group route')
requireText(route, "label: '开发组'", 'Development Group sidebar navigation')
requireText(page, 'finalizeDelivery', 'Delivery finalization UI')
requireText(page, 'retrySession', 'bounded repair retry UI')
requireText(page, 'parseRequirementLines', 'Requirement ownership scope parser')
requireText(page, 'Requirement 标题 | 仓库相对路径范围', 'ownership scope UI guidance')
forbidText(page, 'handoff JSON', 'manual Handoff paste UI')
requireText(gitignore, '/.zero3/worktrees/', 'managed worktree ignore rule')

requireText(windowsCloseout, "process.platform !== 'win32'", 'Windows-only authentic closeout guard')
requireText(windowsCloseout, 'ZERO3_EXPECTED_SHA', 'exact candidate SHA pin')
requireText(windowsCloseout, "test:desktop:platforms", 'prepared Electron platform tests')
forbidText(windowsCloseout, "test:desktop:all", 'stale Hermes.exe package acceptance')
requireText(windowsCloseout, "path.join(unpackedRoot, 'Zero3Pilot.exe')", 'Zero3 unpacked executable evidence')
requireText(windowsCloseout, "path.join(resources, 'zero3-codex', 'codex.exe')", 'bundled Codex evidence')
requireText(windowsCloseout, 'smoke-codex-app-server.mjs', 'real bundled Codex app-server smoke')
requireText(windowsCloseout, 'INSTALLER_SHA256=', 'installer SHA-256 evidence output')
requireText(windowsCloseout, 'needsShell(file)', 'Windows command-wrapper handling')

if (policy.schema !== 'zero3.pilot.verification-policy.v1') throw new Error('Development Group wiring audit failed: verification policy schema mismatch')
if (typeof policy.revision !== 'string' || !policy.revision.trim()) throw new Error('Development Group wiring audit failed: verification policy revision missing')
if (!Array.isArray(policy.commands) || policy.commands.length < 2) throw new Error('Development Group wiring audit failed: verification policy must contain the static audit and typecheck')
const requiredIds = new Set(policy.commands.filter(command => command.required === true).map(command => command.id))
for (const id of ['development-group-product-audit', 'desktop-typecheck']) {
  if (!requiredIds.has(id)) throw new Error(`Development Group wiring audit failed: required verification command missing: ${id}`)
}

console.log('Development Group V1 product wiring static audit: PASS')

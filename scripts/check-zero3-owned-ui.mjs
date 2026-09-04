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

requireAll(productApp, ['<App />', '<HandoffDock />'], 'Zero3 product renderer composition')

requireAll(handoff, [
  "protocol: 'zero3.pilot.task-spec.v2'",
  'bridges.zero3AgentTasks.dispatch({ taskSpec, originEntryId: source.id })',
  "completionGate: ['result.summary', 'git.clean', 'verification.no-failures', 'artifact.hashes']",
  'Commit intended changes and leave the isolated task worktree clean before reporting completion.',
  "target === 'GEMINI'",
  'bridges.zero3AgentTask.get({ taskId: id })'
], 'Zero3 real task handoff surface')

reject(app + '\n' + handoff, [
  /mockSessions/i,
  /sampleSessions/i,
  /fake execution/i,
  /danger-full-access/,
  /approvalPolicy:\s*['"]never['"]/
], 'Zero3 owned renderer')

requireAll(apply, [
  "write(path.join(hermesDesktopDir, 'src', 'main.tsx'), entry)",
  "import { ProductApp } from './zero3-ui/ProductApp'",
  "tsconfig.zero3-renderer.json",
  "packageJson.scripts.typecheck = 'tsc -p tsconfig.zero3-renderer.json --noEmit && tsc -p tsconfig.electron.json --noEmit'",
  "current.productRenderer = 'zero3-owned-three-column-v1'",
  "current.hermesRenderer = 'disabled'",
  "current.codexUi = 'disabled-app-server-only'"
], 'owned renderer staging overlay')

requireAll(prepare, ["import { applyZero3OwnedUi }", 'applyZero3OwnedUi()'], 'base desktop prepare')
requireAll(geminiPrepare, ["import { applyZero3OwnedUi }", 'applyZero3OwnedUi()'], 'Gemini integration prepare')
requireAll(constitution, ['Zero3-owned three-column renderer', 'Hermes React application/router', 'Codex stock UI/TUI'], 'architecture constitution')

console.log('Zero3 owned-renderer guard passed: one three-column product UI, real Codex/GPT/Gemini bridges, real TaskSpec handoff, and retired Hermes/Codex renderers outside the product entrypoint/typecheck surface.')

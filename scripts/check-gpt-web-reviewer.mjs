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
    if (pattern.test(source)) throw new Error(`${label} contains forbidden reviewer transport behavior: ${String(pattern)}`)
  }
}

const reviewer = read('apps/zero3-desktop/gpt-web-runtime/gpt-web-reviewer.ts')
const overlay = read('apps/zero3-desktop/scripts/apply-gpt-web-reviewer-bridge.mjs')
const taskStore = read('apps/zero3-desktop/agent-routing-runtime/agent-task-store.ts')
const taskDock = read('apps/zero3-desktop/zero3-ui/TaskDock.tsx')
const prepare = read('apps/zero3-desktop/scripts/prepare-gemini-integration.mjs')

requireAll(reviewer, [
  'runZero3GptWebReview',
  'Accessibility.getFullAXTree',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Input.dispatchKeyEvent',
  'GPT Web reviewer found an existing unsent ChatGPT draft and refused to overwrite it',
  'ZERO3_REVIEW_DECISION',
  "transport: 'chatgpt-web-accessibility-cdp'",
  "decision === 'CHANGES_REQUESTED' && requiredFixes.length === 0"
], 'GPT Web accessibility reviewer')

reject(reviewer, [
  /executeJavaScript/,
  /querySelector/,
  /document\./,
  /Runtime\.evaluate/,
  /Network\./,
  /\/backend-api\//,
  /\/api\/conversation/,
  /danger-full-access/,
  /approvalPolicy:\s*['"]never['"]/
], 'GPT Web accessibility reviewer')

requireAll(overlay, [
  "import { runZero3GptWebReview, type Zero3GptWebReviewInput } from './gpt-web-reviewer'",
  'async review(idValue: unknown, input: Zero3GptWebReviewInput)',
  'zero3RunGptWebReviewerLoop',
  'zero3GptWebReviewSessionTails',
  'zero3WithGptWebReviewSessionLock',
  'zero3BuildGptWebReviewPacket',
  "command: ['git', 'diff', '--no-ext-diff', '--no-renames', '--unified=24'",
  "sandboxPolicy: { type: 'readOnly', networkAccess: false }",
  "source: 'codex-command-exec'",
  'zero3AgentTaskStore.setReviewAutomation(taskId',
  "status: 'QUEUED'",
  "status: 'RUNNING'",
  "status: 'SUCCEEDED'",
  "status: 'FAILED'",
  'zero3GptWeb.review(reviewSessionId',
  'zero3AgentDesktopHandlers.reviewDecision({',
  "ipcMain.handle('zero3:agent-task:review-gpt-web'",
  "reviewGptWeb: request => ipcRenderer.invoke('zero3:agent-task:review-gpt-web', request)",
  "console.warn('[zero3:gpt-web-reviewer]'",
  "gptWebReviewerConcurrency = 'serialized-per-bound-gpt-session'",
  "gptWebReviewerEvidence = 'authoritative-codex-command-exec-git-diff'"
], 'GPT Web reviewer runtime overlay')

reject(overlay, [
  /executeJavaScript/,
  /querySelector/,
  /\/backend-api\//,
  /\/api\/conversation/,
  /fetch\(['"]https:\/\/chatgpt\.com/
], 'GPT Web reviewer runtime overlay')

requireAll(taskStore, [
  "export type Zero3GptWebReviewAutomationStatus",
  "reviewAutomation?: Zero3GptWebReviewAutomation | null",
  'setReviewAutomation(taskId: string, update: Zero3ReviewAutomationUpdate)',
  'review automation attempts must be an integer',
  'review automation lastError must be a string or null'
], 'durable GPT Web reviewer task state')

requireAll(taskDock, [
  'reviewGptWeb(request: { taskId: string })',
  'reviewAutomation: ReviewAutomation | null',
  'retryGptWebReview',
  '重试 GPT Web 自动审核',
  '自动审核使用绑定的真实 ChatGPT 会话，并串行处理同一会话的多个任务',
  '由 Codex read-only command/exec 采集的真实 Git diff'
], 'GPT Web reviewer task board recovery surface')

const ownedUiIndex = prepare.indexOf('applyZero3OwnedUi()')
const reviewerIndex = prepare.indexOf('applyZero3GptWebReviewerBridge()')
if (ownedUiIndex < 0 || reviewerIndex < 0 || reviewerIndex <= ownedUiIndex) {
  throw new Error('GPT Web reviewer must attach after the final Zero3-owned UI/project-task composition')
}

console.log('GPT Web reviewer guard passed: real bound ChatGPT Web review is session-serialized, draft-safe, fed authoritative read-only Git diff evidence, persists failure/retry state, and never calls DOM selectors or private ChatGPT APIs.')

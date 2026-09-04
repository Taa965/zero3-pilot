import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 review-loop overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function stagePromptRenderer() {
  const source = path.join(repoRoot, 'apps', 'zero3-desktop', 'agent-routing-runtime', 'task-prompt.ts')
  const target = path.join(hermesDesktopDir, 'electron', 'zero3', 'agent-routing', 'task-prompt.ts')
  if (!fs.statSync(source).isFile()) throw new Error(`Zero3 TaskSpec prompt renderer missing: ${source}`)
  write(target, read(source))
}

const fixAwareRuntime = String.raw`
const zero3TaskAwareAntigravity = {
  startTurn: async (input: { logicalSessionId: string; projectId?: string | null; cwd: string; prompt: string; taskId?: string | null; contextVersion?: number | null }) => {
    const taskId = input.taskId?.trim()
    if (!taskId) throw new Error('Task-aware Antigravity dispatch requires taskId')
    const record = await zero3AgentTaskStore.get(taskId)
    if (!record) throw new Error('Task-aware Antigravity dispatch could not load the durable TaskSpec')
    const review = await zero3ReviewStore.get(taskId)
    const fixRequest = review?.state === 'FIX_DISPATCHED' ? await zero3ReviewStore.latestFixRequest(taskId) : null
    return zero3Antigravity.startTurn({
      ...input,
      prompt: renderZero3AgentTaskPrompt(record.task, fixRequest)
    })
  },
  waitTurn: (turnId: string) => zero3Antigravity.waitTurn(turnId)
}
const zero3FixAwareCodex = {
  dispatchTask: async (task: Zero3AgentTaskSpecV2) => {
    const review = await zero3ReviewStore.get(task.taskId)
    const fixRequest = review?.state === 'FIX_DISPATCHED' ? await zero3ReviewStore.latestFixRequest(task.taskId) : null
    if (!fixRequest) return zero3CodexTaskAdapter.dispatchTask(task)
    return zero3CodexTaskAdapter.dispatchTask({
      ...task,
      type: 'FIX',
      goal: renderZero3AgentTaskPrompt(task, fixRequest)
    })
  }
}
`

const fixAwareDecision = String.raw`submitReviewDecision: async (taskId, decision, contextVersion) => {
    const decided = await zero3AgentRuntime.submitReviewDecision(taskId, decision, contextVersion)
    if (decided.state !== 'FIX_DISPATCHED') return decided
    if (!decided.binding) throw new Error('FixRequest cannot execute without a durable cross-agent binding')
    if (decided.task.target === 'AUTO') {
      const nextRoute = zero3AgentRouter.resolve(decided.task, await zero3ProviderAvailability())
      if (nextRoute.target !== decided.resolvedTarget) {
        throw new Error('AUTO fix cycle would change provider; explicit human routing is required before continuing')
      }
    }
    return zero3AgentRuntime.dispatch(decided.task, {
      targetLogicalSessionId: decided.binding.targetLogicalSessionId,
      reviewSessionId: decided.binding.reviewSessionId ?? null,
      runtimeConversationId: decided.binding.runtimeConversationId ?? null
    })
  },`

export function applyZero3AgentReviewLoop() {
  stagePromptRenderer()
  patchFile('electron/main.ts', [
    {
      label: 'TaskSpec prompt renderer import',
      from: "import { Zero3ReviewLoopStore, Zero3AgentRouter, Zero3AgentTaskStore, Zero3AgentRuntimeOrchestrator, Zero3AgentRecoveryController, Zero3CodexTaskAdapter, Zero3AuthoritativeResultFinalizer, Zero3VerificationCollector, zero3GitEvidence } from './zero3/agent-routing/index'",
      to: "import { Zero3ReviewLoopStore, Zero3AgentRouter, Zero3AgentTaskStore, Zero3AgentRuntimeOrchestrator, Zero3AgentRecoveryController, Zero3CodexTaskAdapter, Zero3AuthoritativeResultFinalizer, Zero3VerificationCollector, zero3GitEvidence, renderZero3AgentTaskPrompt } from './zero3/agent-routing/index'"
    },
    {
      label: 'fix-aware runtime wrappers',
      from: 'const zero3CodexTaskAdapter = new Zero3CodexTaskAdapter(zero3LocalCodexRunner)',
      to: 'const zero3CodexTaskAdapter = new Zero3CodexTaskAdapter(zero3LocalCodexRunner)\n' + fixAwareRuntime
    },
    {
      label: 'task-aware Antigravity runtime',
      from: '  antigravity: zero3Antigravity,\n  codex: zero3CodexTaskAdapter,',
      to: '  antigravity: zero3TaskAwareAntigravity,\n  codex: zero3FixAwareCodex,'
    },
    {
      label: 'automatic same-provider FixRequest execution',
      from: '  submitReviewDecision: (taskId, decision, contextVersion) => zero3AgentRuntime.submitReviewDecision(taskId, decision, contextVersion),',
      to: '  ' + fixAwareDecision
    }
  ])

  patchFile('src/app/chat/sidebar/gpt-web-handoff-actions.tsx', [
    {
      label: 'TaskSpecV2 completion gate semantics',
      from: "        completionGate: target === 'CODEX' ? ['codex.turn.completed','git.preflight','git.postflight','execution.result'] : ['result.json.valid','scope.valid','review.packet.generated'],",
      to: "        completionGate: ['result.summary','git.clean','verification.no-failures','artifact.hashes'],"
    },
    {
      label: 'Gemini handoff task identity event',
      from: "          window.dispatchEvent(new CustomEvent('zero3:gemini-open-entry', { detail: { entryId: dispatched.webEntryId } }))",
      to: "          window.dispatchEvent(new CustomEvent('zero3:gemini-open-entry', { detail: { entryId: dispatched.webEntryId, taskId: dispatched.taskId } }))"
    },
    {
      label: 'clean-worktree execution constraint',
      from: "          'Preserve provider/runtime authority boundaries and publish structured evidence.'",
      to: "          'Preserve provider/runtime authority boundaries and publish structured evidence.',\n          'Commit intended changes and leave the isolated task worktree clean before reporting completion.'"
    }
  ])

  patchFile('src/app/chat/sidebar/gemini-session-section.tsx', [
    {
      label: 'Gemini task identity handoff listener',
      from:
        "      const detail = (event as CustomEvent<{ entryId: string }>).detail\n" +
        "      if (detail?.entryId) void activate(detail.entryId).catch(reason => setError(String(reason)))",
      to:
        "      const detail = (event as CustomEvent<{ entryId: string; taskId?: string }>).detail\n" +
        "      if (detail?.taskId) setTaskId(detail.taskId)\n" +
        "      if (detail?.entryId) void activate(detail.entryId).catch(reason => setError(String(reason)))"
    },
    {
      label: 'diagnostic direct-runtime label',
      from: '>启动 Antigravity</Button>',
      to: '>诊断：直接启动 Antigravity</Button>'
    }
  ])
}

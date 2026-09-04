import { applyZero3GeminiWebProvider } from './apply-gemini-web-provider.mjs'
import { applyZero3AntigravityRuntime } from './apply-antigravity-runtime.mjs'
import { applyZero3AgentRoutingRuntime } from './apply-agent-routing-runtime.mjs'
import { applyZero3ArtifactRuntime } from './apply-artifact-runtime.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'
import { applyZero3GptWebUi } from './apply-gpt-web-ui.mjs'
import { applyZero3AgentIntegrationRuntime } from './apply-agent-integration-runtime.mjs'
import { applyZero3AgentReviewLoop } from './apply-agent-review-loop.mjs'
import { applyZero3AgentWorktreeGuard } from './apply-agent-worktree-guard.mjs'
import { applyZero3AgentMcpLifecycle } from './apply-agent-mcp-lifecycle.mjs'
import { applyZero3OwnedUi } from './apply-zero3-owned-ui.mjs'
import { applyZero3GptWebReviewerBridge } from './apply-gpt-web-reviewer-bridge.mjs'
import { applyZero3GptWebReviewerRecovery } from './apply-gpt-web-reviewer-recovery.mjs'

// Ordering is intentional. P01-P06 land their narrow runtime/provider overlays first.
// Legacy Hermes renderer patches may still be applied while those seams are being split,
// but they are unreachable product code: the final UI pass restores the Zero3-owned
// three-column renderer. P2C then attaches the reviewer transport and restart recovery.
applyZero3GeminiWebProvider()
applyZero3AntigravityRuntime()
applyZero3AgentRoutingRuntime()
applyZero3ArtifactRuntime()
applyZero3ProjectContextMcp()
applyZero3GptWebUi()
applyZero3AgentIntegrationRuntime()
applyZero3AgentReviewLoop()
applyZero3AgentWorktreeGuard()
applyZero3AgentMcpLifecycle()
applyZero3OwnedUi()
applyZero3GptWebReviewerBridge()
applyZero3GptWebReviewerRecovery()

console.log('Zero3 Gemini/Antigravity integration overlays staged into the pinned desktop host.')
console.log('Zero3 three-column renderer is the sole product UI; GPT Web reviewer bridge and restart recovery are attached to the final runtime composition.')
console.log('Static staging only: no ChatGPT login, GPT Web review execution, Gemini execution, Windows build, or acceptance PASS is implied.')

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

// Ordering is intentional. P01-P06 land their narrow overlays first. The final
// integration overlay restages the current authoritative runtime sources. The
// review-loop patch binds TaskSpec/FixRequest semantics, the worktree pass makes
// isolated linked-worktree proof mandatory, and the last pass leases the bounded
// task MCP only for the formal Antigravity turn lifecycle.
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

console.log('Zero3 Gemini/Antigravity integration overlays staged into the pinned desktop shell.')
console.log('Static staging only: no Gemini login, Antigravity execution, Windows build, or acceptance PASS is implied.')

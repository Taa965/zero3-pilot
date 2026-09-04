import { applyZero3GeminiWebProvider } from './apply-gemini-web-provider.mjs'
import { applyZero3AntigravityRuntime } from './apply-antigravity-runtime.mjs'
import { applyZero3AgentRoutingRuntime } from './apply-agent-routing-runtime.mjs'
import { applyZero3ArtifactRuntime } from './apply-artifact-runtime.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'
import { applyZero3AgentIntegrationRuntime } from './apply-agent-integration-runtime.mjs'
import { applyZero3AgentReviewLoop } from './apply-agent-review-loop.mjs'
import { applyZero3AgentWorktreeGuard } from './apply-agent-worktree-guard.mjs'
import { applyZero3AgentMcpLifecycle } from './apply-agent-mcp-lifecycle.mjs'

// Ordering is intentional. This phase now stages only Gemini/Antigravity and
// shared runtime concerns. The legacy GPT Hermes-React presentation overlay is
// deliberately not re-applied here: the authoritative renderer is
// apps/zero3-desktop/renderer-v2 and it talks to zero3GptWeb directly.
applyZero3GeminiWebProvider()
applyZero3AntigravityRuntime()
applyZero3AgentRoutingRuntime()
applyZero3ArtifactRuntime()
applyZero3ProjectContextMcp()
applyZero3AgentIntegrationRuntime()
applyZero3AgentReviewLoop()
applyZero3AgentWorktreeGuard()
applyZero3AgentMcpLifecycle()

console.log('Zero3 Gemini/Antigravity runtime overlays staged into the pinned Electron host.')
console.log('Retired GPT Hermes-React UI is not restaged in this phase; renderer-v2 is the product UI.')
console.log('Static staging only: no Gemini login, Antigravity execution, Windows build, or acceptance PASS is implied.')

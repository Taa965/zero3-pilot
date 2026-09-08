import { applyZero3GeminiWebProvider } from './apply-gemini-web-provider.mjs'
import { applyZero3AntigravityRuntime } from './apply-antigravity-runtime.mjs'
import { applyZero3AgentRoutingRuntime } from './apply-agent-routing-runtime.mjs'
import { applyZero3ArtifactRuntime } from './apply-artifact-runtime.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'
import { applyZero3GptWebUi } from './apply-gpt-web-ui.mjs'
import { applyZero3AgentIntegrationRuntime } from './apply-agent-integration-runtime.mjs'
import { applyZero3AgentClaudeRuntime } from './apply-agent-claude-runtime.mjs'
import { applyZero3SessionProviderRuntime } from './apply-session-provider-runtime.mjs'
import { applyZero3AgentReviewLoop } from './apply-agent-review-loop.mjs'
import { applyZero3AgentWorktreeGuard } from './apply-agent-worktree-guard.mjs'
import { applyZero3AgentMcpLifecycle } from './apply-agent-mcp-lifecycle.mjs'
import { applyZero3UiV2 } from '../apply-zero3-ui-v2.mjs'

// Ordering is intentional. Session-provider runtime is staged only after Claude
// has been bound, because its readiness bridge probes the authoritative Claude
// adapter and the already-created Codex/Antigravity runtimes. UI v2 is copied
// last so its provider picker can rely on those renderer contracts.
applyZero3GeminiWebProvider()
applyZero3AntigravityRuntime()
applyZero3AgentRoutingRuntime()
applyZero3ArtifactRuntime()
applyZero3ProjectContextMcp()
applyZero3GptWebUi()
applyZero3AgentIntegrationRuntime()
applyZero3AgentClaudeRuntime()
applyZero3SessionProviderRuntime()
applyZero3AgentReviewLoop()
applyZero3AgentWorktreeGuard()
applyZero3AgentMcpLifecycle()
applyZero3UiV2()

console.log('Zero3 Gemini/Antigravity/Claude/session-provider integration overlays staged into the pinned desktop shell.')
console.log('Static staging only: provider login is user-driven and API keys stay in Electron safeStorage.')

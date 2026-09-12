import { applyZero3GeminiWebProvider } from './apply-gemini-web-provider.mjs'
import { applyZero3AntigravityRuntime } from './apply-antigravity-runtime.mjs'
import { applyZero3AgentRoutingRuntime } from './apply-agent-routing-runtime.mjs'
import { applyZero3ArtifactRuntime } from './apply-artifact-runtime.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'
import { applyZero3GptWebUi } from './apply-gpt-web-ui.mjs'
import { applyZero3AgentIntegrationRuntime } from './apply-agent-integration-runtime.mjs'
import { applyZero3AgentClaudeRuntime } from './apply-agent-claude-runtime.mjs'
import { applyZero3AgentZero3ApiRuntime } from './apply-agent-zero3-api-runtime.mjs'
import { applyZero3SessionProviderRuntime } from './apply-session-provider-runtime.mjs'
import { applyZero3AgentReviewLoop } from './apply-agent-review-loop.mjs'
import { applyZero3AgentWorktreeGuard } from './apply-agent-worktree-guard.mjs'
import { applyZero3AgentMcpLifecycle } from './apply-agent-mcp-lifecycle.mjs'
import { applyZero3UiV2 } from '../apply-zero3-ui-v2.mjs'
import { applyZero3WeixinRobotRuntime } from './apply-weixin-robot-runtime.mjs'

// Ordering is intentional. Session-provider runtime is staged only after Claude
// has been bound, because its readiness bridge probes the authoritative Claude
// adapter and the already-created Codex/Antigravity runtimes. The Zero3 API task
// executor is staged right after the Claude adapter so its composition block can
// anchor on the bound Claude adapter; it consumes the session-provider bridge
// that is inserted later in the same file (the bridge symbols are only touched
// at turn time, never during composition). UI v2 is copied last so its provider
// picker can rely on those renderer contracts.
applyZero3GeminiWebProvider()
applyZero3AntigravityRuntime()
applyZero3AgentRoutingRuntime()
applyZero3ArtifactRuntime()
applyZero3ProjectContextMcp()
applyZero3GptWebUi()
applyZero3AgentIntegrationRuntime()
applyZero3AgentClaudeRuntime()
applyZero3SessionProviderRuntime()
// The Zero3 API task executor is staged after the session-provider runtime: its
// availability probe and its turns reuse that runtime's API-profile bridge, and
// its unified Web GPT dispatch tool extends the worker RPC composite that the
// session-provider block defines.
applyZero3AgentZero3ApiRuntime()
applyZero3AgentReviewLoop()
applyZero3AgentWorktreeGuard()
applyZero3AgentMcpLifecycle()
applyZero3WeixinRobotRuntime()
applyZero3UiV2()

console.log('Zero3 Gemini/Antigravity/Claude/session-provider integration overlays staged into the pinned desktop shell.')
console.log('Static staging only: provider login is user-driven and API keys stay in Electron safeStorage.')

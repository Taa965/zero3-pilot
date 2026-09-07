import { applyZero3GeminiWebProvider } from './apply-gemini-web-provider.mjs'
import { applyZero3AntigravityRuntime } from './apply-antigravity-runtime.mjs'
import { applyZero3AgentRoutingRuntime } from './apply-agent-routing-runtime.mjs'
import { applyZero3ArtifactRuntime } from './apply-artifact-runtime.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'
import { applyZero3GptWebUi } from './apply-gpt-web-ui.mjs'
import { applyZero3AgentIntegrationRuntime } from './apply-agent-integration-runtime.mjs'
import { applyZero3AgentClaudeRuntime } from './apply-agent-claude-runtime.mjs'
import { applyZero3AgentReviewLoop } from './apply-agent-review-loop.mjs'
import { applyZero3AgentWorktreeGuard } from './apply-agent-worktree-guard.mjs'
import { applyZero3AgentMcpLifecycle } from './apply-agent-mcp-lifecycle.mjs'
import { applyZero3UiV2 } from '../apply-zero3-ui-v2.mjs'

// Ordering is intentional. P01-P06 land their narrow overlays first. The final
// integration overlay restages the current authoritative runtime sources. The
// Claude pass then binds the existing external executor into that authoritative
// Agent TaskSpec path with project-scoped MCP memory before review/worktree/MCP
// lifecycle hardening runs.
applyZero3GeminiWebProvider()
applyZero3AntigravityRuntime()
applyZero3AgentRoutingRuntime()
applyZero3ArtifactRuntime()
applyZero3ProjectContextMcp()
applyZero3GptWebUi()
applyZero3AgentIntegrationRuntime()
applyZero3AgentClaudeRuntime()
applyZero3AgentReviewLoop()
applyZero3AgentWorktreeGuard()
applyZero3AgentMcpLifecycle()
applyZero3UiV2()

console.log('Zero3 Gemini/Antigravity/Claude integration overlays staged into the pinned desktop shell.')
console.log('Static staging only: no provider login, live execution, Windows build, or acceptance PASS is implied.')

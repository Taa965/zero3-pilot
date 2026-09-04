import { applyZero3GeminiWebProvider } from './apply-gemini-web-provider.mjs'
import { applyZero3AntigravityRuntime } from './apply-antigravity-runtime.mjs'
import { applyZero3AgentRoutingRuntime } from './apply-agent-routing-runtime.mjs'
import { applyZero3ArtifactRuntime } from './apply-artifact-runtime.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'
import { applyZero3GptWebUi } from './apply-gpt-web-ui.mjs'
import { applyZero3AgentIntegrationRuntime } from './apply-agent-integration-runtime.mjs'

// Ordering is intentional. P01-P06 land their narrow overlays first. The final
// integration overlay then restages the current authoritative runtime sources
// and composes them only after every dependency and UI seam exists.
applyZero3GeminiWebProvider()
applyZero3AntigravityRuntime()
applyZero3AgentRoutingRuntime()
applyZero3ArtifactRuntime()
applyZero3ProjectContextMcp()
applyZero3GptWebUi()
applyZero3AgentIntegrationRuntime()

console.log('Zero3 Gemini/Antigravity integration overlays staged into the pinned desktop shell.')
console.log('Static staging only: no Gemini login, Antigravity execution, Windows build, or acceptance PASS is implied.')

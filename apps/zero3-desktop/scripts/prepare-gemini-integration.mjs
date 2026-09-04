import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'
import { applyZero3GeminiWebProvider } from './apply-gemini-web-provider.mjs'
import { applyZero3AntigravityRuntime } from './apply-antigravity-runtime.mjs'
import { applyZero3AgentRoutingRuntime } from './apply-agent-routing-runtime.mjs'
import { applyZero3ArtifactRuntime } from './apply-artifact-runtime.mjs'
import { applyZero3ProjectContextMcp } from './apply-project-context-mcp.mjs'
import { applyZero3GptWebUi } from './apply-gpt-web-ui.mjs'

const agentRoutingSourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'agent-routing-runtime')
const agentRoutingTargetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'agent-routing')

function stageLateAgentRoutingSources() {
  // P01-P06 landed the review/router overlay before the durable TaskSpec store and
  // Codex-authoritative Git evidence helper were added. Keep the historical
  // apply script stable and stage the later narrow sources here until the final
  // integration pass folds them into one overlay.
  for (const file of ['agent-task-store.ts', 'git-authority.ts']) {
    const source = path.join(agentRoutingSourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 agent-routing integration source missing: ${source}`)
    fs.mkdirSync(agentRoutingTargetDir, { recursive: true })
    fs.copyFileSync(source, path.join(agentRoutingTargetDir, file))
  }
}

// Ordering is intentional. Every step patches a narrower surface exposed by the
// previous one; do not parallelize these transformations inside one prepared
// Hermes tree.
applyZero3GeminiWebProvider()
applyZero3AntigravityRuntime()
applyZero3AgentRoutingRuntime()
stageLateAgentRoutingSources()
applyZero3ArtifactRuntime()
applyZero3ProjectContextMcp()
applyZero3GptWebUi()

console.log('Zero3 Gemini/Antigravity integration overlays staged into the pinned desktop shell.')
console.log('Static staging only: no Gemini login, Antigravity execution, Windows build, or acceptance PASS is implied.')

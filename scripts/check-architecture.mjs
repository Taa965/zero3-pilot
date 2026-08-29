import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8')
}

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message)
}

function forbidText(source, needle, message) {
  if (source.includes(needle)) throw new Error(message)
}

const constitution = read('docs/ARCHITECTURE_CONSTITUTION.md')
const readme = read('README.md')
const architecture = read('docs/ARCHITECTURE.md')
const desktopReadme = read('apps/zero3-desktop/README.md')
const prepare = read('apps/zero3-desktop/scripts/prepare-upstream.mjs')
const run = read('apps/zero3-desktop/scripts/run.mjs')
const externalAgents = read('crates/zero3-subagents/src/lib.rs')

requireText(
  constitution,
  'Open-source Codex is the single authoritative Agent Kernel',
  'Architecture constitution must keep open-source Codex as the single Agent Kernel.'
)
requireText(
  constitution,
  'Hermes Agent is a **UI/UX donor and desktop shell**',
  'Architecture constitution must classify Hermes as UI shell.'
)
requireText(
  constitution,
  'DeepSeek-Harness is a **capability donor**',
  'Architecture constitution must classify DeepSeek-Harness as a capability donor.'
)
requireText(
  constitution,
  'Multi-Agent Collaboration',
  'Architecture constitution must keep installed agents in Multi-Agent Collaboration.'
)

requireText(
  readme,
  'Open-source Codex = the only core Agent Kernel / runtime authority',
  'README product definition drifted away from Codex-core.'
)
requireText(
  architecture,
  'codex app-server',
  'Target architecture must use codex app-server.'
)
requireText(
  desktopReadme,
  'Hermes UI shell over Codex core',
  'Desktop README must keep Hermes as UI shell over Codex.'
)
requireText(
  externalAgents,
  'External Agent Collaboration adapters',
  'Legacy subagent crate must remain explicitly classified as external-agent infrastructure.'
)

const retiredDesktopRuntimeOverlays = [
  'applyZero3NativeBridge',
  'applyZero3NativeChat',
  'applyZero3NativeChatHardening',
  'applyZero3MemoryBridge',
  'applyZero3ScheduleBridge',
  'applyZero3ScheduleLifecycle',
  'applyZero3BrowserBridge'
]

for (const symbol of retiredDesktopRuntimeOverlays) {
  forbidText(
    prepare,
    symbol,
    `Architecture regression: prepare-upstream.mjs must not apply retired Zero3 Node desktop runtime overlay ${symbol}.`
  )
}

for (const needle of ['ensureZero3Node', 'zero3NodeBinary', 'ZERO3_PILOT_NODE_PORT']) {
  forbidText(
    run,
    needle,
    `Architecture regression: target desktop launcher must not own Zero3 Node (${needle}).`
  )
}

requireText(
  prepare,
  "coreRuntime: 'openai-codex-app-server'",
  'Desktop provenance must identify Codex app-server as the target core runtime.'
)
requireText(
  prepare,
  "desktopShell: 'hermes-electron-react'",
  'Desktop provenance must identify Hermes Electron/React as the shell.'
)
requireText(
  prepare,
  "deepseekRole: 'capability-donor'",
  'Desktop provenance must identify DeepSeek as capability donor.'
)

console.log('Zero3 architecture guard passed: Codex core / Hermes UI shell / DeepSeek capability donor / external-agent collaboration.')

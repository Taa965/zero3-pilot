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
const config = read('apps/zero3-desktop/scripts/config.mjs')
const codexTransport = read('apps/zero3-desktop/scripts/apply-codex-transport.mjs')
const codexPrimaryChat = read('apps/zero3-desktop/scripts/apply-codex-primary-chat.mjs')
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
  'Architecture constitution must classify DeepSeek-Harness as capability donor.'
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
forbidText(config, 'zero3NodeBinary', 'Target desktop config must not expose a Zero3 Node core-runtime binary helper.')

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
requireText(prepare, 'applyZero3CodexTransport()', 'Target desktop must apply the typed Codex app-server transport.')
requireText(prepare, 'applyZero3CodexPrimaryChat()', 'R2 target desktop must apply the Codex primary-chat adapter.')
requireText(run, 'ensurePinnedCodexBinary', 'Development launcher must build the pinned open-source Codex core.')
requireText(run, 'ZERO3_CODEX_BIN', 'Desktop launcher must pass the pinned Codex binary explicitly.')
requireText(config, 'resolveCodexHome', 'Zero3 must own an explicit Codex home boundary.')

for (const ipc of [
  'zero3:codex:thread:start',
  'zero3:codex:thread:resume',
  'zero3:codex:thread:list',
  'zero3:codex:thread:read',
  'zero3:codex:turn:start',
  'zero3:codex:turn:interrupt',
  'zero3:codex:server:respond'
]) {
  requireText(codexTransport, ipc, `Codex transport is missing typed IPC ${ipc}.`)
}

for (const required of [
  'window.zero3Codex.thread.start',
  'window.zero3Codex.thread.resume',
  'window.zero3Codex.thread.read',
  'window.zero3Codex.turn.start',
  'window.zero3Codex.turn.interrupt',
  "event.method === 'item/agentMessage/delta'",
  "event.method === 'turn/completed'",
  "const R2_SANDBOX = 'read-only'"
]) {
  requireText(codexPrimaryChat, required, `R2 Codex primary chat is missing required path: ${required}`)
}

for (const forbidden of [
  "ipcRenderer.invoke('zero3:codex:rpc'",
  "ipcRenderer.invoke('zero3:codex:request'",
  "ipcRenderer.invoke('zero3:codex:proxy'"
]) {
  forbidText(codexTransport, forbidden, 'Renderer must not receive a generic Codex JSON-RPC proxy.')
}

for (const forbidden of ['ZERO3_PILOT_NODE_PORT', "requestGateway('prompt.submit'", 'zero3:chat:turn']) {
  forbidText(
    codexPrimaryChat,
    forbidden,
    `R2 primary chat must not route core conversation execution through legacy runtime path: ${forbidden}`
  )
}

console.log('Zero3 architecture guard passed: pinned Codex app-server core / Codex primary chat / Hermes UI shell / DeepSeek donor / external-agent collaboration.')

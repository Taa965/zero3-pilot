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
const codexPrompts = read('apps/zero3-desktop/scripts/apply-codex-prompts.mjs')
const codexPromptHardening = read('apps/zero3-desktop/scripts/apply-codex-prompt-queue-hardening.mjs')
const codexItemRendering = read('apps/zero3-desktop/scripts/apply-codex-item-rendering.mjs')
const codexItemRenderingHardening = read('apps/zero3-desktop/scripts/apply-codex-item-rendering-hardening.mjs')
const codexMoreItems = read('apps/zero3-desktop/scripts/apply-codex-more-items.mjs')
const codexStructuredInput = read('apps/zero3-desktop/scripts/apply-codex-structured-input.mjs')
const codexStructuredInputHardening = read('apps/zero3-desktop/scripts/apply-codex-structured-input-hardening.mjs')
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
requireText(
  prepare,
  "promptPhase: 'R2B-codex-approval-input'",
  'Desktop provenance must identify the native Codex prompt migration phase.'
)
requireText(
  prepare,
  "itemRenderingPhase: 'R3A-codex-item-rendering'",
  'Desktop provenance must identify the native Codex Item rendering phase.'
)
requireText(
  prepare,
  "structuredInputPhase: 'R3C-codex-structured-input'",
  'Desktop provenance must identify the native Codex structured-input phase.'
)
requireText(prepare, 'applyZero3CodexTransport()', 'Target desktop must apply the typed Codex app-server transport.')
requireText(prepare, 'applyZero3CodexPrimaryChat()', 'R2 target desktop must apply the Codex primary-chat adapter.')
requireText(prepare, 'applyZero3CodexPrompts()', 'R2B target desktop must apply the Codex approval/input prompt adapter.')
requireText(
  prepare,
  'applyZero3CodexPromptQueueHardening()',
  'R2B target desktop must preserve queued prompt requests and awaiting-input shell state.'
)
requireText(
  prepare,
  'applyZero3CodexItemRendering()',
  'R3A target desktop must project native Codex Items into the Hermes-derived presentation layer.'
)
requireText(
  prepare,
  'applyZero3CodexItemRenderingHardening()',
  'R3A target desktop must preserve summary/file/status protocol semantics.'
)
requireText(
  codexItemRenderingHardening,
  'applyZero3CodexMoreItems()',
  'R3B native Item projection must be chained after the reviewed R3A projection hardening.'
)
requireText(
  prepare,
  'applyZero3CodexStructuredInput()',
  'R3C target desktop must apply the strictly typed Codex structured-input adapter.'
)
requireText(
  codexStructuredInput,
  'applyZero3CodexStructuredInputHardening()',
  'R3C structured input must chain the reviewed fail-closed hardening pass.'
)
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

for (const required of [
  "const R2_APPROVAL_POLICY = 'on-request' as const",
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  "async (decision: 'accept' | 'acceptForSession' | 'decline')",
  'respondResult(request.requestId, { decision })',
  'respondToServerRequest',
  'CodexPromptOverlay',
  'takeCodexPromptRequestIdsForThread'
]) {
  requireText(codexPrompts, required, `R2B Codex prompt bridge is missing required behavior: ${required}`)
}

for (const required of [
  'CodexApprovalRequest[]',
  'CodexUserInputRequest[]',
  'queue.some(entry => entry.requestId === request.requestId)',
  '$activeCodexAwaitingInput',
  '$codexApprovals.get()[key]?.length',
  '$codexUserInputs.get()[key]?.some(request => request.isBlocking)',
  'Codex runtime error ended the pending prompt.'
]) {
  requireText(
    codexPromptHardening,
    required,
    `R2B Codex prompt hardening is missing queue/cleanup/awaiting-input behavior: ${required}`
  )
}

for (const required of [
  'projectCodexAuxHistoryItem',
  'projectCodexAuxItemStarted',
  'projectCodexAuxItemCompleted',
  'projectCodexReasoningDelta',
  'projectCodexCommandOutputDelta',
  'projectCodexFilePatchUpdated',
  'projectCodexMcpProgress',
  'upsertToolPart',
  "name: 'terminal'",
  "name: 'patch'",
  "event.method === 'item/reasoning/summaryTextDelta'",
  "event.method === 'item/reasoning/textDelta'",
  "event.method === 'item/commandExecution/outputDelta'",
  "event.method === 'item/fileChange/patchUpdated'",
  "event.method === 'item/mcpToolCall/progress'"
]) {
  requireText(
    codexItemRendering,
    required,
    `R3A Codex Item projection is missing required native Item/notification mapping: ${required}`
  )
}

for (const required of [
  'projectCodexReasoningSummaryDelta',
  'resetToSummary',
  'firstSummaryDelta',
  '!reasoningSummaryItemsRef.current.has(itemId)',
  'const kind = record(entry.kind)',
  'kind.move_path',
  'Command execution declined.',
  'File change declined.',
  'nonEmptyString(record(value).message)'
]) {
  requireText(
    codexItemRenderingHardening,
    required,
    `R3A Item hardening is missing summary/file/status protocol semantics: ${required}`
  )
}

for (const required of [
  'dynamicToolPayload',
  'planPayload',
  'webSearchPayload',
  "item.type === 'dynamicToolCall'",
  "item.type === 'plan'",
  "item.type === 'webSearch'",
  "item.type === 'functionCallOutput'",
  "name: 'web_search'",
  "moreItemRenderingPhase = 'R3B-codex-more-items'"
]) {
  requireText(codexMoreItems, required, `R3B Codex Item projection is missing required mapping/policy: ${required}`)
}

for (const required of [
  'ZERO3_CODEX_MAX_TURN_INPUTS = 32',
  "type === 'text'",
  "type === 'localImage'",
  'type must be text or localImage',
  'text_elements: []',
  'zero3CodexTurnInputs',
  'CodexTurnInput',
  'attachmentContextText',
  'codexTurnInputs(text, attachments)',
  'optimisticAttachmentRef',
  'input: structuredInput',
  'input,'
]) {
  requireText(codexStructuredInput, required, `R3C structured input is missing required typed mapping: ${required}`)
}

for (const required of [
  "Object.prototype.hasOwnProperty.call(input, 'input')",
  "Object.prototype.hasOwnProperty.call(input, 'text')",
  'turn/start must contain exactly one of input or text',
  'terminalContextBlocksFromDraft',
  'terminalContexts'
]) {
  requireText(
    codexStructuredInputHardening,
    required,
    `R3C structured-input hardening is missing required fail-closed/context behavior: ${required}`
  )
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

for (const forbidden of ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment']) {
  forbidText(
    codexPrompts,
    forbidden,
    `R2B must not expose persistent Codex policy-amendment approval before dedicated policy UX: ${forbidden}`
  )
}

forbidText(
  codexPrompts,
  "event.method === 'item/tool/call'",
  'R3B must not execute client-hosted dynamic tools through the approval/input prompt dispatcher.'
)

for (const source of [codexItemRendering, codexItemRenderingHardening, codexMoreItems]) {
  for (const forbidden of ['ZERO3_PILOT_NODE_PORT', 'requestGateway(', 'zero3:chat:turn']) {
    forbidText(
      source,
      forbidden,
      `Codex Item projection must remain presentation-only and must not regain legacy runtime authority: ${forbidden}`
    )
  }
}

for (const forbidden of ['respondToServerRequest', "item/tool/call", 'ipcRenderer.invoke']) {
  forbidText(
    codexMoreItems,
    forbidden,
    `R3B Item presentation must not become a dynamic-tool execution transport: ${forbidden}`
  )
}

for (const source of [codexStructuredInput, codexStructuredInputHardening]) {
  for (const forbidden of ['ZERO3_PILOT_NODE_PORT', 'requestGateway(', 'zero3:chat:turn', 'ipcRenderer.invoke']) {
    forbidText(
      source,
      forbidden,
      `R3C structured input must stay inside the typed Codex boundary and must not regain legacy/generic runtime authority: ${forbidden}`
    )
  }
}

for (const forbidden of [
  "inputs.push({ type: 'image'",
  "inputs.push({ type: 'audio'",
  "inputs.push({ type: 'localAudio'",
  "inputs.push({ type: 'skill'",
  "inputs.push({ type: 'mention'"
]) {
  forbidText(
    codexStructuredInput,
    forbidden,
    `R3C Renderer input emitter must remain restricted to text/localImage: ${forbidden}`
  )
}

console.log('Zero3 architecture guard passed: pinned Codex app-server core / primary chat / queued native prompts / R3A+R3B native Item projection / R3C typed text+localImage input / Hermes UI shell / DeepSeek donor / external-agent collaboration.')

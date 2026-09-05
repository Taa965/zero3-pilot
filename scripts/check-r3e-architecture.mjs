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

const mapping = read('apps/zero3-desktop/scripts/apply-codex-turn-mapping.mjs')
const r3dHardening = read('apps/zero3-desktop/scripts/apply-codex-thread-actions-hardening.mjs')

for (const required of [
  "zero3:codex:thread:fork-at-turn",
  "zero3:codex:thread:revert-before-turn",
  "zero3CodexAppServer.request('thread/fork'",
  "zero3CodexAppServer.request('thread/revert'",
  "approvalPolicy: 'on-request'",
  "sandbox: 'read-only'",
  'findCodexMessageBoundary',
  'findCodexTurnUserBoundary',
  'findLatestCodexTurnUserBoundary',
  "window.zero3Codex.thread.read({ threadId, includeTurns: true })",
  'submittedUserTurnByMessageRef.current.set(userMessage.id',
  'boundary.role === \'user\'',
  '!boundary.isLastMessageInTurn',
  'boundary.soleUserInTurn',
  'boundary.hasImageInput',
  'revertBeforeTurn({ threadId, beforeTurnId: boundary.turnId })',
  'forkAtTurn({ threadId, lastTurnId: boundary.turnId })',
  "turnMappingPhase = 'R3E-codex-message-turn-mapping'"
]) {
  requireText(mapping, required, `R3E authoritative Turn mapping is missing required behavior: ${required}`)
}

requireText(
  r3dHardening,
  'applyZero3CodexTurnMapping()',
  'R3E must be applied only after the R3D whole-thread fork hardening boundary.'
)

for (const forbidden of [
  'ZERO3_PILOT_NODE_PORT',
  'requestGateway(',
  'zero3:chat:turn',
  "ipcRenderer.invoke('zero3:codex:rpc'",
  "ipcRenderer.invoke('zero3:codex:request'",
  "ipcRenderer.invoke('zero3:codex:proxy'",
  'messageIndex + 1',
  'turns[messageIndex]',
  'Date.now() ==='
]) {
  forbidText(mapping, forbidden, `R3E must not guess Turn identity or fall back to a legacy runtime: ${forbidden}`)
}

requireText(
  mapping,
  "message: 'Codex 的 fork 边界是 Turn；从 user 气泡分支会误包含同 Turn 的 assistant 回复，因此 R3E 暂不执行这个不等价操作。'",
  'R3E must fail closed for user-bubble branching because Codex fork is Turn-granular.'
)
requireText(
  mapping,
  "message: '该 assistant 消息后同一 Codex Turn 还有消息，无法精确按此气泡分支。'",
  'R3E must reject assistant-message boundaries that are not the final visible message of their Turn.'
)

console.log('R3E architecture guard passed: authoritative Thread/Turn/Item mapping / dedicated typed fork+revert / partial-Turn fail-closed behavior.')

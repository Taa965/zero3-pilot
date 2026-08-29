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

const history = read('apps/zero3-desktop/scripts/apply-codex-authoritative-history.mjs')
const r3dHardening = read('apps/zero3-desktop/scripts/apply-codex-thread-actions-hardening.mjs')

for (const required of [
  "zero3:codex:thread:turns-list",
  "zero3CodexAppServer.request('thread/turns/list'",
  "limit: 100",
  "sortDirection: 'asc'",
  "itemsView: 'full'",
  "thread.read({ threadId, includeTurns: false })",
  'window.zero3Codex.thread.turnsList',
  "turn.itemsView !== 'full'",
  'turnIds.has(turn.id)',
  'cursors.has(page.nextCursor)',
  'pageIndex < 512',
  'appendMessageProjection',
  'edited.sourceId',
  'edited.parentId',
  'boundary.soleUserInTurn',
  'boundary.hasImageInput',
  'revertBeforeTurn({ threadId, beforeTurnId: boundary.turnId })',
  "onEdit: edited => void (codexPrimaryChat.enabled ? codexPrimaryChat.editMessage(edited) : editMessage(edited))",
  "provenance.historyPhase = 'R3F-codex-authoritative-history'"
]) {
  requireText(history, required, `R3F authoritative history is missing required behavior: ${required}`)
}

for (const forbidden of [
  'ZERO3_PILOT_NODE_PORT',
  'requestGateway(',
  'session.history',
  'prompt.submit',
  'truncate_before_user_ordinal',
  'messageIndex + 1',
  'turns[messageIndex]',
  "ipcRenderer.invoke('zero3:codex:rpc'",
  "ipcRenderer.invoke('zero3:codex:request'",
  "ipcRenderer.invoke('zero3:codex:proxy'"
]) {
  forbidText(history, forbidden, `R3F must not fall back to Hermes Runtime, guessed history identity, or generic Codex RPC: ${forbidden}`)
}

const r3eIndex = r3dHardening.indexOf('applyZero3CodexTurnMapping()')
const r3fIndex = r3dHardening.indexOf('applyZero3CodexAuthoritativeHistory()')
if (r3eIndex < 0 || r3fIndex <= r3eIndex) {
  throw new Error('R3F must execute only after the R3E authoritative Message -> Turn mapping overlay.')
}

console.log('R3F architecture guard passed: paginated full-Turn rehydrate / Codex-native user edit / no Hermes rewind fallback / typed-only history IPC.')

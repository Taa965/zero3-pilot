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

const actions = read('apps/zero3-desktop/scripts/apply-codex-thread-actions.mjs')
const hardening = read('apps/zero3-desktop/scripts/apply-codex-thread-actions-hardening.mjs')
const structuredHardening = read('apps/zero3-desktop/scripts/apply-codex-structured-input-hardening.mjs')

for (const required of [
  "zero3:codex:thread:archive",
  "zero3:codex:thread:unarchive",
  "zero3:codex:thread:delete",
  "zero3:codex:thread:name:set",
  "zero3:codex:thread:fork",
  "zero3:codex:turn:steer",
  "zero3CodexAppServer.request('thread/archive'",
  "zero3CodexAppServer.request('thread/unarchive'",
  "zero3CodexAppServer.request('thread/delete'",
  "zero3CodexAppServer.request('thread/name/set'",
  "zero3CodexAppServer.request('thread/fork'",
  "zero3CodexAppServer.request('turn/steer'",
  "threadActionsPhase = 'R3D-codex-thread-actions'",
  'archiveThread',
  'deleteThread',
  'forkThread',
  'steerText'
]) {
  requireText(actions, required, `R3D native thread-action adapter is missing required behavior: ${required}`)
}

for (const required of [
  "approvalPolicy: 'on-request'",
  "sandbox: 'read-only'",
  "type Zero3CodexThreadForkRequest = { threadId: string }",
  "!window.zero3Codex && <AutoArchiveSetting />",
  'thread.parentThreadId == null',
  'thread.ephemeral !== true'
]) {
  requireText(hardening, required, `R3D hardening is missing required fail-closed behavior: ${required}`)
}

requireText(
  structuredHardening,
  'applyZero3CodexThreadActions()',
  'R3D thread actions must run after the R3C structured-input hardening boundary.'
)
requireText(
  structuredHardening,
  'applyZero3CodexThreadActionsHardening()',
  'R3D thread-action hardening must run after the R3D adapter.'
)

for (const source of [actions, hardening]) {
  for (const forbidden of [
    'ZERO3_PILOT_NODE_PORT',
    'requestGateway(',
    'zero3:chat:turn',
    "ipcRenderer.invoke('zero3:codex:rpc'",
    "ipcRenderer.invoke('zero3:codex:request'",
    "ipcRenderer.invoke('zero3:codex:proxy'"
  ]) {
    forbidText(source, forbidden, `R3D must remain inside typed Codex app-server IPC: ${forbidden}`)
  }
}

for (const forbidden of [
  "zero3:codex:thread:revert",
  "zero3:codex:thread:rollback",
  "zero3CodexAppServer.request('thread/revert'",
  "zero3CodexAppServer.request('thread/rollback'"
]) {
  forbidText(actions, forbidden, `R3D must not expose message-level revert/rollback before Turn-id mapping: ${forbidden}`)
}

console.log('R3D architecture guard passed: typed native Codex thread actions / read-only fork floor / no legacy runtime fallback / no premature message-level revert.')

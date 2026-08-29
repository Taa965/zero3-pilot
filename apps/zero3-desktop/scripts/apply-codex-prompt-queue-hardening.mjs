import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = fs.readFileSync(file, 'utf8')

  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Codex prompt queue drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R2B prompt-store generator before updating the pinned shell.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3CodexPromptQueueHardening() {
  patchFile('src/app/zero3-codex/prompt-store.ts', [
    {
      label: 'approval queue store',
      from: "export const $codexApprovals = atom<Record<string, CodexApprovalRequest>>({})",
      to: "export const $codexApprovals = atom<Record<string, CodexApprovalRequest[]>>({})"
    },
    {
      label: 'user-input queue store',
      from: "export const $codexUserInputs = atom<Record<string, CodexUserInputRequest>>({})",
      to: "export const $codexUserInputs = atom<Record<string, CodexUserInputRequest[]>>({})"
    },
    {
      label: 'approval queue projection',
      from:
        "export const codexApprovalForSession = (sessionId: string | null) =>\n" +
        "  computed($codexApprovals, requests => requests[keyFor(sessionId)] ?? null)",
      to:
        "export const codexApprovalForSession = (sessionId: string | null) =>\n" +
        "  computed($codexApprovals, requests => requests[keyFor(sessionId)]?.[0] ?? null)"
    },
    {
      label: 'user-input queue projection',
      from:
        "export const codexUserInputForSession = (sessionId: string | null) =>\n" +
        "  computed($codexUserInputs, requests => requests[keyFor(sessionId)] ?? null)",
      to:
        "export const codexUserInputForSession = (sessionId: string | null) =>\n" +
        "  computed($codexUserInputs, requests => requests[keyFor(sessionId)]?.[0] ?? null)"
    },
    {
      label: 'approval queue append',
      from:
        "export function setCodexApproval(request: CodexApprovalRequest): void {\n" +
        "  $codexApprovals.set({ ...$codexApprovals.get(), [keyFor(request.threadId)]: request })\n" +
        "}",
      to:
        "export function setCodexApproval(request: CodexApprovalRequest): void {\n" +
        "  const key = keyFor(request.threadId)\n" +
        "  const all = $codexApprovals.get()\n" +
        "  const queue = all[key] ?? []\n" +
        "  if (queue.some(entry => entry.requestId === request.requestId)) return\n" +
        "  $codexApprovals.set({ ...all, [key]: [...queue, request] })\n" +
        "}"
    },
    {
      label: 'approval queue clear',
      from:
        "export function clearCodexApproval(threadId: string, requestId?: CodexRequestId): void {\n" +
        "  const key = keyFor(threadId)\n" +
        "  const current = $codexApprovals.get()[key]\n" +
        "  if (!current || (requestId !== undefined && current.requestId !== requestId)) return\n" +
        "  const next = { ...$codexApprovals.get() }\n" +
        "  delete next[key]\n" +
        "  $codexApprovals.set(next)\n" +
        "}",
      to:
        "export function clearCodexApproval(threadId: string, requestId?: CodexRequestId): void {\n" +
        "  const key = keyFor(threadId)\n" +
        "  const all = $codexApprovals.get()\n" +
        "  const queue = all[key] ?? []\n" +
        "  if (!queue.length) return\n" +
        "  const remaining = requestId === undefined ? [] : queue.filter(entry => entry.requestId !== requestId)\n" +
        "  if (remaining.length === queue.length) return\n" +
        "  const next = { ...all }\n" +
        "  if (remaining.length) next[key] = remaining\n" +
        "  else delete next[key]\n" +
        "  $codexApprovals.set(next)\n" +
        "}"
    },
    {
      label: 'user-input queue append',
      from:
        "export function setCodexUserInput(request: CodexUserInputRequest): void {\n" +
        "  $codexUserInputs.set({ ...$codexUserInputs.get(), [keyFor(request.threadId)]: request })\n" +
        "}",
      to:
        "export function setCodexUserInput(request: CodexUserInputRequest): void {\n" +
        "  const key = keyFor(request.threadId)\n" +
        "  const all = $codexUserInputs.get()\n" +
        "  const queue = all[key] ?? []\n" +
        "  if (queue.some(entry => entry.requestId === request.requestId)) return\n" +
        "  $codexUserInputs.set({ ...all, [key]: [...queue, request] })\n" +
        "}"
    },
    {
      label: 'user-input queue clear',
      from:
        "export function clearCodexUserInput(threadId: string, requestId?: CodexRequestId): void {\n" +
        "  const key = keyFor(threadId)\n" +
        "  const current = $codexUserInputs.get()[key]\n" +
        "  if (!current || (requestId !== undefined && current.requestId !== requestId)) return\n" +
        "  const next = { ...$codexUserInputs.get() }\n" +
        "  delete next[key]\n" +
        "  $codexUserInputs.set(next)\n" +
        "}",
      to:
        "export function clearCodexUserInput(threadId: string, requestId?: CodexRequestId): void {\n" +
        "  const key = keyFor(threadId)\n" +
        "  const all = $codexUserInputs.get()\n" +
        "  const queue = all[key] ?? []\n" +
        "  if (!queue.length) return\n" +
        "  const remaining = requestId === undefined ? [] : queue.filter(entry => entry.requestId !== requestId)\n" +
        "  if (remaining.length === queue.length) return\n" +
        "  const next = { ...all }\n" +
        "  if (remaining.length) next[key] = remaining\n" +
        "  else delete next[key]\n" +
        "  $codexUserInputs.set(next)\n" +
        "}"
    },
    {
      label: 'take every queued prompt on terminal turn cleanup',
      from:
        "export function takeCodexPromptRequestIdsForThread(threadId: string): CodexRequestId[] {\n" +
        "  const ids: CodexRequestId[] = []\n" +
        "  const approval = $codexApprovals.get()[keyFor(threadId)]\n" +
        "  const input = $codexUserInputs.get()[keyFor(threadId)]\n" +
        "  if (approval) ids.push(approval.requestId)\n" +
        "  if (input) ids.push(input.requestId)\n" +
        "  clearCodexApproval(threadId)\n" +
        "  clearCodexUserInput(threadId)\n" +
        "  return ids\n" +
        "}",
      to:
        "export function takeCodexPromptRequestIdsForThread(threadId: string): CodexRequestId[] {\n" +
        "  const key = keyFor(threadId)\n" +
        "  const approvals = $codexApprovals.get()[key] ?? []\n" +
        "  const inputs = $codexUserInputs.get()[key] ?? []\n" +
        "  const ids = [...approvals.map(request => request.requestId), ...inputs.map(request => request.requestId)]\n" +
        "  clearCodexApproval(threadId)\n" +
        "  clearCodexUserInput(threadId)\n" +
        "  return ids\n" +
        "}"
    }
  ])
}

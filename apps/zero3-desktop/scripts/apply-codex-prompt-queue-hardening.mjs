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

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'prompt cleanup when Stop cannot resolve a live turn id',
      from: '    if (!turnId) return',
      to:
        "    if (!turnId) {\n" +
        "      await rejectPendingPrompts(threadId, 'Codex Stop could not resolve an active Turn; pending prompts were cancelled.')\n" +
        "      return\n" +
        "    }"
    },
    {
      label: 'prompt cleanup on Codex runtime error',
      from:
        "      if (event.method === 'error') {\n" +
        "        const message = errorMessage(params.error ?? params.message, 'Codex Runtime 错误')",
      to:
        "      if (event.method === 'error') {\n" +
        "        const message = errorMessage(params.error ?? params.message, 'Codex Runtime 错误')\n" +
        "        void rejectPendingPrompts(threadId, 'Codex runtime error ended the pending prompt.')"
    }
  ])

  patchFile('src/store/prompts.ts', [
    {
      label: 'Codex prompt stores in shell prompt state',
      from: "import { atom, computed, type ReadableAtom } from 'nanostores'",
      to:
        "import { atom, computed, type ReadableAtom } from 'nanostores'\n\n" +
        "import { $codexApprovals, $codexUserInputs } from '@/app/zero3-codex/prompt-store'"
    },
    {
      label: 'active Codex awaiting-input projection',
      from:
        "export const $activeSessionAwaitingInput = computed(\n" +
        "  [$clarifyRequest, $approvalRequest, $sudoRequest, $secretRequest],\n" +
        "  (clarify, approval, sudo, secret) => Boolean(clarify || approval || sudo || secret)\n" +
        ")",
      to:
        "const $activeCodexAwaitingInput = computed(\n" +
        "  [$codexApprovals, $codexUserInputs, $activeSessionId],\n" +
        "  (approvals, inputs, activeId) => {\n" +
        "    const key = keyFor(activeId)\n" +
        "    return Boolean(approvals[key]?.length || inputs[key]?.some(request => request.isBlocking))\n" +
        "  }\n" +
        ")\n\n" +
        "export const $activeSessionAwaitingInput = computed(\n" +
        "  [$clarifyRequest, $approvalRequest, $sudoRequest, $secretRequest, $activeCodexAwaitingInput],\n" +
        "  (clarify, approval, sudo, secret, codex) => Boolean(clarify || approval || sudo || secret || codex)\n" +
        ")"
    },
    {
      label: 'imperative Codex blocking prompt guard',
      from:
        "  return Boolean(approval.$all.get()[key] || sudo.$all.get()[key] || secret.$all.get()[key])",
      to:
        "  return Boolean(\n" +
        "    approval.$all.get()[key] ||\n" +
        "      sudo.$all.get()[key] ||\n" +
        "      secret.$all.get()[key] ||\n" +
        "      $codexApprovals.get()[key]?.length ||\n" +
        "      $codexUserInputs.get()[key]?.some(request => request.isBlocking)\n" +
        "  )"
    },
    {
      label: 'reactive Codex blocking prompt guard',
      from:
        "export const sessionBlockingPrompt = (sessionId: string | null) =>\n" +
        "  computed([approval.$all, sudo.$all, secret.$all], (approvals, sudos, secrets) => {\n" +
        "    const key = keyFor(sessionId)\n\n" +
        "    return Boolean(approvals[key] || sudos[key] || secrets[key])\n" +
        "  })",
      to:
        "export const sessionBlockingPrompt = (sessionId: string | null) =>\n" +
        "  computed(\n" +
        "    [approval.$all, sudo.$all, secret.$all, $codexApprovals, $codexUserInputs],\n" +
        "    (approvals, sudos, secrets, codexApprovals, codexInputs) => {\n" +
        "      const key = keyFor(sessionId)\n\n" +
        "      return Boolean(\n" +
        "        approvals[key] ||\n" +
        "          sudos[key] ||\n" +
        "          secrets[key] ||\n" +
        "          codexApprovals[key]?.length ||\n" +
        "          codexInputs[key]?.some(request => request.isBlocking)\n" +
        "      )\n" +
        "    }\n" +
        "  )"
    },
    {
      label: 'per-session Codex awaiting-input state',
      from:
        "export function sessionAwaitingInput(sessionId: string | null) {\n" +
        "  return computed([$clarifyRequests, approval.$all, sudo.$all, secret.$all], (clarify, approvals, sudos, secrets) => {\n" +
        "    const key = keyFor(sessionId)\n\n" +
        "    return Boolean(clarify[key] || approvals[key] || sudos[key] || secrets[key])\n" +
        "  })\n" +
        "}",
      to:
        "export function sessionAwaitingInput(sessionId: string | null) {\n" +
        "  return computed(\n" +
        "    [$clarifyRequests, approval.$all, sudo.$all, secret.$all, $codexApprovals, $codexUserInputs],\n" +
        "    (clarify, approvals, sudos, secrets, codexApprovals, codexInputs) => {\n" +
        "      const key = keyFor(sessionId)\n\n" +
        "      return Boolean(\n" +
        "        clarify[key] ||\n" +
        "          approvals[key] ||\n" +
        "          sudos[key] ||\n" +
        "          secrets[key] ||\n" +
        "          codexApprovals[key]?.length ||\n" +
        "          codexInputs[key]?.some(request => request.isBlocking)\n" +
        "      )\n" +
        "    }\n" +
        "  )\n" +
        "}"
    }
  ])
}

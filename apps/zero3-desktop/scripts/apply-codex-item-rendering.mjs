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
        `Zero3 Codex item-rendering drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3A overlay before updating the pinned Hermes source.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const itemProjectionSource = String.raw`import {
  appendReasoningPart,
  reasoningPart,
  type ChatMessage,
  type ChatMessagePart,
  type GatewayEventPayload,
  upsertToolPart
} from '@/lib/chat-messages'

type JsonRecord = Record<string, unknown>

type NormalizedFileChange = {
  path: string
  kind: string
  diff: string
}

const MAX_RUNNING_PREVIEW = 16_000

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
}

function itemId(item: JsonRecord): string | null {
  return nonEmptyString(item.id)
}

function reasoningText(item: JsonRecord): string {
  const summary = stringArray(item.summary).join('\n\n').trim()
  if (summary) return summary
  return stringArray(item.content).join('\n\n').trim()
}

function normalizeFileChanges(value: unknown): NormalizedFileChange[] {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => record(entry))
    .map(entry => ({
      path: nonEmptyString(entry.path) ?? '',
      kind: nonEmptyString(entry.kind) ?? '',
      diff: typeof entry.diff === 'string' ? entry.diff : ''
    }))
    .filter(change => change.path || change.diff)
}

function combinedDiff(changes: NormalizedFileChange[]): string {
  return changes
    .map(change => change.diff.trim())
    .filter(Boolean)
    .join('\n\n')
}

function safeToolToken(value: unknown, fallback: string): string {
  const raw = nonEmptyString(value) ?? fallback
  const normalized = raw.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return (normalized || fallback).slice(0, 80)
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function commandPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload {
  const status = nonEmptyString(item.status) ?? (phase === 'running' ? 'inProgress' : 'completed')
  const durationMs = typeof item.durationMs === 'number' ? item.durationMs : null
  return {
    id: itemId(item) ?? '',
    name: 'terminal',
    args: {
      command: typeof item.command === 'string' ? item.command : '',
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      source: item.source,
      command_actions: Array.isArray(item.commandActions) ? item.commandActions : [],
      process_id: nonEmptyString(item.processId),
      plugin_id: nonEmptyString(item.pluginId),
      script_path: nonEmptyString(item.scriptPath)
    },
    ...(phase === 'complete'
      ? {
          result: {
            output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
            exit_code: typeof item.exitCode === 'number' ? item.exitCode : null,
            status,
            process_id: nonEmptyString(item.processId),
            ...(durationMs !== null ? { duration_s: durationMs / 1000 } : {})
          },
          ...(status === 'failed' ? { error: true } : {})
        }
      : {})
  }
}

function fileChangeArgs(changes: NormalizedFileChange[]): Record<string, unknown> {
  return {
    changes,
    ...(changes.length === 1 ? { path: changes[0].path } : {}),
    ...(changes.length > 1 ? { context: changes.length + ' files' } : {})
  }
}

function fileChangePayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload {
  const changes = normalizeFileChanges(item.changes)
  const status = nonEmptyString(item.status) ?? (phase === 'running' ? 'inProgress' : 'completed')
  const inlineDiff = combinedDiff(changes)
  return {
    id: itemId(item) ?? '',
    name: 'patch',
    args: fileChangeArgs(changes),
    ...(phase === 'complete'
      ? {
          result: {
            status,
            files: changes.map(change => change.path).filter(Boolean),
            changes
          },
          ...(inlineDiff ? { inline_diff: inlineDiff } : {}),
          ...(status === 'failed' ? { error: true } : {})
        }
      : {})
  }
}

function mcpPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload {
  const server = nonEmptyString(item.server) ?? 'server'
  const tool = nonEmptyString(item.tool) ?? 'tool'
  const status = nonEmptyString(item.status) ?? (phase === 'running' ? 'inProgress' : 'completed')
  const durationMs = typeof item.durationMs === 'number' ? item.durationMs : null
  const result = record(item.result)
  const error = errorText(item.error)
  return {
    id: itemId(item) ?? '',
    name: 'mcp_' + safeToolToken(tool, 'tool'),
    args: {
      server,
      tool,
      arguments: item.arguments,
      context: server + ' / ' + tool,
      plugin_id: nonEmptyString(item.pluginId),
      read_only: item.readOnlyHint === true
    },
    ...(phase === 'complete'
      ? {
          result: {
            ...result,
            status,
            ...(durationMs !== null ? { duration_s: durationMs / 1000 } : {})
          },
          ...(status === 'failed' ? { error: error || true } : {})
        }
      : {})
  }
}

function toolPayload(item: JsonRecord, phase: 'running' | 'complete'): GatewayEventPayload | null {
  if (item.type === 'commandExecution') return commandPayload(item, phase)
  if (item.type === 'fileChange') return fileChangePayload(item, phase)
  if (item.type === 'mcpToolCall') return mcpPayload(item, phase)
  return null
}

function toolPartName(messages: ChatMessage[], id: string, fallback: string): string {
  const message = messages.find(entry => entry.id === id)
  const part = message?.parts.find(
    (entry): entry is Extract<ChatMessagePart, { type: 'tool-call' }> =>
      entry.type === 'tool-call' && entry.toolCallId === id
  )
  return part?.toolName || fallback
}

function toolPreview(messages: ChatMessage[], id: string): string {
  const message = messages.find(entry => entry.id === id)
  const part = message?.parts.find(
    (entry): entry is Extract<ChatMessagePart, { type: 'tool-call' }> =>
      entry.type === 'tool-call' && entry.toolCallId === id
  )
  const args = part?.args && typeof part.args === 'object' && !Array.isArray(part.args) ? (part.args as JsonRecord) : {}
  return typeof args.preview === 'string' ? args.preview : ''
}

function upsertToolMessage(
  messages: ChatMessage[],
  id: string,
  payload: GatewayEventPayload,
  phase: 'running' | 'complete',
  occurredAt: number
): ChatMessage[] {
  const index = messages.findIndex(message => message.id === id)
  const previous = index >= 0 ? messages[index] : undefined
  const parts = upsertToolPart(previous?.parts ?? [], payload, phase, occurredAt)
  const nextMessage: ChatMessage = {
    ...(previous ?? { id, role: 'assistant' as const, parts: [], timestamp: occurredAt }),
    id,
    role: 'assistant',
    parts,
    pending: phase === 'running',
    ...(phase === 'complete' ? { completedAt: occurredAt } : {})
  }

  if (index < 0) return [...messages, nextMessage]
  const next = [...messages]
  next[index] = nextMessage
  return next
}

function upsertReasoningMessage(
  messages: ChatMessage[],
  id: string,
  text: string,
  phase: 'running' | 'complete',
  occurredAt: number
): ChatMessage[] {
  const index = messages.findIndex(message => message.id === id)
  const previous = index >= 0 ? messages[index] : undefined
  const timestamp = previous?.timestamp ?? occurredAt
  const parts = text
    ? [reasoningPart(text, timestamp)]
    : previous?.parts ?? []
  const nextMessage: ChatMessage = {
    ...(previous ?? { id, role: 'assistant' as const, parts: [], timestamp }),
    id,
    role: 'assistant',
    parts,
    pending: phase === 'running',
    ...(phase === 'complete' ? { completedAt: occurredAt } : {})
  }

  if (index < 0) return [...messages, nextMessage]
  const next = [...messages]
  next[index] = nextMessage
  return next
}

export function projectCodexAuxHistoryItem(
  rawItem: unknown,
  pending: boolean,
  startedAt?: number,
  completedAt?: number
): ChatMessage | null {
  const item = record(rawItem)
  const id = itemId(item)
  if (!id) return null
  const start = startedAt ?? completedAt ?? Date.now() / 1000
  const end = completedAt ?? start

  if (item.type === 'reasoning') {
    const text = reasoningText(item)
    if (!text && !pending) return null
    return {
      id,
      role: 'assistant',
      parts: text ? [reasoningPart(text, start)] : [],
      pending,
      timestamp: start,
      ...(!pending ? { completedAt: end } : {})
    }
  }

  const payload = toolPayload(item, pending ? 'running' : 'complete')
  if (!payload) return null
  let parts = upsertToolPart([], toolPayload(item, 'running') ?? payload, 'running', start)
  if (!pending) parts = upsertToolPart(parts, payload, 'complete', end)
  return {
    id,
    role: 'assistant',
    parts,
    pending,
    timestamp: start,
    ...(!pending ? { completedAt: end } : {})
  }
}

export function projectCodexAuxItemStarted(messages: ChatMessage[], rawItem: unknown, occurredAt: number): ChatMessage[] {
  const item = record(rawItem)
  const id = itemId(item)
  if (!id) return messages

  if (item.type === 'reasoning') {
    const text = reasoningText(item)
    return text ? upsertReasoningMessage(messages, id, text, 'running', occurredAt) : messages
  }

  const payload = toolPayload(item, 'running')
  return payload ? upsertToolMessage(messages, id, payload, 'running', occurredAt) : messages
}

export function projectCodexAuxItemCompleted(
  messages: ChatMessage[],
  rawItem: unknown,
  occurredAt: number
): ChatMessage[] {
  const item = record(rawItem)
  const id = itemId(item)
  if (!id) return messages

  if (item.type === 'reasoning') {
    return upsertReasoningMessage(messages, id, reasoningText(item), 'complete', occurredAt)
  }

  const payload = toolPayload(item, 'complete')
  if (!payload) return messages

  if (!messages.some(message => message.id === id)) {
    messages = upsertToolMessage(messages, id, toolPayload(item, 'running') ?? payload, 'running', occurredAt)
  }
  return upsertToolMessage(messages, id, payload, 'complete', occurredAt)
}

export function projectCodexReasoningDelta(
  messages: ChatMessage[],
  id: string,
  delta: string,
  occurredAt: number
): ChatMessage[] {
  if (!delta) return messages
  const index = messages.findIndex(message => message.id === id)
  if (index < 0) {
    return [
      ...messages,
      {
        id,
        role: 'assistant',
        parts: [reasoningPart(delta, occurredAt)],
        pending: true,
        timestamp: occurredAt
      }
    ]
  }

  const message = messages[index]
  const next = [...messages]
  next[index] = {
    ...message,
    role: 'assistant',
    parts: appendReasoningPart(message.parts, delta, occurredAt),
    pending: true
  }
  return next
}

export function projectCodexCommandOutputDelta(messages: ChatMessage[], id: string, delta: string): ChatMessage[] {
  if (!delta) return messages
  const preview = (toolPreview(messages, id) + delta).slice(-MAX_RUNNING_PREVIEW)
  return upsertToolMessage(
    messages,
    id,
    { id, name: 'terminal', preview },
    'running',
    Date.now() / 1000
  )
}

export function projectCodexFilePatchUpdated(messages: ChatMessage[], id: string, rawChanges: unknown): ChatMessage[] {
  const changes = normalizeFileChanges(rawChanges)
  return upsertToolMessage(
    messages,
    id,
    { id, name: 'patch', args: fileChangeArgs(changes) },
    'running',
    Date.now() / 1000
  )
}

export function projectCodexMcpProgress(messages: ChatMessage[], id: string, message: string): ChatMessage[] {
  const name = toolPartName(messages, id, 'mcp')
  return upsertToolMessage(
    messages,
    id,
    { id, name, preview: message.slice(-MAX_RUNNING_PREVIEW) },
    'running',
    Date.now() / 1000
  )
}
`

const projectionImports = String.raw`import {
  projectCodexAuxHistoryItem,
  projectCodexAuxItemCompleted,
  projectCodexAuxItemStarted,
  projectCodexCommandOutputDelta,
  projectCodexFilePatchUpdated,
  projectCodexMcpProgress,
  projectCodexReasoningDelta
} from './item-projection'
import {
  setCodexApproval,`

const historyAuxProjection = String.raw`      if (item.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : ''
        if (!text && !pending) continue
        messages.push({
          id,
          role: 'assistant',
          parts: text ? [textPart(text, startedAt)] : [],
          pending,
          ...(startedAt !== undefined ? { timestamp: startedAt } : {}),
          ...(completedAt !== undefined ? { completedAt } : {})
        })
        continue
      }

      const auxiliary = projectCodexAuxHistoryItem(item, pending, startedAt, completedAt)
      if (auxiliary) messages.push(auxiliary)`

const itemStartedProjection = String.raw`      if (event.method === 'item/started') {
        const item = record(params.item)
        const itemId = nonEmptyString(item.id)
        const occurredAt = numberOr(params.startedAtMs, Date.now()) / 1000
        if (item.type === 'agentMessage' && itemId) {
          const text = typeof item.text === 'string' ? item.text : ''
          updateSessionState(
            threadId,
            state =>
              state.messages.some(message => message.id === itemId)
                ? state
                : {
                    ...state,
                    messages: [
                      ...state.messages,
                      {
                        id: itemId,
                        role: 'assistant',
                        parts: text ? [textPart(text)] : [],
                        pending: true,
                        timestamp: occurredAt
                      }
                    ]
                  },
            threadId
          )
        } else if (itemId) {
          updateSessionState(
            threadId,
            state => ({ ...state, messages: projectCodexAuxItemStarted(state.messages, item, occurredAt) }),
            threadId
          )
        }
        return
      }`

const reasoningNotifications = String.raw`      if (event.method === 'item/reasoning/summaryTextDelta') {
        const itemId = nonEmptyString(params.itemId)
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (itemId && delta) {
          reasoningSummaryItemsRef.current.add(itemId)
          updateSessionState(
            threadId,
            state => ({
              ...state,
              messages: projectCodexReasoningDelta(state.messages, itemId, delta, Date.now() / 1000)
            }),
            threadId
          )
        }
        return
      }

      if (event.method === 'item/reasoning/textDelta') {
        const itemId = nonEmptyString(params.itemId)
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (itemId && delta && !reasoningSummaryItemsRef.current.has(itemId)) {
          updateSessionState(
            threadId,
            state => ({
              ...state,
              messages: projectCodexReasoningDelta(state.messages, itemId, delta, Date.now() / 1000)
            }),
            threadId
          )
        }
        return
      }

      if (event.method === 'item/commandExecution/outputDelta') {
        const itemId = nonEmptyString(params.itemId)
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (itemId && delta) {
          updateSessionState(
            threadId,
            state => ({ ...state, messages: projectCodexCommandOutputDelta(state.messages, itemId, delta) }),
            threadId
          )
        }
        return
      }

      if (event.method === 'item/fileChange/patchUpdated') {
        const itemId = nonEmptyString(params.itemId)
        if (itemId) {
          updateSessionState(
            threadId,
            state => ({ ...state, messages: projectCodexFilePatchUpdated(state.messages, itemId, params.changes) }),
            threadId
          )
        }
        return
      }

      if (event.method === 'item/mcpToolCall/progress') {
        const itemId = nonEmptyString(params.itemId)
        const message = typeof params.message === 'string' ? params.message : ''
        if (itemId && message) {
          updateSessionState(
            threadId,
            state => ({ ...state, messages: projectCodexMcpProgress(state.messages, itemId, message) }),
            threadId
          )
        }
        return
      }

      if (event.method === 'item/agentMessage/delta') {`

const itemCompletedProjection = String.raw`      if (event.method === 'item/completed') {
        const item = record(params.item)
        const itemId = nonEmptyString(item.id)
        const occurredAt = numberOr(params.completedAtMs, Date.now()) / 1000
        if (item.type === 'agentMessage' && itemId) {
          updateSessionState(
            threadId,
            state => ({
              ...state,
              messages: completeAgentMessage(
                state.messages,
                itemId,
                typeof item.text === 'string' ? item.text : '',
                typeof params.completedAtMs === 'number' ? params.completedAtMs : undefined
              )
            }),
            threadId
          )
        } else if (itemId) {
          updateSessionState(
            threadId,
            state => ({ ...state, messages: projectCodexAuxItemCompleted(state.messages, item, occurredAt) }),
            threadId
          )
          if (item.type === 'reasoning') reasoningSummaryItemsRef.current.delete(itemId)
        }
        return
      }`

export function applyZero3CodexItemRendering() {
  const generatedDir = path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex')
  fs.mkdirSync(generatedDir, { recursive: true })
  fs.writeFileSync(path.join(generatedDir, 'item-projection.ts'), itemProjectionSource)

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'R3A item projection imports',
      from: "import {\n  setCodexApproval,",
      to: projectionImports
    },
    {
      label: 'R3A history auxiliary item projection',
      from: String.raw`      if (item.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : ''
        if (!text && !pending) continue
        messages.push({
          id,
          role: 'assistant',
          parts: text ? [textPart(text, startedAt)] : [],
          pending,
          ...(startedAt !== undefined ? { timestamp: startedAt } : {}),
          ...(completedAt !== undefined ? { completedAt } : {})
        })
      }`,
      to: historyAuxProjection
    },
    {
      label: 'R3A reasoning-summary liveness set',
      from: '  const activeTurnByThreadRef = useRef(new Map<string, string>())',
      to:
        "  const activeTurnByThreadRef = useRef(new Map<string, string>())\n" +
        "  const reasoningSummaryItemsRef = useRef(new Set<string>())"
    },
    {
      label: 'R3A item started projection',
      from: String.raw`      if (event.method === 'item/started') {
        const item = record(params.item)
        const itemId = nonEmptyString(item.id)
        if (item.type === 'agentMessage' && itemId) {
          const text = typeof item.text === 'string' ? item.text : ''
          updateSessionState(
            threadId,
            state =>
              state.messages.some(message => message.id === itemId)
                ? state
                : {
                    ...state,
                    messages: [
                      ...state.messages,
                      {
                        id: itemId,
                        role: 'assistant',
                        parts: text ? [textPart(text)] : [],
                        pending: true,
                        timestamp: numberOr(params.startedAtMs, Date.now()) / 1000
                      }
                    ]
                  },
            threadId
          )
        }
        return
      }`,
      to: itemStartedProjection
    },
    {
      label: 'R3A reasoning and tool progress notifications',
      from: "      if (event.method === 'item/agentMessage/delta') {",
      to: reasoningNotifications
    },
    {
      label: 'R3A item completed projection',
      from: String.raw`      if (event.method === 'item/completed') {
        const item = record(params.item)
        const itemId = nonEmptyString(item.id)
        if (item.type === 'agentMessage' && itemId) {
          updateSessionState(
            threadId,
            state => ({
              ...state,
              messages: completeAgentMessage(
                state.messages,
                itemId,
                typeof item.text === 'string' ? item.text : '',
                typeof params.completedAtMs === 'number' ? params.completedAtMs : undefined
              )
            }),
            threadId
          )
        }
        return
      }`,
      to: itemCompletedProjection
    }
  ])
}

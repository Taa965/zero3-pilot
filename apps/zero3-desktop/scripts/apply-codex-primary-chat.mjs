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
        `Zero3 Codex primary-chat drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source changed; review the R2 overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const primaryChatSource = String.raw`import type { MutableRefObject } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import type { NavigateFunction } from 'react-router'

import type { SubmitTextOptions } from '@/app/session/hooks/use-prompt-actions/utils'
import { sessionRoute } from '@/app/routes'
import { type ChatMessage, textPart } from '@/lib/chat-messages'
import { sanitizeComposerInput } from '@/lib/composer-input-sanitize'
import { notify } from '@/store/notifications'
import {
  $currentCwd,
  $sessions,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setCurrentCwdTransient,
  setFreshDraftReady,
  setMessages,
  setSelectedStoredSessionId,
  setSessionStartedAt,
  setSessions,
  setSessionsLoading,
  setTurnStartedAt,
  touchSessionActivity
} from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import type { ClientSessionState } from '../types'

type JsonRecord = Record<string, unknown>

type CodexThreadRecord = JsonRecord & {
  id: string
  createdAt?: number
  cwd?: string
  ephemeral?: boolean
  modelProvider?: string
  name?: null | string
  parentThreadId?: null | string
  preview?: string
  recencyAt?: null | number
  status?: unknown
  turns?: unknown[]
  updatedAt?: number
}

type CodexTurnRecord = JsonRecord & {
  id: string
  completedAt?: null | number
  error?: unknown
  items?: unknown[]
  startedAt?: null | number
  status?: string
}

type CodexPrimaryChatOptions = {
  activeSessionIdRef: MutableRefObject<string | null>
  busyRef: MutableRefObject<boolean>
  ensureSessionState: (sessionId: string, storedSessionId?: string | null) => ClientSessionState
  getRoutedStoredSessionId: () => null | string
  navigate: NavigateFunction
  resetViewSync: () => void
  selectedStoredSessionIdRef: MutableRefObject<string | null>
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
}

const R2_APPROVAL_POLICY = 'never' as const
const R2_SANDBOX = 'read-only' as const

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isThreadActive(status: unknown): boolean {
  return record(status).type === 'active'
}

function errorMessage(error: unknown, fallback = 'Codex 请求失败'): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  const value = record(error)
  const message = nonEmptyString(value.message)
  return message ?? fallback
}

function threadFromResponse(value: unknown): CodexThreadRecord | null {
  const candidate = record(value).thread
  const thread = record(candidate)
  const id = nonEmptyString(thread.id)
  return id ? ({ ...thread, id } as CodexThreadRecord) : null
}

function turnFromResponse(value: unknown): CodexTurnRecord | null {
  const candidate = record(value).turn
  const turn = record(candidate)
  const id = nonEmptyString(turn.id)
  return id ? ({ ...turn, id } as CodexTurnRecord) : null
}

function threadRow(thread: CodexThreadRecord): SessionInfo {
  const createdAt = numberOr(thread.createdAt, Date.now() / 1000)
  const updatedAt = numberOr(thread.updatedAt, createdAt)
  const recencyAt = numberOr(thread.recencyAt, updatedAt)
  const preview = nonEmptyString(thread.preview)
  const name = nonEmptyString(thread.name)

  return {
    cwd: nonEmptyString(thread.cwd),
    ended_at: null,
    id: thread.id,
    input_tokens: 0,
    is_active: isThreadActive(thread.status),
    is_default_profile: true,
    last_active: recencyAt,
    message_count: preview || name ? 1 : 0,
    model: null,
    output_tokens: 0,
    preview,
    profile: 'default',
    source: 'desktop',
    started_at: createdAt,
    title: name,
    tool_call_count: 0
  }
}

function userInputText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(item => {
      const input = record(item)
      return input.type === 'text' ? nonEmptyString(input.text) ?? '' : ''
    })
    .filter(Boolean)
    .join('\n')
}

function messagesFromThread(thread: CodexThreadRecord): ChatMessage[] {
  const messages: ChatMessage[] = []
  const turns = Array.isArray(thread.turns) ? thread.turns : []

  for (const rawTurn of turns) {
    const turn = record(rawTurn)
    const startedAt = typeof turn.startedAt === 'number' ? turn.startedAt : undefined
    const completedAt = typeof turn.completedAt === 'number' ? turn.completedAt : undefined
    const pending = turn.status === 'inProgress'
    const items = Array.isArray(turn.items) ? turn.items : []

    for (const rawItem of items) {
      const item = record(rawItem)
      const id = nonEmptyString(item.id)
      if (!id) continue

      if (item.type === 'userMessage') {
        const text = userInputText(item.content)
        if (!text) continue
        messages.push({
          id,
          role: 'user',
          parts: [textPart(text, startedAt)],
          ...(startedAt !== undefined ? { timestamp: startedAt } : {})
        })
        continue
      }

      if (item.type === 'agentMessage') {
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
      }
    }
  }

  return messages
}

function optimisticUserMessage(text: string): ChatMessage {
  const now = Date.now() / 1000
  return {
    id: 'zero3-user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    parts: [textPart(text, now)],
    timestamp: now
  }
}

function appendAssistantError(messages: ChatMessage[], message: string): ChatMessage[] {
  const now = Date.now() / 1000
  return [
    ...messages.filter(item => !item.pending || item.role !== 'assistant'),
    {
      id: 'zero3-codex-error-' + Date.now(),
      role: 'assistant',
      parts: [],
      error: message,
      completedAt: now,
      timestamp: now
    }
  ]
}

function appendAgentDelta(messages: ChatMessage[], itemId: string, delta: string): ChatMessage[] {
  const index = messages.findIndex(message => message.id === itemId)
  if (index < 0) {
    const now = Date.now() / 1000
    return [
      ...messages,
      {
        id: itemId,
        role: 'assistant',
        parts: [textPart(delta, now)],
        pending: true,
        timestamp: now
      }
    ]
  }

  const message = messages[index]
  const parts = [...message.parts]
  const textIndex = parts.findLastIndex(part => part.type === 'text')
  if (textIndex >= 0) {
    const part = parts[textIndex]
    if (part.type === 'text') parts[textIndex] = { ...part, text: part.text + delta }
  } else {
    parts.push(textPart(delta))
  }

  const next = [...messages]
  next[index] = { ...message, role: 'assistant', parts, pending: true }
  return next
}

function completeAgentMessage(messages: ChatMessage[], itemId: string, text: string, completedAtMs?: number): ChatMessage[] {
  const completedAt = typeof completedAtMs === 'number' ? completedAtMs / 1000 : Date.now() / 1000
  const index = messages.findIndex(message => message.id === itemId)
  if (index < 0) {
    return text
      ? [
          ...messages,
          {
            id: itemId,
            role: 'assistant',
            parts: [textPart(text)],
            pending: false,
            completedAt,
            timestamp: completedAt
          }
        ]
      : messages
  }

  const message = messages[index]
  const next = [...messages]
  next[index] = {
    ...message,
    role: 'assistant',
    parts: text ? [textPart(text, message.timestamp)] : message.parts,
    pending: false,
    completedAt
  }
  return next
}

export function useZero3CodexPrimaryChat({
  activeSessionIdRef,
  busyRef,
  ensureSessionState,
  getRoutedStoredSessionId,
  navigate,
  resetViewSync,
  selectedStoredSessionIdRef,
  updateSessionState
}: CodexPrimaryChatOptions) {
  const enabled = typeof window !== 'undefined' && Boolean(window.zero3Codex)
  const activeTurnByThreadRef = useRef(new Map<string, string>())

  const unsupportedAction = useCallback(async (feature: string) => {
    notify({
      kind: 'info',
      message: feature + ' 正在迁移到 Codex 原生协议。R2A 已切换主聊天，但不会回退到 Hermes Runtime 执行这个操作。'
    })
  }, [])

  const unsupportedBoolean = useCallback(
    async (feature: string) => {
      await unsupportedAction(feature)
      return false
    },
    [unsupportedAction]
  )

  const refreshSessions = useCallback(async () => {
    if (!enabled) return
    setSessionsLoading(true)
    try {
      await window.zero3Codex.start()
      const response = record(await window.zero3Codex.thread.list({ archived: false, limit: 100 }))
      const data = Array.isArray(response.data) ? response.data : []
      const rows = data
        .map(value => record(value))
        .filter(thread => nonEmptyString(thread.id) && thread.parentThreadId == null && thread.ephemeral !== true)
        .map(thread => threadRow({ ...thread, id: nonEmptyString(thread.id) as string }))

      setSessions(previous => {
        const selectedId = selectedStoredSessionIdRef.current
        const selected = selectedId ? previous.find(session => session.id === selectedId) : undefined
        return selected && !rows.some(session => session.id === selected.id) ? [selected, ...rows] : rows
      })
    } catch (error) {
      notify({ kind: 'error', title: 'Codex 会话列表加载失败', message: errorMessage(error) })
    } finally {
      setSessionsLoading(false)
    }
  }, [enabled, selectedStoredSessionIdRef])

  const bindThread = useCallback(
    (thread: CodexThreadRecord, messages?: ChatMessage[]) => {
      const threadId = thread.id
      const busy = isThreadActive(thread.status)
      const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : []
      const activeTurn = [...turns].reverse().find(turn => turn.status === 'inProgress' && nonEmptyString(turn.id))
      if (activeTurn) activeTurnByThreadRef.current.set(threadId, nonEmptyString(activeTurn.id) as string)
      else activeTurnByThreadRef.current.delete(threadId)

      resetViewSync()
      ensureSessionState(threadId, threadId)
      activeSessionIdRef.current = threadId
      selectedStoredSessionIdRef.current = threadId
      busyRef.current = busy
      setActiveSessionId(threadId)
      setSelectedStoredSessionId(threadId)
      setBusy(busy)
      setAwaitingResponse(busy)
      setFreshDraftReady(false)
      setSessionStartedAt(numberOr(thread.createdAt, Date.now() / 1000) * 1000)
      setCurrentCwdTransient(nonEmptyString(thread.cwd) ?? '')
      if (activeTurn && typeof activeTurn.startedAt === 'number') setTurnStartedAt(activeTurn.startedAt * 1000)
      else setTurnStartedAt(null)

      updateSessionState(
        threadId,
        state => ({
          ...state,
          busy,
          awaitingResponse: busy,
          ...(messages ? { messages } : {}),
          turnStartedAt:
            activeTurn && typeof activeTurn.startedAt === 'number' ? activeTurn.startedAt * 1000 : null
        }),
        threadId
      )

      setSessions(previous => {
        const row = threadRow(thread)
        const without = previous.filter(session => session.id !== threadId)
        return [row, ...without]
      })
    },
    [
      activeSessionIdRef,
      busyRef,
      ensureSessionState,
      resetViewSync,
      selectedStoredSessionIdRef,
      updateSessionState
    ]
  )

  const resumeSession = useCallback(
    async (threadId: string, replaceRoute = false) => {
      if (!enabled) return
      const id = threadId.trim()
      if (!id) return

      selectedStoredSessionIdRef.current = id
      setSelectedStoredSessionId(id)
      ensureSessionState(id, id)
      navigate(sessionRoute(id), { replace: replaceRoute })

      try {
        await window.zero3Codex.start()
        const resumed = threadFromResponse(
          await window.zero3Codex.thread.resume({
            threadId: id,
            approvalPolicy: R2_APPROVAL_POLICY,
            sandbox: R2_SANDBOX
          })
        )
        const read = threadFromResponse(await window.zero3Codex.thread.read({ threadId: id, includeTurns: true }))
        const thread = read ?? resumed
        if (!thread) throw new Error('Codex thread/resume 未返回有效 Thread')
        bindThread(thread, messagesFromThread(thread))
      } catch (error) {
        busyRef.current = false
        setBusy(false)
        setAwaitingResponse(false)
        notify({ kind: 'error', title: 'Codex 会话恢复失败', message: errorMessage(error) })
        throw error
      }
    },
    [bindThread, busyRef, enabled, ensureSessionState, navigate, selectedStoredSessionIdRef]
  )

  const createThread = useCallback(
    async (preview: string): Promise<string> => {
      await window.zero3Codex.start()
      const cwd = $currentCwd.get().trim()
      const response = await window.zero3Codex.thread.start({
        ...(cwd ? { cwd } : {}),
        approvalPolicy: R2_APPROVAL_POLICY,
        sandbox: R2_SANDBOX
      })
      const thread = threadFromResponse(response)
      if (!thread) throw new Error('Codex thread/start 未返回有效 Thread')

      bindThread(thread, [])
      touchSessionActivity(thread.id, { preview })
      navigate(sessionRoute(thread.id), { replace: true })
      return thread.id
    },
    [bindThread, navigate]
  )

  const submitText = useCallback(
    async (rawText: string, options?: SubmitTextOptions): Promise<boolean> => {
      if (!enabled) return false
      const text = sanitizeComposerInput(rawText).trim()
      if (!text) return false

      if ((options?.attachments?.length ?? 0) > 0) {
        notify({
          kind: 'info',
          message: 'R2A 的 Codex 主聊天目前只接管纯文本。附件不会被静默丢弃，请移除附件后发送。'
        })
        return false
      }

      if (options?.displayKind === 'hidden') {
        await unsupportedAction('隐藏式后台消息')
        return false
      }

      let threadId =
        options?.storedSessionId?.trim() ||
        options?.sessionId?.trim() ||
        selectedStoredSessionIdRef.current?.trim() ||
        getRoutedStoredSessionId()?.trim() ||
        activeSessionIdRef.current?.trim() ||
        ''

      try {
        if (!threadId) {
          threadId = await createThread(text)
        } else if (activeSessionIdRef.current !== threadId || selectedStoredSessionIdRef.current !== threadId) {
          await resumeSession(threadId, false)
        }

        const userMessage = optimisticUserMessage(text)
        ensureSessionState(threadId, threadId)
        busyRef.current = true
        setBusy(true)
        setAwaitingResponse(true)
        setTurnStartedAt(Date.now())
        touchSessionActivity(threadId, { preview: text })
        updateSessionState(
          threadId,
          state => ({
            ...state,
            messages: [...state.messages.filter(message => !(message.role === 'assistant' && message.pending)), userMessage],
            busy: true,
            awaitingResponse: true,
            turnStartedAt: Date.now()
          }),
          threadId
        )

        const cwd = $currentCwd.get().trim()
        const response = await window.zero3Codex.turn.start({
          threadId,
          text,
          ...(cwd ? { cwd } : {}),
          approvalPolicy: R2_APPROVAL_POLICY
        })
        const turn = turnFromResponse(response)
        if (!turn) throw new Error('Codex turn/start 未返回有效 Turn')
        activeTurnByThreadRef.current.set(threadId, turn.id)
        return true
      } catch (error) {
        busyRef.current = false
        setBusy(false)
        setAwaitingResponse(false)
        setTurnStartedAt(null)
        if (threadId) {
          updateSessionState(
            threadId,
            state => ({
              ...state,
              messages: appendAssistantError(state.messages, errorMessage(error, 'Codex 发送失败')),
              busy: false,
              awaitingResponse: false,
              turnStartedAt: null
            }),
            threadId
          )
        }
        notify({ kind: 'error', title: 'Codex 发送失败', message: errorMessage(error) })
        return false
      }
    },
    [
      activeSessionIdRef,
      busyRef,
      createThread,
      enabled,
      ensureSessionState,
      getRoutedStoredSessionId,
      resumeSession,
      selectedStoredSessionIdRef,
      unsupportedAction,
      updateSessionState
    ]
  )

  const cancelRun = useCallback(async () => {
    if (!enabled) return
    const threadId = selectedStoredSessionIdRef.current?.trim() || activeSessionIdRef.current?.trim()
    if (!threadId) return

    let turnId = activeTurnByThreadRef.current.get(threadId) ?? null
    if (!turnId) {
      try {
        const read = threadFromResponse(await window.zero3Codex.thread.read({ threadId, includeTurns: true }))
        const turns = Array.isArray(read?.turns) ? read.turns.map(record) : []
        turnId = nonEmptyString([...turns].reverse().find(turn => turn.status === 'inProgress')?.id)
      } catch {}
    }

    if (!turnId) return

    try {
      await window.zero3Codex.turn.interrupt({ threadId, turnId })
    } finally {
      activeTurnByThreadRef.current.delete(threadId)
      busyRef.current = false
      setBusy(false)
      setAwaitingResponse(false)
      setTurnStartedAt(null)
      updateSessionState(
        threadId,
        state => ({
          ...state,
          messages: state.messages.map(message =>
            message.role === 'assistant' && message.pending ? { ...message, pending: false } : message
          ),
          busy: false,
          awaitingResponse: false,
          turnStartedAt: null
        }),
        threadId
      )
    }
  }, [activeSessionIdRef, busyRef, enabled, selectedStoredSessionIdRef, updateSessionState])

  useEffect(() => {
    if (!enabled) return undefined

    const dispose = window.zero3Codex.onEvent(event => {
      if (event.kind === 'request') {
        void window.zero3Codex.respondToServerRequest({
          id: event.id,
          error: {
            code: -32001,
            message: 'Zero3 R2A approval/input UI is not connected yet; request denied fail-closed.'
          }
        })
        return
      }

      if (event.kind !== 'notification') return
      const params = record(event.params)
      const threadId = nonEmptyString(params.threadId)
      if (!threadId) return

      ensureSessionState(threadId, threadId)

      if (event.method === 'turn/started') {
        const turn = record(params.turn)
        const turnId = nonEmptyString(turn.id)
        if (turnId) activeTurnByThreadRef.current.set(threadId, turnId)
        updateSessionState(
          threadId,
          state => ({ ...state, busy: true, awaitingResponse: true, turnStartedAt: Date.now() }),
          threadId
        )
        if (selectedStoredSessionIdRef.current === threadId) {
          busyRef.current = true
          setBusy(true)
          setAwaitingResponse(true)
          setTurnStartedAt(Date.now())
        }
        return
      }

      if (event.method === 'item/started') {
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
      }

      if (event.method === 'item/agentMessage/delta') {
        const itemId = nonEmptyString(params.itemId)
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (itemId && delta) {
          updateSessionState(
            threadId,
            state => ({ ...state, messages: appendAgentDelta(state.messages, itemId, delta) }),
            threadId
          )
        }
        return
      }

      if (event.method === 'item/completed') {
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
      }

      if (event.method === 'turn/completed') {
        const turn = record(params.turn)
        activeTurnByThreadRef.current.delete(threadId)
        const failed = turn.status === 'failed'
        const failure = failed ? errorMessage(turn.error, 'Codex Turn 执行失败') : null
        updateSessionState(
          threadId,
          state => ({
            ...state,
            messages: failure
              ? appendAssistantError(state.messages, failure)
              : state.messages.map(message =>
                  message.role === 'assistant' && message.pending ? { ...message, pending: false } : message
                ),
            busy: false,
            awaitingResponse: false,
            turnStartedAt: null
          }),
          threadId
        )
        if (selectedStoredSessionIdRef.current === threadId) {
          busyRef.current = false
          setBusy(false)
          setAwaitingResponse(false)
          setTurnStartedAt(null)
        }
        void refreshSessions()
        return
      }

      if (event.method === 'thread/name/updated') {
        const name = nonEmptyString(params.threadName)
        setSessions(previous => previous.map(session => (session.id === threadId ? { ...session, title: name } : session)))
        return
      }

      if (event.method === 'thread/status/changed') {
        const active = isThreadActive(params.status)
        setSessions(previous =>
          previous.map(session => (session.id === threadId ? { ...session, is_active: active } : session))
        )
        return
      }

      if (event.method === 'error') {
        const message = errorMessage(params.error ?? params.message, 'Codex Runtime 错误')
        updateSessionState(
          threadId,
          state => ({
            ...state,
            messages: appendAssistantError(state.messages, message),
            busy: false,
            awaitingResponse: false,
            turnStartedAt: null
          }),
          threadId
        )
      }
    })

    void refreshSessions()
    return dispose
  }, [busyRef, enabled, ensureSessionState, refreshSessions, selectedStoredSessionIdRef, updateSessionState])

  return {
    cancelRun,
    enabled,
    refreshSessions,
    resumeSession,
    submitText,
    unsupportedAction,
    unsupportedBoolean
  }
}
`

export function applyZero3CodexPrimaryChat() {
  // R1A used the renderer-style camelCase spelling here. The pinned Codex
  // generated protocol uses the UserInput field `text_elements` verbatim.
  patchFile('electron/main.ts', [
    {
      label: 'pinned Codex UserInput text_elements field',
      from: "input: [{ type: 'text', text, textElements: [] }]",
      to: "input: [{ type: 'text', text, text_elements: [] }]"
    }
  ])

  const generatedDir = path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex')
  fs.mkdirSync(generatedDir, { recursive: true })
  fs.writeFileSync(path.join(generatedDir, 'primary-chat.ts'), primaryChatSource)

  patchFile('src/app/contrib/wiring.tsx', [
    {
      label: 'Zero3 Codex primary-chat import',
      from: "import { useWindowControlsOverlayWidth } from '../shell/hooks/use-window-controls-overlay-width'",
      to:
        "import { useWindowControlsOverlayWidth } from '../shell/hooks/use-window-controls-overlay-width'\n" +
        "import { useZero3CodexPrimaryChat } from '../zero3-codex/primary-chat'"
    },
    {
      label: 'Codex primary-chat controller after session list actions',
      from:
        "  const { loadMoreMessagingForPlatform, loadMoreSessions, refreshCronJobs, refreshMessagingSessions, refreshSessions } =\n" +
        "    useSessionListActions({ profileScope })",
      to:
        "  const { loadMoreMessagingForPlatform, loadMoreSessions, refreshCronJobs, refreshMessagingSessions, refreshSessions } =\n" +
        "    useSessionListActions({ profileScope })\n\n" +
        "  const codexPrimaryChat = useZero3CodexPrimaryChat({\n" +
        "    activeSessionIdRef,\n" +
        "    busyRef,\n" +
        "    ensureSessionState,\n" +
        "    getRoutedStoredSessionId,\n" +
        "    navigate,\n" +
        "    resetViewSync,\n" +
        "    selectedStoredSessionIdRef,\n" +
        "    updateSessionState\n" +
        "  })\n" +
        "  const primaryRefreshSessions = codexPrimaryChat.enabled ? codexPrimaryChat.refreshSessions : refreshSessions"
    },
    {
      label: 'Codex refresh in Hermes compatibility message stream',
      from:
        "    refreshHermesConfig,\n" +
        "    refreshSessions,\n" +
        "    sessionStateByRuntimeIdRef,",
      to:
        "    refreshHermesConfig,\n" +
        "    refreshSessions: primaryRefreshSessions,\n" +
        "    sessionStateByRuntimeIdRef,"
    },
    {
      label: 'primary Codex callbacks after legacy prompt actions',
      from:
        "    updateSessionState\n" +
        "  })\n\n" +
        "  // Runs outside the selected ChatBar so queues belonging to background",
      to:
        "    updateSessionState\n" +
        "  })\n\n" +
        "  const primarySubmitText = codexPrimaryChat.enabled ? codexPrimaryChat.submitText : submitText\n" +
        "  const primaryCancelRun = codexPrimaryChat.enabled ? codexPrimaryChat.cancelRun : cancelRun\n" +
        "  const primaryResumeSession = codexPrimaryChat.enabled ? codexPrimaryChat.resumeSession : resumeSession\n\n" +
        "  // Runs outside the selected ChatBar so queues belonging to background"
    },
    {
      label: 'background queue uses primary submit',
      from:
        "    selectedStoredSessionId,\n" +
        "    submitText\n" +
        "  })",
      to:
        "    selectedStoredSessionId,\n" +
        "    submitText: primarySubmitText\n" +
        "  })"
    },
    {
      label: 'pet bridge uses primary Codex callbacks',
      from: '  usePetBridge({ requestGateway, resumeSession, submitText })',
      to: '  usePetBridge({ requestGateway, resumeSession: primaryResumeSession, submitText: primarySubmitText })'
    },
    {
      label: 'quick entry uses primary Codex submit',
      from: '  useQuickEntryBridge({ startFreshSessionDraft, submitText })',
      to: '  useQuickEntryBridge({ startFreshSessionDraft, submitText: primarySubmitText })'
    },
    {
      label: 'HUD handoff uses primary Codex resume',
      from: '  useHudHandoff({ navigate, resumeSession })',
      to: '  useHudHandoff({ navigate, resumeSession: primaryResumeSession })'
    },
    {
      label: 'route resume uses primary Codex resume',
      from:
        "    locationPathname: location.pathname,\n" +
        "    resumeSession,\n" +
        "    resumeFailedSessionId,",
      to:
        "    locationPathname: location.pathname,\n" +
        "    resumeSession: primaryResumeSession,\n" +
        "    resumeFailedSessionId,"
    },
    {
      label: 'gateway boot refreshes Codex primary sessions',
      from:
        "    refreshHermesConfig,\n" +
        "    refreshSessions\n" +
        "  })",
      to:
        "    refreshHermesConfig,\n" +
        "    refreshSessions: primaryRefreshSessions\n" +
        "  })"
    },
    {
      label: 'background sync refreshes Codex primary sessions',
      from:
        "    refreshMessagingSessions,\n" +
        "    refreshSessions,\n" +
        "    requestGateway,",
      to:
        "    refreshMessagingSessions,\n" +
        "    refreshSessions: primaryRefreshSessions,\n" +
        "    requestGateway,"
    },
    {
      label: 'desktop integrations refresh Codex primary sessions',
      from:
        "    profileReady: boot.phase === 'renderer.ready',\n" +
        "    refreshSessions,\n" +
        "    resumeExhaustedSessionId,",
      to:
        "    profileReady: boot.phase === 'renderer.ready',\n" +
        "    refreshSessions: primaryRefreshSessions,\n" +
        "    resumeExhaustedSessionId,"
    },
    {
      label: 'primary cancel action',
      from: '    onCancel: cancelRun,',
      to: '    onCancel: primaryCancelRun,'
    },
    {
      label: 'Codex-safe archive action',
      from: '    onArchiveSession: sessionId => void archiveSession(sessionId),',
      to:
        "    onArchiveSession: sessionId =>\n" +
        "      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('归档会话') : archiveSession(sessionId)),"
    },
    {
      label: 'Codex-safe branch current action',
      from: '    onBranchInNewChat: messageId => void branchInNewChat(messageId),',
      to:
        "    onBranchInNewChat: messageId =>\n" +
        "      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('从消息分支') : branchInNewChat(messageId)),"
    },
    {
      label: 'Codex-safe branch session action',
      from: '    onBranchSession: sessionId => void branchStoredSession(sessionId),',
      to:
        "    onBranchSession: sessionId =>\n" +
        "      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('会话分支') : branchStoredSession(sessionId)),"
    },
    {
      label: 'Codex-safe selected delete action',
      from:
        "    onDeleteSelectedSession: () => {\n" +
        "      const id = $selectedStoredSessionId.get()\n\n" +
        "      if (id) {\n" +
        "        void removeSession(id)\n" +
        "      }\n" +
        "    },",
      to:
        "    onDeleteSelectedSession: () => {\n" +
        "      const id = $selectedStoredSessionId.get()\n\n" +
        "      if (id) {\n" +
        "        void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('删除会话') : removeSession(id))\n" +
        "      }\n" +
        "    },"
    },
    {
      label: 'Codex-safe sidebar delete action',
      from: '    onDeleteSession: sessionId => void removeSession(sessionId),',
      to:
        "    onDeleteSession: sessionId =>\n" +
        "      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('删除会话') : removeSession(sessionId)),"
    },
    {
      label: 'Codex-safe edit action',
      from: '    onEdit: editMessage,',
      to:
        "    onEdit: message =>\n" +
        "      codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('编辑历史消息') : editMessage(message),"
    },
    {
      label: 'Codex primary load-more action',
      from: '    onLoadMoreSessions: loadMoreSessions,',
      to: '    onLoadMoreSessions: codexPrimaryChat.enabled ? codexPrimaryChat.refreshSessions : loadMoreSessions,'
    },
    {
      label: 'Codex-safe new split action',
      from: '    onNewSessionSplit: dir => void openNewSessionTile(dir),',
      to:
        "    onNewSessionSplit: dir =>\n" +
        "      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('分屏新建会话') : openNewSessionTile(dir)),"
    },
    {
      label: 'Codex-safe reload action',
      from: '    onReload: reloadFromMessage,',
      to:
        "    onReload: parentId =>\n" +
        "      codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('重新生成') : reloadFromMessage(parentId),"
    },
    {
      label: 'Codex-safe restore action',
      from: '    onRestoreToMessage: restoreToMessage,',
      to:
        "    onRestoreToMessage: (messageId, target) =>\n" +
        "      codexPrimaryChat.enabled\n" +
        "        ? codexPrimaryChat.unsupportedAction('恢复到历史消息')\n" +
        "        : restoreToMessage(messageId, target),"
    },
    {
      label: 'Codex primary sidebar resume guard',
      from:
        "    onResumeSession: (sessionId, session) => {\n" +
        "      const rowProfile = session?.profile?.trim()",
      to:
        "    onResumeSession: (sessionId, session) => {\n" +
        "      if (codexPrimaryChat.enabled) {\n" +
        "        openSession(sessionId, navigate)\n" +
        "        return\n" +
        "      }\n\n" +
        "      const rowProfile = session?.profile?.trim()"
    },
    {
      label: 'Codex primary retry resume',
      from: '    onRetryResume: sessionId => void resumeSession(sessionId, true),',
      to: '    onRetryResume: sessionId => void primaryResumeSession(sessionId, true),'
    },
    {
      label: 'Codex-safe steer action',
      from: '    onSteer: steerPrompt,',
      to:
        "    onSteer: text =>\n" +
        "      codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedBoolean('运行中转向') : steerPrompt(text),"
    },
    {
      label: 'primary submit action',
      from: '    onSubmit: submitText,',
      to: '    onSubmit: primarySubmitText,'
    }
  ])
}

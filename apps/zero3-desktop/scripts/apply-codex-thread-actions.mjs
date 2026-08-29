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
        `Zero3 Codex R3D thread-action drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3D typed thread-action adapter before updating the pinned shell.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const threadActionParams = String.raw`function zero3CodexThreadIdParams(value: unknown) {
  const input = zero3CodexRecord(value)
  return { threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256) }
}

function zero3CodexThreadForkParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const params: Record<string, unknown> = {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256)
  }
  const lastTurnId = zero3CodexOptionalString(input.lastTurnId, 'lastTurnId', 256)
  if (lastTurnId) params.lastTurnId = lastTurnId
  return params
}

function zero3CodexThreadSetNameParams(value: unknown) {
  const input = zero3CodexRecord(value)
  return {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    name: zero3CodexRequiredString(input.name, 'name', 512)
  }
}

function zero3CodexTurnSteerParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const structuredInput = zero3CodexTurnInputs(input.input)
  if (structuredInput.some(item => item.type !== 'text')) {
    throw new Error('turn/steer only supports text input in R3D')
  }
  return {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    expectedTurnId: zero3CodexRequiredString(input.expectedTurnId, 'expectedTurnId', 256),
    input: structuredInput
  }
}

function zero3CodexTurnInterruptParams(value: unknown) {`

const threadIpcHandlers = String.raw`ipcMain.handle('zero3:codex:thread:archive', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/archive', zero3CodexThreadIdParams(request))
)
ipcMain.handle('zero3:codex:thread:unarchive', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/unarchive', zero3CodexThreadIdParams(request))
)
ipcMain.handle('zero3:codex:thread:delete', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/delete', zero3CodexThreadIdParams(request))
)
ipcMain.handle('zero3:codex:thread:name:set', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/name/set', zero3CodexThreadSetNameParams(request))
)
ipcMain.handle('zero3:codex:thread:fork', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/fork', zero3CodexThreadForkParams(request))
)
ipcMain.handle('zero3:codex:turn:start', (_event, request: unknown) =>`

const steerIpcHandler = String.raw`ipcMain.handle('zero3:codex:turn:steer', (_event, request: unknown) =>
  zero3CodexAppServer.request('turn/steer', zero3CodexTurnSteerParams(request), ZERO3_CODEX_TURN_TIMEOUT_MS)
)
ipcMain.handle('zero3:codex:turn:interrupt', (_event, request: unknown) =>`

const preloadThreadActions = String.raw`    read: request => ipcRenderer.invoke('zero3:codex:thread:read', request),
    archive: request => ipcRenderer.invoke('zero3:codex:thread:archive', request),
    unarchive: request => ipcRenderer.invoke('zero3:codex:thread:unarchive', request),
    delete: request => ipcRenderer.invoke('zero3:codex:thread:delete', request),
    setName: request => ipcRenderer.invoke('zero3:codex:thread:name:set', request),
    fork: request => ipcRenderer.invoke('zero3:codex:thread:fork', request)
  },
  turn: {`

const preloadSteerAction = String.raw`    start: request => ipcRenderer.invoke('zero3:codex:turn:start', request),
    steer: request => ipcRenderer.invoke('zero3:codex:turn:steer', request),
    interrupt: request => ipcRenderer.invoke('zero3:codex:turn:interrupt', request)`

const globalThreadActions = String.raw`        read: (request: Zero3CodexThreadReadRequest) => Promise<unknown>
        archive: (request: Zero3CodexThreadIdRequest) => Promise<unknown>
        unarchive: (request: Zero3CodexThreadIdRequest) => Promise<unknown>
        delete: (request: Zero3CodexThreadIdRequest) => Promise<unknown>
        setName: (request: Zero3CodexThreadSetNameRequest) => Promise<unknown>
        fork: (request: Zero3CodexThreadForkRequest) => Promise<unknown>
      }
      turn: {`

const globalSteerAction = String.raw`        start: (request: Zero3CodexTurnStartRequest) => Promise<unknown>
        steer: (request: Zero3CodexTurnSteerRequest) => Promise<unknown>
        interrupt: (request: Zero3CodexTurnInterruptRequest) => Promise<unknown>`

const threadActionTypes = String.raw`type Zero3CodexThreadListRequest = { archived?: boolean; cursor?: string; limit?: number }
type Zero3CodexThreadReadRequest = { includeTurns?: boolean; threadId: string }
type Zero3CodexThreadIdRequest = { threadId: string }
type Zero3CodexThreadForkRequest = { lastTurnId?: string; threadId: string }
type Zero3CodexThreadSetNameRequest = { name: string; threadId: string }
type Zero3CodexTurnSteerRequest = {
  expectedTurnId: string
  input: Array<{ type: 'text'; text: string }>
  threadId: string
}

type Zero3CodexTurnInput =`

const primaryImports = String.raw`import { NEW_CHAT_ROUTE, sessionRoute } from '@/app/routes'`

const primarySessionStateImport = String.raw`import { dropSessionState } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'`

const primaryThreadActions = String.raw`  const leaveRemovedThread = useCallback(
    (threadId: string) => {
      activeTurnByThreadRef.current.delete(threadId)
      dropSessionState(threadId)
      setSessions(previous => previous.filter(session => session.id !== threadId))

      if (selectedStoredSessionIdRef.current !== threadId && activeSessionIdRef.current !== threadId) return

      resetViewSync()
      activeSessionIdRef.current = null
      selectedStoredSessionIdRef.current = null
      busyRef.current = false
      setActiveSessionId(null)
      setSelectedStoredSessionId(null)
      setBusy(false)
      setAwaitingResponse(false)
      setTurnStartedAt(null)
      setMessages([])
      setFreshDraftReady(true)
      navigate(NEW_CHAT_ROUTE, { replace: true })
    },
    [activeSessionIdRef, busyRef, navigate, resetViewSync, selectedStoredSessionIdRef]
  )

  const archiveThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const id = threadId.trim()
      if (!enabled || !id) return false
      try {
        await window.zero3Codex.thread.archive({ threadId: id })
        leaveRemovedThread(id)
        notify({ durationMs: 2_000, kind: 'success', message: '会话已归档' })
        return true
      } catch (error) {
        notify({ kind: 'error', title: 'Codex 会话归档失败', message: errorMessage(error) })
        return false
      }
    },
    [enabled, leaveRemovedThread]
  )

  const deleteThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const id = threadId.trim()
      if (!enabled || !id) return false
      try {
        await window.zero3Codex.thread.delete({ threadId: id })
        leaveRemovedThread(id)
        notify({ durationMs: 2_000, kind: 'success', message: '会话已永久删除' })
        return true
      } catch (error) {
        notify({ kind: 'error', title: 'Codex 会话删除失败', message: errorMessage(error) })
        return false
      }
    },
    [enabled, leaveRemovedThread]
  )

  const forkThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const id = threadId.trim()
      if (!enabled || !id) return false
      try {
        const forked = threadFromResponse(await window.zero3Codex.thread.fork({ threadId: id }))
        if (!forked) throw new Error('Codex thread/fork 未返回有效 Thread')
        const read = threadFromResponse(await window.zero3Codex.thread.read({ threadId: forked.id, includeTurns: true }))
        const thread = read ?? forked
        bindThread(thread, messagesFromThread(thread))
        navigate(sessionRoute(thread.id))
        return true
      } catch (error) {
        notify({ kind: 'error', title: 'Codex 会话分支失败', message: errorMessage(error) })
        return false
      }
    },
    [bindThread, enabled, navigate]
  )

  const steerText = useCallback(
    async (rawText: string): Promise<boolean> => {
      if (!enabled) return false
      const text = sanitizeComposerInput(rawText).trim()
      if (!text) return false
      const threadId = selectedStoredSessionIdRef.current?.trim() || activeSessionIdRef.current?.trim() || ''
      if (!threadId) return false

      let expectedTurnId = activeTurnByThreadRef.current.get(threadId) ?? null
      if (!expectedTurnId) {
        try {
          const read = threadFromResponse(await window.zero3Codex.thread.read({ threadId, includeTurns: true }))
          const turns = Array.isArray(read?.turns) ? read.turns.map(record) : []
          expectedTurnId = nonEmptyString([...turns].reverse().find(turn => turn.status === 'inProgress')?.id)
        } catch {}
      }

      if (!expectedTurnId) {
        notify({ kind: 'info', message: '当前没有可转向的运行中 Codex Turn。' })
        return false
      }

      try {
        const response = record(
          await window.zero3Codex.turn.steer({
            threadId,
            expectedTurnId,
            input: [{ type: 'text', text }]
          })
        )
        const turnId = nonEmptyString(response.turnId)
        if (turnId) activeTurnByThreadRef.current.set(threadId, turnId)
        const userMessage = optimisticUserMessage(text, [], text)
        updateSessionState(
          threadId,
          state => ({ ...state, messages: [...state.messages, userMessage], busy: true, awaitingResponse: true }),
          threadId
        )
        return true
      } catch (error) {
        notify({ kind: 'error', title: 'Codex 运行中转向失败', message: errorMessage(error) })
        return false
      }
    },
    [activeSessionIdRef, enabled, selectedStoredSessionIdRef, updateSessionState]
  )

  const cancelRun = useCallback(async () => {`

const primaryReturn = String.raw`  return {
    archiveThread,
    cancelRun,
    deleteThread,
    enabled,
    forkThread,
    refreshSessions,
    resumeSession,
    steerText,
    submitText,
    unsupportedAction,
    unsupportedBoolean
  }`

const renameCodexFirst = String.raw`  if (window.zero3Codex) {
    const name = title.trim()
    if (!name) throw new Error('Codex 会话名称不能为空')
    await window.zero3Codex.thread.setName({ threadId: storedSessionId, name })
    return { title: name }
  }

  const isActiveRow = storedSessionId === $selectedStoredSessionId.get()`

const settingsHelpers = String.raw`const ARCHIVED_FETCH_LIMIT = 200

type CodexSettingsThread = Record<string, unknown> & { id: string }

function settingsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function settingsString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function archivedCodexSession(value: unknown): SessionInfo | null {
  const thread = settingsRecord(value)
  const id = settingsString(thread.id)
  if (!id) return null
  const createdAt = typeof thread.createdAt === 'number' ? thread.createdAt : Date.now() / 1000
  const updatedAt = typeof thread.updatedAt === 'number' ? thread.updatedAt : createdAt
  const preview = settingsString(thread.preview)
  const name = settingsString(thread.name)
  return {
    archived: true,
    cwd: settingsString(thread.cwd),
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    is_default_profile: true,
    last_active: updatedAt,
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
`

const settingsLoad = String.raw`    try {
      if (window.zero3Codex) {
        await window.zero3Codex.start()
        const result = settingsRecord(await window.zero3Codex.thread.list({ archived: true, limit: ARCHIVED_FETCH_LIMIT }))
        const data = Array.isArray(result.data) ? result.data : []
        setLocalSessions(data.map(archivedCodexSession).filter((row): row is SessionInfo => Boolean(row)))
      } else {
        const result = await listAllProfileSessions(ARCHIVED_FETCH_LIMIT, 0, 'only')
        setLocalSessions(result.sessions)
      }
    } catch (err) {`

const settingsUnarchive = String.raw`        if (window.zero3Codex) await window.zero3Codex.thread.unarchive({ threadId: session.id })
        else await setSessionArchived(session.id, false, session.profile)`

const settingsDelete = String.raw`        if (window.zero3Codex) await window.zero3Codex.thread.delete({ threadId: session.id })
        else await deleteSession(session.id, session.profile)`

function recordR3DProvenance() {
  const file = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
  const provenance = JSON.parse(fs.readFileSync(file, 'utf8'))
  provenance.threadActionsPhase = 'R3D-codex-thread-actions'
  fs.writeFileSync(file, `${JSON.stringify(provenance, null, 2)}\n`)
}

export function applyZero3CodexThreadActions() {
  patchFile('electron/main.ts', [
    {
      label: 'R3D typed thread/steer parameter validators',
      from: 'function zero3CodexTurnInterruptParams(value: unknown) {',
      to: threadActionParams
    },
    {
      label: 'R3D typed thread IPC handlers',
      from: "ipcMain.handle('zero3:codex:turn:start', (_event, request: unknown) =>",
      to: threadIpcHandlers
    },
    {
      label: 'R3D typed steer IPC handler',
      from: "ipcMain.handle('zero3:codex:turn:interrupt', (_event, request: unknown) =>",
      to: steerIpcHandler
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'R3D thread preload methods',
      from: String.raw`    read: request => ipcRenderer.invoke('zero3:codex:thread:read', request)
  },
  turn: {`,
      to: preloadThreadActions
    },
    {
      label: 'R3D steer preload method',
      from: String.raw`    start: request => ipcRenderer.invoke('zero3:codex:turn:start', request),
    interrupt: request => ipcRenderer.invoke('zero3:codex:turn:interrupt', request)`,
      to: preloadSteerAction
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'R3D thread renderer methods',
      from: String.raw`        read: (request: Zero3CodexThreadReadRequest) => Promise<unknown>
      }
      turn: {`,
      to: globalThreadActions
    },
    {
      label: 'R3D steer renderer method',
      from: String.raw`        start: (request: Zero3CodexTurnStartRequest) => Promise<unknown>
        interrupt: (request: Zero3CodexTurnInterruptRequest) => Promise<unknown>`,
      to: globalSteerAction
    },
    {
      label: 'R3D action request types',
      from: String.raw`type Zero3CodexThreadListRequest = { archived?: boolean; cursor?: string; limit?: number }
type Zero3CodexThreadReadRequest = { includeTurns?: boolean; threadId: string }

type Zero3CodexTurnInput =`,
      to: threadActionTypes
    }
  ])

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'R3D new-chat route import',
      from: "import { sessionRoute } from '@/app/routes'",
      to: primaryImports
    },
    {
      label: 'R3D session-state cleanup import',
      from: "import type { SessionInfo } from '@/types/hermes'",
      to: primarySessionStateImport
    },
    {
      label: 'R3D native primary thread actions',
      from: '  const cancelRun = useCallback(async () => {',
      to: primaryThreadActions
    },
    {
      label: 'R3D primary action exports',
      from: String.raw`  return {
    cancelRun,
    enabled,
    refreshSessions,
    resumeSession,
    submitText,
    unsupportedAction,
    unsupportedBoolean
  }`,
      to: primaryReturn
    }
  ])

  patchFile('src/app/contrib/wiring.tsx', [
    {
      label: 'R3D archive action',
      from: String.raw`    onArchiveSession: sessionId =>
      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('归档会话') : archiveSession(sessionId)),`,
      to: String.raw`    onArchiveSession: sessionId =>
      void (codexPrimaryChat.enabled ? codexPrimaryChat.archiveThread(sessionId) : archiveSession(sessionId)),`
    },
    {
      label: 'R3D whole-session fork action',
      from: String.raw`    onBranchSession: sessionId =>
      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('会话分支') : branchStoredSession(sessionId)),`,
      to: String.raw`    onBranchSession: sessionId =>
      void (codexPrimaryChat.enabled ? codexPrimaryChat.forkThread(sessionId) : branchStoredSession(sessionId)),`
    },
    {
      label: 'R3D selected delete action',
      from: String.raw`        void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('删除会话') : removeSession(id))`,
      to: String.raw`        void (codexPrimaryChat.enabled ? codexPrimaryChat.deleteThread(id) : removeSession(id))`
    },
    {
      label: 'R3D sidebar delete action',
      from: String.raw`    onDeleteSession: sessionId =>
      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('删除会话') : removeSession(sessionId)),`,
      to: String.raw`    onDeleteSession: sessionId =>
      void (codexPrimaryChat.enabled ? codexPrimaryChat.deleteThread(sessionId) : removeSession(sessionId)),`
    },
    {
      label: 'R3D active-turn steer action',
      from: String.raw`    onSteer: text =>
      codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedBoolean('运行中转向') : steerPrompt(text),`,
      to: String.raw`    onSteer: text =>
      codexPrimaryChat.enabled ? codexPrimaryChat.steerText(text) : steerPrompt(text),`
    }
  ])

  patchFile('src/app/chat/sidebar/session-actions-menu.tsx', [
    {
      label: 'R3D Codex-native rename before Hermes runtime fallback',
      from: '  const isActiveRow = storedSessionId === $selectedStoredSessionId.get()',
      to: renameCodexFirst
    }
  ])

  patchFile('src/app/settings/sessions-settings.tsx', [
    {
      label: 'R3D archived Codex Thread projection helpers',
      from: 'const ARCHIVED_FETCH_LIMIT = 200\n',
      to: settingsHelpers
    },
    {
      label: 'R3D archived Thread list',
      from: String.raw`    try {
      const result = await listAllProfileSessions(ARCHIVED_FETCH_LIMIT, 0, 'only')
      setLocalSessions(result.sessions)
    } catch (err) {`,
      to: settingsLoad
    },
    {
      label: 'R3D unarchive action',
      from: '        await setSessionArchived(session.id, false, session.profile)',
      to: settingsUnarchive
    },
    {
      label: 'R3D archived delete action',
      from: '        await deleteSession(session.id, session.profile)',
      to: settingsDelete
    }
  ])

  recordR3DProvenance()
  console.log('R3D: archive/unarchive/delete/rename/fork/active-turn steer use typed pinned Codex app-server methods; message-level fork/revert remain deferred until Turn-id mapping.')
}

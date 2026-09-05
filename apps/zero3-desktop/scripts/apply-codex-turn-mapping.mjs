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
        `Zero3 Codex R3E turn-mapping drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3E message/turn boundary before updating the pinned shell.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const turnBoundarySource = String.raw`type JsonRecord = Record<string, unknown>

export type CodexMessageBoundary = {
  hasImageInput: boolean
  inputText: string
  isLastMessageInTurn: boolean
  messageId: string
  role: 'assistant' | 'user'
  soleUserInTurn: boolean
  turnId: string
  turnStatus: string | null
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function messageItems(turn: JsonRecord): JsonRecord[] {
  return (Array.isArray(turn.items) ? turn.items : [])
    .map(record)
    .filter(item => (item.type === 'userMessage' || item.type === 'agentMessage') && Boolean(nonEmptyString(item.id)))
}

function userInput(content: unknown): { hasImageInput: boolean; text: string } {
  if (!Array.isArray(content)) return { hasImageInput: false, text: '' }
  const text: string[] = []
  let hasImageInput = false

  for (const raw of content) {
    const input = record(raw)
    if (input.type === 'text') {
      const value = nonEmptyString(input.text)
      if (value) text.push(value)
      continue
    }
    if (input.type === 'image' || input.type === 'localImage') hasImageInput = true
  }

  return { hasImageInput, text: text.join('\n') }
}

function boundaryFor(turn: JsonRecord, item: JsonRecord, itemIndex: number, items: JsonRecord[]): CodexMessageBoundary | null {
  const turnId = nonEmptyString(turn.id)
  const messageId = nonEmptyString(item.id)
  if (!turnId || !messageId) return null
  const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'assistant' : null
  if (!role) return null
  const users = items.filter(candidate => candidate.type === 'userMessage')
  const projection = role === 'user' ? userInput(item.content) : { hasImageInput: false, text: '' }

  return {
    hasImageInput: projection.hasImageInput,
    inputText: projection.text,
    isLastMessageInTurn: itemIndex === items.length - 1,
    messageId,
    role,
    soleUserInTurn: role === 'user' && users.length === 1,
    turnId,
    turnStatus: nonEmptyString(turn.status)
  }
}

export function findCodexMessageBoundary(
  thread: unknown,
  messageId: string,
  submittedTurnId?: null | string
): CodexMessageBoundary | null {
  const turns = Array.isArray(record(thread).turns) ? (record(thread).turns as unknown[]) : []
  let submittedCandidate: CodexMessageBoundary | null = null

  for (const rawTurn of turns) {
    const turn = record(rawTurn)
    const turnId = nonEmptyString(turn.id)
    const items = messageItems(turn)

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (nonEmptyString(item.id) === messageId) return boundaryFor(turn, item, index, items)
    }

    if (submittedTurnId && turnId === submittedTurnId) {
      const users = items.filter(item => item.type === 'userMessage')
      if (users.length === 1) {
        const item = users[0]
        submittedCandidate = boundaryFor(turn, item, items.indexOf(item), items)
      }
    }
  }

  return submittedCandidate
}

export function findCodexTurnUserBoundary(thread: unknown, turnId: string): CodexMessageBoundary | null {
  const turns = Array.isArray(record(thread).turns) ? (record(thread).turns as unknown[]) : []
  const turn = turns.map(record).find(candidate => nonEmptyString(candidate.id) === turnId)
  if (!turn) return null
  const items = messageItems(turn)
  const users = items.filter(item => item.type === 'userMessage')
  if (users.length !== 1) return null
  const user = users[0]
  return boundaryFor(turn, user, items.indexOf(user), items)
}

export function findLatestCodexTurnUserBoundary(thread: unknown): CodexMessageBoundary | null {
  const turns = Array.isArray(record(thread).turns) ? (record(thread).turns as unknown[]) : []
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = record(turns[index])
    const turnId = nonEmptyString(turn.id)
    if (!turnId || nonEmptyString(turn.status) === 'inProgress') continue
    const boundary = findCodexTurnUserBoundary(thread, turnId)
    if (boundary) return boundary
  }
  return null
}
`

const r3eValidators = String.raw`function zero3CodexThreadForkAtTurnParams(value: unknown) {
  const input = zero3CodexRecord(value)
  return {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    lastTurnId: zero3CodexRequiredString(input.lastTurnId, 'lastTurnId', 256),
    approvalPolicy: 'never',
    sandbox: 'danger-full-access'
  }
}

function zero3CodexThreadRevertBeforeTurnParams(value: unknown) {
  const input = zero3CodexRecord(value)
  return {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    beforeTurnId: zero3CodexRequiredString(input.beforeTurnId, 'beforeTurnId', 256)
  }
}

function zero3CodexThreadSetNameParams(value: unknown) {`

const r3eIpc = String.raw`ipcMain.handle('zero3:codex:thread:fork-at-turn', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/fork', zero3CodexThreadForkAtTurnParams(request))
)
ipcMain.handle('zero3:codex:thread:revert-before-turn', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/revert', zero3CodexThreadRevertBeforeTurnParams(request))
)
ipcMain.handle('zero3:codex:turn:start', (_event, request: unknown) =>`

const preloadR3e = String.raw`    fork: request => ipcRenderer.invoke('zero3:codex:thread:fork', request),
    forkAtTurn: request => ipcRenderer.invoke('zero3:codex:thread:fork-at-turn', request),
    revertBeforeTurn: request => ipcRenderer.invoke('zero3:codex:thread:revert-before-turn', request)
  },
  turn: {`

const globalR3e = String.raw`        fork: (request: Zero3CodexThreadForkRequest) => Promise<unknown>
        forkAtTurn: (request: Zero3CodexThreadForkAtTurnRequest) => Promise<unknown>
        revertBeforeTurn: (request: Zero3CodexThreadRevertBeforeTurnRequest) => Promise<unknown>
      }
      turn: {`

const r3eTypes = String.raw`type Zero3CodexThreadForkRequest = { threadId: string }
type Zero3CodexThreadForkAtTurnRequest = { lastTurnId: string; threadId: string }
type Zero3CodexThreadRevertBeforeTurnRequest = { beforeTurnId: string; threadId: string }
type Zero3CodexThreadSetNameRequest = { name: string; threadId: string }`

const primaryImport = String.raw`import {
  findCodexMessageBoundary,
  findCodexTurnUserBoundary,
  findLatestCodexTurnUserBoundary,
  type CodexMessageBoundary
} from './turn-boundary'

import type { ClientSessionState } from '../types'`

const submittedTurnMap = String.raw`  const activeTurnByThreadRef = useRef(new Map<string, string>())
  const submittedUserTurnByMessageRef = useRef(new Map<string, { threadId: string; turnId: string }>())`

const rememberSubmittedTurn = String.raw`        activeTurnByThreadRef.current.set(threadId, turn.id)
        submittedUserTurnByMessageRef.current.set(userMessage.id, { threadId, turnId: turn.id })
        return true`

const r3eCallbacks = String.raw`  const readThreadForBoundary = useCallback(
    async (threadId: string): Promise<CodexThreadRecord> => {
      await window.zero3Codex.start()
      const read = threadFromResponse(await window.zero3Codex.thread.read({ threadId, includeTurns: true }))
      if (!read) throw new Error('Codex thread/read 未返回可用于 Turn 映射的 Thread')
      return read
    },
    []
  )

  const resolveMessageBoundary = useCallback(
    async (threadId: string, messageId: string): Promise<{ boundary: CodexMessageBoundary; thread: CodexThreadRecord } | null> => {
      const thread = await readThreadForBoundary(threadId)
      const submitted = submittedUserTurnByMessageRef.current.get(messageId)
      const submittedTurnId = submitted?.threadId === threadId ? submitted.turnId : null
      const boundary = findCodexMessageBoundary(thread, messageId, submittedTurnId)
      return boundary ? { boundary, thread } : null
    },
    [readThreadForBoundary]
  )

  const currentThreadId = useCallback(
    () => selectedStoredSessionIdRef.current?.trim() || activeSessionIdRef.current?.trim() || '',
    [activeSessionIdRef, selectedStoredSessionIdRef]
  )

  const branchFromMessage = useCallback(
    async (messageId: string): Promise<boolean> => {
      const threadId = currentThreadId()
      if (!enabled || !threadId || !messageId.trim()) return false
      if (activeTurnByThreadRef.current.has(threadId)) {
        notify({ kind: 'info', message: '请先停止或等待当前 Codex Turn 完成，再从历史消息分支。' })
        return false
      }

      try {
        const resolved = await resolveMessageBoundary(threadId, messageId)
        if (!resolved) {
          notify({ kind: 'info', message: '尚未获得该消息对应的权威 Codex Turn，未执行分支。' })
          return false
        }
        const { boundary } = resolved
        if (boundary.turnStatus === 'inProgress') return false
        if (boundary.role === 'user') {
          notify({
            kind: 'info',
            message: 'Codex 的 fork 边界是 Turn；从 user 气泡分支会误包含同 Turn 的 assistant 回复，因此 R3E 暂不执行这个不等价操作。'
          })
          return false
        }
        if (!boundary.isLastMessageInTurn) {
          notify({ kind: 'info', message: '该 assistant 消息后同一 Codex Turn 还有消息，无法精确按此气泡分支。' })
          return false
        }

        const forked = threadFromResponse(
          await window.zero3Codex.thread.forkAtTurn({ threadId, lastTurnId: boundary.turnId })
        )
        if (!forked) throw new Error('Codex thread/fork 未返回有效 Thread')
        const read = threadFromResponse(
          await window.zero3Codex.thread.read({ threadId: forked.id, includeTurns: true })
        )
        const thread = read ?? forked
        bindThread(thread, messagesFromThread(thread))
        navigate(sessionRoute(thread.id))
        return true
      } catch (error) {
        notify({ kind: 'error', title: 'Codex 从消息分支失败', message: errorMessage(error) })
        return false
      }
    },
    [bindThread, currentThreadId, enabled, navigate, resolveMessageBoundary]
  )

  const replayUserTurn = useCallback(
    async (threadId: string, boundary: CodexMessageBoundary, displayText?: string): Promise<boolean> => {
      if (boundary.role !== 'user' || !boundary.soleUserInTurn || boundary.turnStatus === 'inProgress') {
        notify({ kind: 'info', message: '该消息无法安全映射为一个独立、已完成的 Codex user Turn，未执行恢复。' })
        return false
      }
      if (boundary.hasImageInput) {
        notify({ kind: 'info', message: '该 Turn 含图片输入；R3E 不会在缺少原始附件重建时执行破坏性恢复。' })
        return false
      }
      const inputText = boundary.inputText.trim()
      if (!inputText) {
        notify({ kind: 'info', message: '该 Codex Turn 没有可安全重放的文本输入。' })
        return false
      }
      if (selectedStoredSessionIdRef.current !== threadId && activeSessionIdRef.current !== threadId) {
        notify({ kind: 'info', message: '会话已切换，已取消破坏性 Codex 恢复操作。' })
        return false
      }

      await window.zero3Codex.thread.revertBeforeTurn({ threadId, beforeTurnId: boundary.turnId })
      const retained = await readThreadForBoundary(threadId)
      bindThread(retained, messagesFromThread(retained))
      return submitText(inputText, { displayText: displayText?.trim() || inputText })
    },
    [activeSessionIdRef, bindThread, readThreadForBoundary, selectedStoredSessionIdRef, submitText]
  )

  const restoreToMessage = useCallback(
    async (messageId: string, target?: { text?: string; userOrdinal?: number | null }) => {
      const threadId = currentThreadId()
      if (!enabled || !threadId) return
      if (activeTurnByThreadRef.current.has(threadId)) {
        notify({ kind: 'info', message: '请先停止或等待当前 Codex Turn 完成，再恢复历史消息。' })
        return
      }

      const resolved = await resolveMessageBoundary(threadId, messageId)
      if (!resolved || resolved.boundary.role !== 'user') {
        notify({ kind: 'info', message: '找不到该 user 消息对应的权威 Codex Turn，未执行恢复。' })
        return
      }
      await replayUserTurn(threadId, resolved.boundary, target?.text)
    },
    [currentThreadId, enabled, replayUserTurn, resolveMessageBoundary]
  )

  const reloadFromMessage = useCallback(
    async (parentId: string | null) => {
      const threadId = currentThreadId()
      if (!enabled || !threadId) return
      if (activeTurnByThreadRef.current.has(threadId)) {
        notify({ kind: 'info', message: '请先停止或等待当前 Codex Turn 完成，再重新生成。' })
        return
      }

      try {
        const thread = await readThreadForBoundary(threadId)
        let userBoundary: CodexMessageBoundary | null = null
        if (parentId) {
          const submitted = submittedUserTurnByMessageRef.current.get(parentId)
          const parentBoundary = findCodexMessageBoundary(
            thread,
            parentId,
            submitted?.threadId === threadId ? submitted.turnId : null
          )
          if (parentBoundary) userBoundary = findCodexTurnUserBoundary(thread, parentBoundary.turnId)
        } else {
          userBoundary = findLatestCodexTurnUserBoundary(thread)
        }

        if (!userBoundary) {
          notify({ kind: 'info', message: '无法确定重新生成所对应的唯一 Codex user Turn。' })
          return
        }
        await replayUserTurn(threadId, userBoundary, userBoundary.inputText)
      } catch (error) {
        notify({ kind: 'error', title: 'Codex 重新生成失败', message: errorMessage(error) })
      }
    },
    [currentThreadId, enabled, readThreadForBoundary, replayUserTurn]
  )

  const cancelRun = useCallback(async () => {`

const r3eReturn = String.raw`  return {
    archiveThread,
    branchFromMessage,
    cancelRun,
    deleteThread,
    enabled,
    forkThread,
    refreshSessions,
    reloadFromMessage,
    restoreToMessage,
    resumeSession,
    steerText,
    submitText,
    unsupportedAction,
    unsupportedBoolean
  }`

function recordR3eProvenance() {
  const file = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
  const provenance = JSON.parse(fs.readFileSync(file, 'utf8'))
  provenance.turnMappingPhase = 'R3E-codex-message-turn-mapping'
  fs.writeFileSync(file, `${JSON.stringify(provenance, null, 2)}\n`)
}

export function applyZero3CodexTurnMapping() {
  const generatedDir = path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex')
  fs.mkdirSync(generatedDir, { recursive: true })
  fs.writeFileSync(path.join(generatedDir, 'turn-boundary.ts'), turnBoundarySource)

  patchFile('electron/main.ts', [
    {
      label: 'R3E dedicated Turn-boundary validators',
      from: 'function zero3CodexThreadSetNameParams(value: unknown) {',
      to: r3eValidators
    },
    {
      label: 'R3E typed fork/revert IPC',
      from: "ipcMain.handle('zero3:codex:turn:start', (_event, request: unknown) =>",
      to: r3eIpc
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'R3E dedicated fork/revert preload surface',
      from: String.raw`    fork: request => ipcRenderer.invoke('zero3:codex:thread:fork', request)
  },
  turn: {`,
      to: preloadR3e
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'R3E dedicated fork/revert renderer methods',
      from: String.raw`        fork: (request: Zero3CodexThreadForkRequest) => Promise<unknown>
      }
      turn: {`,
      to: globalR3e
    },
    {
      label: 'R3E exact Turn-boundary request types',
      from: String.raw`type Zero3CodexThreadForkRequest = { threadId: string }
type Zero3CodexThreadSetNameRequest = { name: string; threadId: string }`,
      to: r3eTypes
    }
  ])

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'R3E Turn-boundary helper import',
      from: "import type { ClientSessionState } from '../types'",
      to: primaryImport
    },
    {
      label: 'R3E submitted user Turn aliases',
      from: '  const activeTurnByThreadRef = useRef(new Map<string, string>())',
      to: submittedTurnMap
    },
    {
      label: 'R3E bind optimistic user bubble to authoritative turn/start response',
      from: String.raw`        activeTurnByThreadRef.current.set(threadId, turn.id)
        return true`,
      to: rememberSubmittedTurn
    },
    {
      label: 'R3E message-level history actions',
      from: '  const cancelRun = useCallback(async () => {',
      to: r3eCallbacks
    },
    {
      label: 'R3E primary action exports',
      from: String.raw`  return {
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
  }`,
      to: r3eReturn
    }
  ])

  patchFile('src/app/contrib/wiring.tsx', [
    {
      label: 'R3E assistant-message branch action',
      from: String.raw`    onBranchInNewChat: messageId =>
      void (codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('从消息分支') : branchInNewChat(messageId)),`,
      to: String.raw`    onBranchInNewChat: messageId =>
      void (codexPrimaryChat.enabled ? codexPrimaryChat.branchFromMessage(messageId) : branchInNewChat(messageId)),`
    },
    {
      label: 'R3E regenerate action',
      from: String.raw`    onReload: parentId =>
      codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('重新生成') : reloadFromMessage(parentId),`,
      to: String.raw`    onReload: parentId =>
      codexPrimaryChat.enabled ? codexPrimaryChat.reloadFromMessage(parentId) : reloadFromMessage(parentId),`
    },
    {
      label: 'R3E restore-to-user action',
      from: String.raw`    onRestoreToMessage: (messageId, target) =>
      codexPrimaryChat.enabled
        ? codexPrimaryChat.unsupportedAction('恢复到历史消息')
        : restoreToMessage(messageId, target),`,
      to: String.raw`    onRestoreToMessage: (messageId, target) =>
      codexPrimaryChat.enabled
        ? codexPrimaryChat.restoreToMessage(messageId, target)
        : restoreToMessage(messageId, target),`
    }
  ])

  recordR3eProvenance()
  console.log('R3E: message-level branch/restore/regenerate resolve through authoritative Codex Thread -> Turn -> Item identities; unsafe partial-Turn boundaries remain fail-closed.')
}

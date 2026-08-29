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
        `Zero3 Codex R3F authoritative-history drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the R3F Codex history/action adapter before updating the pinned shell.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const turnsListValidator = String.raw`function zero3CodexThreadTurnsListParams(value: unknown) {
  const input = zero3CodexRecord(value)
  const params: Record<string, unknown> = {
    threadId: zero3CodexRequiredString(input.threadId, 'threadId', 256),
    limit: 100,
    sortDirection: 'asc',
    itemsView: 'full'
  }
  const cursor = zero3CodexOptionalString(input.cursor, 'cursor', 4096)
  if (cursor) params.cursor = cursor
  return params
}

function zero3CodexThreadSetNameParams(value: unknown) {`

const turnsListIpc = String.raw`ipcMain.handle('zero3:codex:thread:turns-list', (_event, request: unknown) =>
  zero3CodexAppServer.request('thread/turns/list', zero3CodexThreadTurnsListParams(request))
)
ipcMain.handle('zero3:codex:turn:start', (_event, request: unknown) =>`

const preloadR3f = String.raw`    revertBeforeTurn: request => ipcRenderer.invoke('zero3:codex:thread:revert-before-turn', request),
    turnsList: request => ipcRenderer.invoke('zero3:codex:thread:turns-list', request)
  },
  turn: {`

const globalR3f = String.raw`        revertBeforeTurn: (request: Zero3CodexThreadRevertBeforeTurnRequest) => Promise<unknown>
        turnsList: (request: Zero3CodexThreadTurnsListRequest) => Promise<unknown>
      }
      turn: {`

const r3fTypes = String.raw`type Zero3CodexThreadTurnsListRequest = { cursor?: string; threadId: string }
type Zero3CodexThreadSetNameRequest = { name: string; threadId: string }`

const appendMessageImport = String.raw`import type { AppendMessage } from '@assistant-ui/react'
import type { MutableRefObject } from 'react'`

const paginatedHistoryHelpers = String.raw`type CodexTurnsPage = {
  data: CodexTurnRecord[]
  nextCursor: string | null
}

function turnsPageFromResponse(value: unknown): CodexTurnsPage {
  const page = record(value)
  if (!Array.isArray(page.data)) throw new Error('Codex thread/turns/list 未返回 data 数组')

  const data = page.data.map(rawTurn => {
    const turn = record(rawTurn)
    const id = nonEmptyString(turn.id)
    if (!id) throw new Error('Codex thread/turns/list 返回了缺少 Turn.id 的条目')
    if (turn.itemsView !== 'full') {
      throw new Error('Codex thread/turns/list 未遵守 R3F 要求的 itemsView=full，拒绝用不完整历史执行破坏性动作')
    }
    return { ...turn, id } as CodexTurnRecord
  })

  return {
    data,
    nextCursor: nonEmptyString(page.nextCursor)
  }
}

function appendMessageProjection(message: AppendMessage): { hasUnsupportedContent: boolean; text: string } {
  const content = Array.isArray(message.content) ? message.content : []
  const text: string[] = []
  let hasUnsupportedContent = false

  for (const rawPart of content) {
    const part = record(rawPart)
    if (part.type === 'text') {
      const value = nonEmptyString(part.text)
      if (value) text.push(value)
    } else {
      hasUnsupportedContent = true
    }
  }

  return { hasUnsupportedContent, text: text.join('\n') }
}

function messagesFromThread(thread: CodexThreadRecord): ChatMessage[] {`

const paginatedReadThread = String.raw`  const readThreadForBoundary = useCallback(
    async (threadId: string): Promise<CodexThreadRecord> => {
      await window.zero3Codex.start()
      const metadata = threadFromResponse(await window.zero3Codex.thread.read({ threadId, includeTurns: false }))
      if (!metadata) throw new Error('Codex thread/read 未返回可用于 R3F 历史重建的 Thread')

      const turns: CodexTurnRecord[] = []
      const turnIds = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined

      for (let pageIndex = 0; pageIndex < 512; pageIndex += 1) {
        const page = turnsPageFromResponse(
          await window.zero3Codex.thread.turnsList({
            threadId,
            ...(cursor ? { cursor } : {})
          })
        )

        for (const turn of page.data) {
          if (turnIds.has(turn.id)) throw new Error('Codex thread/turns/list 返回重复 Turn.id，已拒绝拼接历史')
          turnIds.add(turn.id)
          turns.push(turn)
        }

        if (!page.nextCursor) return { ...metadata, turns }
        if (cursors.has(page.nextCursor)) throw new Error('Codex thread/turns/list cursor 循环，已拒绝继续历史重建')
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
      }

      throw new Error('Codex thread/turns/list 超过 R3F 512 页安全上限，已拒绝不完整历史')
    },
    []
  )`

const forkRehydrate = String.raw`        const thread = await readThreadForBoundary(forked.id)
        bindThread(thread, messagesFromThread(thread))`

const forkDeps = String.raw`    [bindThread, currentThreadId, enabled, navigate, readThreadForBoundary, resolveMessageBoundary]
  )`

const editMessageCallback = String.raw`  const editMessage = useCallback(
    async (edited: AppendMessage) => {
      const threadId = currentThreadId()
      if (!enabled || !threadId) return
      if (activeTurnByThreadRef.current.has(threadId)) {
        notify({ kind: 'info', message: '请先停止或等待当前 Codex Turn 完成，再编辑历史消息。' })
        return
      }

      const sourceId = nonEmptyString(edited.sourceId) ?? nonEmptyString(edited.parentId)
      const projection = appendMessageProjection(edited)
      const text = sanitizeComposerInput(projection.text).trim()
      if (!sourceId || !text || edited.role !== 'user') {
        notify({ kind: 'info', message: '无法从编辑请求中确定唯一的 Codex user Message 与文本，未执行编辑。' })
        return
      }
      if (projection.hasUnsupportedContent) {
        notify({ kind: 'info', message: '历史消息编辑包含非文本内容；R3F 不会猜测附件重建语义。' })
        return
      }

      try {
        const resolved = await resolveMessageBoundary(threadId, sourceId)
        if (!resolved || resolved.boundary.role !== 'user') {
          notify({ kind: 'info', message: '找不到该编辑消息对应的权威 Codex user Turn，未执行编辑。' })
          return
        }
        const { boundary } = resolved
        if (!boundary.soleUserInTurn || boundary.turnStatus === 'inProgress') {
          notify({ kind: 'info', message: '该 user 消息不是可独立重建的已完成 Codex Turn，未执行编辑。' })
          return
        }
        if (boundary.hasImageInput) {
          notify({ kind: 'info', message: '原 Turn 含图片输入；R3F 不会在缺少原始 structured input 重建时执行破坏性编辑。' })
          return
        }
        if (boundary.inputText.trim() === text) return
        if (selectedStoredSessionIdRef.current !== threadId && activeSessionIdRef.current !== threadId) {
          notify({ kind: 'info', message: '会话已切换，已取消破坏性 Codex 编辑操作。' })
          return
        }

        await window.zero3Codex.thread.revertBeforeTurn({ threadId, beforeTurnId: boundary.turnId })
        const retained = await readThreadForBoundary(threadId)
        bindThread(retained, messagesFromThread(retained))
        await submitText(text, { displayText: text })
      } catch (error) {
        notify({ kind: 'error', title: 'Codex 历史消息编辑失败', message: errorMessage(error) })
      }
    },
    [
      activeSessionIdRef,
      bindThread,
      currentThreadId,
      enabled,
      readThreadForBoundary,
      resolveMessageBoundary,
      selectedStoredSessionIdRef,
      submitText
    ]
  )

  const cancelRun = useCallback(async () => {`

const r3fReturn = String.raw`    deleteThread,
    editMessage,
    enabled,`

const r3fWiring = String.raw`    onEdit: edited =>
      codexPrimaryChat.enabled ? codexPrimaryChat.editMessage(edited) : editMessage(edited),`

function recordR3fProvenance() {
  const file = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
  const provenance = JSON.parse(fs.readFileSync(file, 'utf8'))
  provenance.historyPhase = 'R3F-codex-authoritative-history'
  fs.writeFileSync(file, `${JSON.stringify(provenance, null, 2)}\n`)
}

export function applyZero3CodexAuthoritativeHistory() {
  patchFile('electron/main.ts', [
    {
      label: 'R3F bounded native thread/turns/list validator',
      from: 'function zero3CodexThreadSetNameParams(value: unknown) {',
      to: turnsListValidator
    },
    {
      label: 'R3F dedicated thread/turns-list IPC',
      from: "ipcMain.handle('zero3:codex:turn:start', (_event, request: unknown) =>",
      to: turnsListIpc
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'R3F typed turns-list preload surface',
      from: String.raw`    revertBeforeTurn: request => ipcRenderer.invoke('zero3:codex:thread:revert-before-turn', request)
  },
  turn: {`,
      to: preloadR3f
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'R3F typed turns-list renderer surface',
      from: String.raw`        revertBeforeTurn: (request: Zero3CodexThreadRevertBeforeTurnRequest) => Promise<unknown>
      }
      turn: {`,
      to: globalR3f
    },
    {
      label: 'R3F narrow turns-list request type',
      from: 'type Zero3CodexThreadSetNameRequest = { name: string; threadId: string }',
      to: r3fTypes
    }
  ])

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'R3F AppendMessage edit type',
      from: "import type { MutableRefObject } from 'react'",
      to: appendMessageImport
    },
    {
      label: 'R3F paginated full-Turn history helpers',
      from: 'function messagesFromThread(thread: CodexThreadRecord): ChatMessage[] {',
      to: paginatedHistoryHelpers
    },
    {
      label: 'R3F replace includeTurns snapshot with native pagination',
      from: String.raw`  const readThreadForBoundary = useCallback(
    async (threadId: string): Promise<CodexThreadRecord> => {
      await window.zero3Codex.start()
      const read = threadFromResponse(await window.zero3Codex.thread.read({ threadId, includeTurns: true }))
      if (!read) throw new Error('Codex thread/read 未返回可用于 Turn 映射的 Thread')
      return read
    },
    []
  )`,
      to: paginatedReadThread
    },
    {
      label: 'R3F fork authoritative rehydrate',
      from: String.raw`        const read = threadFromResponse(
          await window.zero3Codex.thread.read({ threadId: forked.id, includeTurns: true })
        )
        const thread = read ?? forked
        bindThread(thread, messagesFromThread(thread))`,
      to: forkRehydrate
    },
    {
      label: 'R3F fork dependency on paginated rehydrate',
      from: String.raw`    [bindThread, currentThreadId, enabled, navigate, resolveMessageBoundary]
  )`,
      to: forkDeps
    },
    {
      label: 'R3F Codex-native historical user edit',
      from: '  const cancelRun = useCallback(async () => {',
      to: editMessageCallback
    },
    {
      label: 'R3F expose edit action through Codex adapter',
      from: String.raw`    deleteThread,
    enabled,`,
      to: r3fReturn
    }
  ])

  patchFile('src/app/contrib/wiring.tsx', [
    {
      label: 'R3F upgrade the R2 Codex-safe edit action to native history edit',
      from: String.raw`    onEdit: message =>
      codexPrimaryChat.enabled ? codexPrimaryChat.unsupportedAction('编辑历史消息') : editMessage(message),`,
      to: r3fWiring
    }
  ])

  recordR3fProvenance()
  console.log('R3F: authoritative history rehydrates through bounded Codex thread/turns/list pages with full ThreadItems; historical user edits use Turn identity + thread/revert and fail closed for attachment ambiguity.')
}

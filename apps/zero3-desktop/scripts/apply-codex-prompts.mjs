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
        `Zero3 Codex prompt drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source changed; review the R2B overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

const promptStoreSource = String.raw`import { atom, computed } from 'nanostores'

export type CodexRequestId = number | string

type CodexPromptBase = {
  requestId: CodexRequestId
  threadId: string
  turnId: string
  itemId: string
}

export type CodexApprovalRequest = CodexPromptBase & {
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval'
  startedAtMs: number
  kind?: 'command' | 'writeStdin'
  command?: string
  cwd?: string
  reason?: string
  grantRoot?: string
}

export type CodexUserInputOption = {
  label: string
  description: string
}

export type CodexUserInputQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: CodexUserInputOption[] | null
}

export type CodexUserInputRequest = CodexPromptBase & {
  method: 'item/tool/requestUserInput'
  questions: CodexUserInputQuestion[]
  isBlocking: boolean
}

const keyFor = (threadId: string | null | undefined) => threadId ?? ''

export const $codexApprovals = atom<Record<string, CodexApprovalRequest>>({})
export const $codexUserInputs = atom<Record<string, CodexUserInputRequest>>({})

export const codexApprovalForSession = (sessionId: string | null) =>
  computed($codexApprovals, requests => requests[keyFor(sessionId)] ?? null)

export const codexUserInputForSession = (sessionId: string | null) =>
  computed($codexUserInputs, requests => requests[keyFor(sessionId)] ?? null)

export function setCodexApproval(request: CodexApprovalRequest): void {
  $codexApprovals.set({ ...$codexApprovals.get(), [keyFor(request.threadId)]: request })
}

export function clearCodexApproval(threadId: string, requestId?: CodexRequestId): void {
  const key = keyFor(threadId)
  const current = $codexApprovals.get()[key]
  if (!current || (requestId !== undefined && current.requestId !== requestId)) return
  const next = { ...$codexApprovals.get() }
  delete next[key]
  $codexApprovals.set(next)
}

export function setCodexUserInput(request: CodexUserInputRequest): void {
  $codexUserInputs.set({ ...$codexUserInputs.get(), [keyFor(request.threadId)]: request })
}

export function clearCodexUserInput(threadId: string, requestId?: CodexRequestId): void {
  const key = keyFor(threadId)
  const current = $codexUserInputs.get()[key]
  if (!current || (requestId !== undefined && current.requestId !== requestId)) return
  const next = { ...$codexUserInputs.get() }
  delete next[key]
  $codexUserInputs.set(next)
}

export function takeCodexPromptRequestIdsForThread(threadId: string): CodexRequestId[] {
  const ids: CodexRequestId[] = []
  const approval = $codexApprovals.get()[keyFor(threadId)]
  const input = $codexUserInputs.get()[keyFor(threadId)]
  if (approval) ids.push(approval.requestId)
  if (input) ids.push(input.requestId)
  clearCodexApproval(threadId)
  clearCodexUserInput(threadId)
  return ids
}
`

const promptOverlaySource = String.raw`'use client'

import { useStore } from '@nanostores/react'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { triggerHaptic } from '@/lib/haptics'
import { AlertCircle, Loader2, MessageQuestion } from '@/lib/icons'
import { notifyError } from '@/store/notifications'

import {
  type CodexApprovalRequest,
  type CodexRequestId,
  type CodexUserInputQuestion,
  clearCodexApproval,
  clearCodexUserInput,
  codexApprovalForSession,
  codexUserInputForSession
} from './prompt-store'

async function respondResult(id: CodexRequestId, result: unknown) {
  return window.zero3Codex.respondToServerRequest({ id, result })
}

async function respondError(id: CodexRequestId, message: string) {
  return window.zero3Codex.respondToServerRequest({
    id,
    error: { code: -32002, message }
  })
}

function approvalDescription(request: CodexApprovalRequest): string {
  if (request.method === 'item/fileChange/requestApproval') {
    return request.reason || (request.grantRoot ? 'Codex 请求额外文件写入权限。' : 'Codex 请求应用文件修改。')
  }
  if (request.kind === 'writeStdin') return request.reason || 'Codex 请求向正在运行的终端进程写入输入。'
  return request.reason || 'Codex 请求执行命令。'
}

function CodexApprovalDialog({ request }: { request: CodexApprovalRequest }) {
  const [submitting, setSubmitting] = useState<'accept' | 'acceptForSession' | 'decline' | null>(null)

  useEffect(() => setSubmitting(null), [request.requestId])

  const respond = useCallback(
    async (decision: 'accept' | 'acceptForSession' | 'decline') => {
      if (submitting) return
      setSubmitting(decision)
      try {
        await respondResult(request.requestId, { decision })
        triggerHaptic(decision === 'decline' ? 'cancel' : 'submit')
        clearCodexApproval(request.threadId, request.requestId)
      } catch (error) {
        notifyError(error, 'Codex 审批响应失败')
        setSubmitting(null)
      }
    },
    [request, submitting]
  )

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !submitting) void respond('decline')
    },
    [respond, submitting]
  )

  const fileChange = request.method === 'item/fileChange/requestApproval'
  const title = fileChange ? 'Codex 请求修改文件' : request.kind === 'writeStdin' ? 'Codex 请求终端输入' : 'Codex 请求执行命令'
  const detail = request.command?.trim() || request.grantRoot?.trim() || ''

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle icon={AlertCircle}>{title}</DialogTitle>
          <DialogDescription>{approvalDescription(request)}</DialogDescription>
        </DialogHeader>

        {request.cwd ? (
          <div className="text-xs text-(--ui-text-tertiary)">
            工作目录：<span className="font-mono text-(--ui-text-secondary)">{request.cwd}</span>
          </div>
        ) : null}

        {detail ? (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
            {detail}
          </pre>
        ) : null}

        <DialogFooter>
          <Button disabled={Boolean(submitting)} onClick={() => void respond('decline')} variant="ghost">
            {submitting === 'decline' ? <Loader2 className="size-3.5 animate-spin" /> : '拒绝'}
          </Button>
          <Button disabled={Boolean(submitting)} onClick={() => void respond('acceptForSession')} variant="secondary">
            {submitting === 'acceptForSession' ? <Loader2 className="size-3.5 animate-spin" /> : '本会话允许'}
          </Button>
          <Button disabled={Boolean(submitting)} onClick={() => void respond('accept')}>
            {submitting === 'accept' ? <Loader2 className="size-3.5 animate-spin" /> : '仅本次允许'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type AnswerState = Record<string, string>

function questionNeedsText(question: CodexUserInputQuestion): boolean {
  return question.isOther || !question.options || question.options.length === 0
}

function CodexUserInputDialog({
  request
}: {
  request: {
    requestId: CodexRequestId
    threadId: string
    questions: CodexUserInputQuestion[]
  }
}) {
  const [answers, setAnswers] = useState<AnswerState>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setAnswers({})
    setSubmitting(false)
  }, [request.requestId])

  const complete = useMemo(
    () =>
      request.questions.length > 0 &&
      request.questions.every(question => {
        const value = answers[question.id]?.trim() || ''
        return value.length > 0
      }),
    [answers, request.questions]
  )

  const submit = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      if (!complete || submitting) return
      setSubmitting(true)
      try {
        const mapped = Object.fromEntries(
          request.questions.map(question => [question.id, { answers: [answers[question.id].trim()] }])
        )
        await respondResult(request.requestId, { answers: mapped })
        triggerHaptic('submit')
        clearCodexUserInput(request.threadId, request.requestId)
      } catch (error) {
        notifyError(error, 'Codex 用户输入响应失败')
        setSubmitting(false)
      }
    },
    [answers, complete, request, submitting]
  )

  const cancel = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await respondError(request.requestId, 'User cancelled the Codex request_user_input prompt.')
      triggerHaptic('cancel')
      clearCodexUserInput(request.threadId, request.requestId)
    } catch (error) {
      notifyError(error, 'Codex 用户输入取消失败')
      setSubmitting(false)
    }
  }, [request, submitting])

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !submitting) void cancel()
    },
    [cancel, submitting]
  )

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle icon={MessageQuestion}>Codex 需要你的输入</DialogTitle>
          <DialogDescription>这些问题来自当前 Codex Turn。回答会直接返回给同一个 app-server 请求。</DialogDescription>
        </DialogHeader>

        <form className="grid max-h-[65vh] gap-5 overflow-auto pr-1" onSubmit={submit}>
          {request.questions.map(question => {
            const options = question.options ?? []
            const value = answers[question.id] ?? ''
            const needsText = questionNeedsText(question)
            return (
              <fieldset className="grid gap-2" key={question.id}>
                {question.header ? <legend className="text-sm font-medium">{question.header}</legend> : null}
                <p className="text-sm text-(--ui-text-secondary)">{question.question}</p>
                {options.length > 0 ? (
                  <div className="grid gap-1">
                    {options.map(option => {
                      const selected = value === option.label
                      return (
                        <Button
                          aria-pressed={selected}
                          className="h-auto min-h-8 justify-start whitespace-normal px-2 py-1.5 text-left"
                          key={option.label}
                          onClick={() => setAnswers(current => ({ ...current, [question.id]: option.label }))}
                          type="button"
                          variant={selected ? 'secondary' : 'ghost'}
                        >
                          <span>
                            <span className="font-medium">{option.label}</span>
                            {option.description ? (
                              <span className="ms-2 text-xs font-normal text-(--ui-text-tertiary)">{option.description}</span>
                            ) : null}
                          </span>
                        </Button>
                      )
                    })}
                  </div>
                ) : null}
                {needsText ? (
                  <Input
                    autoComplete="off"
                    onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
                    placeholder={question.isSecret ? '输入敏感内容' : '输入回答'}
                    type={question.isSecret ? 'password' : 'text'}
                    value={value}
                  />
                ) : null}
              </fieldset>
            )
          })}

          <DialogFooter>
            <Button disabled={submitting} onClick={() => void cancel()} type="button" variant="ghost">
              取消
            </Button>
            <Button disabled={!complete || submitting} type="submit">
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : '继续'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CodexPromptOverlay({ sessionId }: { sessionId: string | null }) {
  const $approval = useMemo(() => codexApprovalForSession(sessionId), [sessionId])
  const $input = useMemo(() => codexUserInputForSession(sessionId), [sessionId])
  const approval = useStore($approval)
  const input = useStore($input)

  if (approval) return <CodexApprovalDialog request={approval} />
  if (input) return <CodexUserInputDialog request={input} />
  return null
}
`

const primaryChatImports = String.raw`import {
  setCodexApproval,
  setCodexUserInput,
  takeCodexPromptRequestIdsForThread
} from './prompt-store'

import type { ClientSessionState } from '../types'`

const requestHandler = String.raw`      if (event.kind === 'request') {
        const params = record(event.params)
        const threadId = nonEmptyString(params.threadId)
        const turnId = nonEmptyString(params.turnId)
        const itemId = nonEmptyString(params.itemId)

        if (
          event.method === 'item/commandExecution/requestApproval' &&
          threadId &&
          turnId &&
          itemId
        ) {
          setCodexApproval({
            requestId: event.id,
            method: event.method,
            threadId,
            turnId,
            itemId,
            startedAtMs: numberOr(params.startedAtMs, Date.now()),
            ...(params.kind === 'writeStdin' || params.kind === 'command' ? { kind: params.kind } : {}),
            ...(typeof params.command === 'string' ? { command: params.command } : {}),
            ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
            ...(typeof params.reason === 'string' ? { reason: params.reason } : {})
          })
          return
        }

        if (event.method === 'item/fileChange/requestApproval' && threadId && turnId && itemId) {
          setCodexApproval({
            requestId: event.id,
            method: event.method,
            threadId,
            turnId,
            itemId,
            startedAtMs: numberOr(params.startedAtMs, Date.now()),
            ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
            ...(typeof params.grantRoot === 'string' ? { grantRoot: params.grantRoot } : {})
          })
          return
        }

        if (event.method === 'item/tool/requestUserInput' && threadId && turnId && itemId) {
          const questions = Array.isArray(params.questions)
            ? params.questions
                .map(value => record(value))
                .map(question => ({
                  id: nonEmptyString(question.id) ?? '',
                  header: typeof question.header === 'string' ? question.header : '',
                  question: typeof question.question === 'string' ? question.question : '',
                  isOther: question.isOther === true,
                  isSecret: question.isSecret === true,
                  options: Array.isArray(question.options)
                    ? question.options
                        .map(value => record(value))
                        .map(option => ({
                          label: nonEmptyString(option.label) ?? '',
                          description: typeof option.description === 'string' ? option.description : ''
                        }))
                        .filter(option => option.label)
                    : null
                }))
                .filter(question => question.id && question.question)
            : []

          if (questions.length > 0) {
            setCodexUserInput({
              requestId: event.id,
              method: event.method,
              threadId,
              turnId,
              itemId,
              questions,
              isBlocking: params.isBlocking === true
            })
            return
          }
        }

        void window.zero3Codex.respondToServerRequest({
          id: event.id,
          error: {
            code: -32001,
            message: 'Zero3 R2B does not expose this Codex server request yet; request denied fail-closed.'
          }
        })
        return
      }`

const rejectPendingHelper = String.raw`  const rejectPendingPrompts = useCallback(async (threadId: string, message: string) => {
    const requestIds = takeCodexPromptRequestIdsForThread(threadId)
    await Promise.allSettled(
      requestIds.map(id =>
        window.zero3Codex.respondToServerRequest({
          id,
          error: { code: -32003, message }
        })
      )
    )
  }, [])

  const cancelRun = useCallback(async () => {`

export function applyZero3CodexPrompts() {
  const generatedDir = path.join(hermesDesktopDir, 'src', 'app', 'zero3-codex')
  fs.mkdirSync(generatedDir, { recursive: true })
  fs.writeFileSync(path.join(generatedDir, 'prompt-store.ts'), promptStoreSource)
  fs.writeFileSync(path.join(generatedDir, 'prompt-overlay.tsx'), promptOverlaySource)

  patchFile('src/app/zero3-codex/primary-chat.ts', [
    {
      label: 'Codex prompt-store imports',
      from: "import type { ClientSessionState } from '../types'",
      to: primaryChatImports
    },
    {
      label: 'R2B native approval policy',
      from: "const R2_APPROVAL_POLICY = 'never' as const",
      to: "const R2_APPROVAL_POLICY = 'on-request' as const"
    },
    {
      label: 'R2B native Codex server-request dispatcher',
      from: String.raw`      if (event.kind === 'request') {
        void window.zero3Codex.respondToServerRequest({
          id: event.id,
          error: {
            code: -32001,
            message: 'Zero3 R2A approval/input UI is not connected yet; request denied fail-closed.'
          }
        })
        return
      }`,
      to: requestHandler
    },
    {
      label: 'Codex prompt cleanup helper',
      from: '  const cancelRun = useCallback(async () => {',
      to: rejectPendingHelper
    },
    {
      label: 'reject pending prompts on user Stop',
      from: "    try {\n      await window.zero3Codex.turn.interrupt({ threadId, turnId })",
      to:
        "    try {\n" +
        "      await rejectPendingPrompts(threadId, 'Codex turn interrupted by user.')\n" +
        "      await window.zero3Codex.turn.interrupt({ threadId, turnId })"
    },
    {
      label: 'cancel callback depends on prompt cleanup',
      from: '  }, [activeSessionIdRef, busyRef, enabled, selectedStoredSessionIdRef, updateSessionState])',
      to:
        '  }, [activeSessionIdRef, busyRef, enabled, rejectPendingPrompts, selectedStoredSessionIdRef, updateSessionState])'
    },
    {
      label: 'clear stale prompt requests on turn completion',
      from:
        "        const turn = record(params.turn)\n" +
        "        activeTurnByThreadRef.current.delete(threadId)",
      to:
        "        const turn = record(params.turn)\n" +
        "        activeTurnByThreadRef.current.delete(threadId)\n" +
        "        void rejectPendingPrompts(threadId, 'Codex turn completed before the prompt was answered.')"
    },
    {
      label: 'event effect depends on prompt cleanup',
      from:
        '  }, [busyRef, enabled, ensureSessionState, refreshSessions, selectedStoredSessionIdRef, updateSessionState])',
      to:
        '  }, [busyRef, enabled, ensureSessionState, refreshSessions, rejectPendingPrompts, selectedStoredSessionIdRef, updateSessionState])'
    }
  ])

  patchFile('src/components/prompt-overlays.tsx', [
    {
      label: 'Codex prompt overlay import',
      from: "import { PendingApprovalFallback } from '@/components/assistant-ui/tool/approval'",
      to:
        "import { CodexPromptOverlay } from '@/app/zero3-codex/prompt-overlay'\n" +
        "import { PendingApprovalFallback } from '@/components/assistant-ui/tool/approval'"
    },
    {
      label: 'Codex prompt overlay mount',
      from:
        "  return (\n" +
        "    <>\n" +
        "      <PendingApprovalFallback />\n" +
        "      <SudoDialog sessionId={sessionId} />",
      to:
        "  return (\n" +
        "    <>\n" +
        "      <CodexPromptOverlay sessionId={sessionId} />\n" +
        "      <PendingApprovalFallback />\n" +
        "      <SudoDialog sessionId={sessionId} />"
    }
  ])
}

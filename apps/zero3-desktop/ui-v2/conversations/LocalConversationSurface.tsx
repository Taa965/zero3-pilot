import { useEffect, useMemo, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { LocalSessionAdapter } from '../adapters/LocalSessionAdapter'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { ProjectLinkAdapter } from '../adapters/ProjectLinkAdapter'
import type { LocalSessionProvider, LocalSessionRecord } from './session-types'
import { localTurnFailureMessage, localTurnRecovery } from './local-turn-failure'

interface LocalConversationSurfaceProps {
  provider: LocalSessionProvider
  session: LocalSessionRecord | null
  project: Zero3ProjectRecord | null
  onChanged: () => void
}

function providerLabel(provider: LocalSessionProvider) {
  if (provider === 'codex') return 'Codex Local'
  if (provider === 'claude') return 'Claude Code'
  if (provider === 'antigravity') return 'Antigravity'
  return 'Zero3'
}

// The official Codex client is an external collaborator on the same footing as
// Claude Code, so it is driven through the session-provider bridge rather than
// the pinned Agent Kernel that Zero3 itself runs on.
async function runCodexTurn(session: LocalSessionRecord, project: Zero3ProjectRecord | null, prompt: string, requestId: string) {
  const result = await window.zero3SessionProviders.codexTurn({
    text: prompt,
    cwd: session.projectBinding?.rootPath ?? project?.rootPath ?? null,
    threadId: session.runtimeId,
    requestId,
    model: session.model,
    effort: session.thinkingEffort === 'low' || session.thinkingEffort === 'medium' || session.thinkingEffort === 'high' || session.thinkingEffort === 'xhigh'
      ? session.thinkingEffort
      : null
  })
  if (result.threadId && result.threadId !== session.runtimeId) {
    LocalSessionAdapter.setRuntimeId(session.id, result.threadId)
  }
  if (result.threadId && project && session.projectBinding?.externalId && !session.nativeProjectAttached) {
    try {
      await ProjectLinkAdapter.attachCodexThread({ projectId: project.id, externalId: session.projectBinding.externalId, threadId: result.threadId })
      LocalSessionAdapter.markNativeProjectAttached(session.id)
    } catch (error) {
      return `${result.text}\n\n项目归属尚未同步：${error instanceof Error ? error.message : String(error)}。下次发送时会重试。`
    }
  }
  return result.text
}

async function runClaudeTurn(session: LocalSessionRecord, project: Zero3ProjectRecord | null, prompt: string) {
  const result = await window.zero3SessionProviders.claudeTurn({
    text: prompt,
    cwd: session.projectBinding?.rootPath ?? project?.rootPath ?? null,
    sessionId: session.runtimeId,
    model: session.model,
    effort: session.thinkingEffort
  })
  if (result.sessionId && result.sessionId !== session.runtimeId) {
    LocalSessionAdapter.setRuntimeId(session.id, result.sessionId)
  }
  return result.text
}

async function runAntigravityTurn(session: LocalSessionRecord, project: Zero3ProjectRecord | null, prompt: string) {
  if (!project?.rootPath) throw new Error('Antigravity 会话需要绑定 Zero3 项目目录')
  const logicalSessionId = session.runtimeId ?? session.id
  if (!session.runtimeId) LocalSessionAdapter.setRuntimeId(session.id, logicalSessionId)
  const turn = await window.zero3Antigravity.startTurn({
    logicalSessionId,
    projectId: project.id,
    providerProjectId: session.projectBinding?.externalId ?? null,
    cwd: session.projectBinding?.rootPath ?? project.rootPath,
    prompt,
    model: session.model,
    effort: session.thinkingEffort === 'low' || session.thinkingEffort === 'medium' || session.thinkingEffort === 'high'
      ? session.thinkingEffort
      : null
  })
  const result = await window.zero3Antigravity.waitTurn({ turnId: turn.turnId })
  if (result.status !== 'COMPLETE' && result.status !== 'PARTIAL') {
    throw new Error(result.error ?? `Antigravity turn 状态：${result.status}`)
  }
  return result.response ?? (result.structuredOutput ? JSON.stringify(result.structuredOutput, null, 2) : 'Antigravity 已完成，但没有返回文本。')
}

async function runZero3Turn(session: LocalSessionRecord, project: Zero3ProjectRecord | null, prompt: string) {
  if (!session.zero3ProfileId) throw new Error('该 Zero3 会话没有绑定 API Profile')
  if (!project?.rootPath) throw new Error('Zero3 本体需要绑定项目目录，才能提供文件、终端与工具能力')
  const migrationHistory = session.runtimeId
    ? []
    : session.messages.slice(0, -1).map(message => ({ role: message.role, content: message.content }))
  const result = await window.zero3SessionProviders.zero3Turn({
    profileId: session.zero3ProfileId,
    text: prompt,
    cwd: project.rootPath,
    projectId: project.id,
    threadId: session.runtimeId,
    history: migrationHistory
  })
  if (result.threadId && result.threadId !== session.runtimeId) {
    LocalSessionAdapter.setRuntimeId(session.id, result.threadId)
  }
  return result.text
}

export function LocalConversationSurface({ provider, session, project, onChanged }: LocalConversationSurfaceProps) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null)
  const [messages, setMessages] = useState(session?.messages ?? [])
  const [codexProgressLog, setCodexProgressLog] = useState<string[]>([])
  const activeCodexRequestId = useRef<string | null>(null)
  const codexProgressEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setMessages(session?.messages ?? [])
  }, [session?.id, session?.updatedAt])

  useEffect(() => {
    setError(null)
    setRecoveryNotice(null)
    setCodexProgressLog([])
    activeCodexRequestId.current = null
  }, [session?.id])

  useEffect(() => {
    const subscribe = window.zero3SessionProviders?.onCodexProgress
    if (provider !== 'codex' || typeof subscribe !== 'function') return
    return subscribe(event => {
      if (event.requestId !== activeCodexRequestId.current) return
      const detail = event.detail.trim()
      if (!detail) return
      setCodexProgressLog(current => current.at(-1) === detail ? current : [...current, detail].slice(-40))
    })
  }, [provider])

  useEffect(() => {
    if (busy && provider === 'codex') codexProgressEndRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [busy, codexProgressLog.length, provider])

  const requiresProject = provider === 'codex' || provider === 'claude' || provider === 'antigravity' || provider === 'zero3'
  const canSend = Boolean(session && input.trim() && !busy && (!requiresProject || project))
  const lastMessage = messages.at(-1)
  const savedFailure = lastMessage?.role === 'assistant' && lastMessage.content.startsWith('执行失败：')
    ? localTurnFailureMessage(lastMessage.content) : null
  const failureMessage = error ?? savedFailure
  const recovery = localTurnRecovery(provider, failureMessage)
  const canReauthorize = provider === 'codex' || provider === 'claude'

  const recover = async () => {
    if (!session || busy) return
    try {
      if (recovery === 'model') {
        LocalSessionAdapter.resetRuntimeConfig(session.id)
        setInput(current => current || [...messages].reverse().find(message => message.role === 'user')?.content || '')
        setRecoveryNotice('已恢复本机默认模型和思考设置。可直接重新发送，无需新建会话。')
        onChanged()
      } else if (canReauthorize) {
        const result = await window.zero3SessionProviders.authorize({ provider })
        setRecoveryNotice(result.detail)
      }
    } catch (nextError) {
      setError(localTurnFailureMessage(nextError))
    }
  }
  const subtitle = useMemo(() => {
    if (!session) return '未选择会话'
    if (provider === 'zero3') return session.zero3ProfileId ? `API Profile: ${session.zero3ProfileId}` : '未绑定 API Profile'
    const runtime = session.runtimeId ? `Runtime: ${session.runtimeId}` : '运行时将在首次发送时建立'
    const model = session.model ? `Model: ${session.model}` : 'Model: 官方默认'
    const effort = session.thinkingEffort ? `思考: ${session.thinkingEffort}` : '思考: 官方默认'
    return `${model} · ${effort} · ${runtime}`
  }, [provider, session])

  const send = async () => {
    if (!session || !canSend) return
    const prompt = input.trim()
    setInput('')
    setBusy(true)
    setError(null)
    setRecoveryNotice(null)
    const codexRequestId = provider === 'codex' ? crypto.randomUUID() : null
    if (codexRequestId) {
      activeCodexRequestId.current = codexRequestId
      setCodexProgressLog(['正在启动 Codex…'])
    }
    try {
      const withUser = LocalSessionAdapter.appendMessage(session.id, 'user', prompt)
      setMessages(withUser.messages)
      let response: string
      if (provider === 'codex') response = await runCodexTurn(withUser, project, prompt, codexRequestId!)
      else if (provider === 'claude') response = await runClaudeTurn(withUser, project, prompt)
      else if (provider === 'antigravity') response = await runAntigravityTurn(withUser, project, prompt)
      else response = await runZero3Turn(withUser, project, prompt)
      const withAssistant = LocalSessionAdapter.appendMessage(session.id, 'assistant', response)
      setMessages(withAssistant.messages)
      onChanged()
    } catch (nextError) {
      const message = localTurnFailureMessage(nextError)
      setError(message)
      const withAssistant = LocalSessionAdapter.appendMessage(session.id, 'assistant', `执行失败：${message}`)
      setMessages(withAssistant.messages)
      onChanged()
    } finally {
      if (codexRequestId && activeCodexRequestId.current === codexRequestId) {
        activeCodexRequestId.current = null
      }
      setBusy(false)
    }
  }

  if (!session || session.provider !== provider) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-(--ui-text-secondary)">
        <Codicon name="comment-discussion" className="mb-4 size-12 opacity-40" />
        <div>从左侧选择一个 {providerLabel(provider)} 会话</div>
        <div className="mt-2 text-xs text-(--ui-text-tertiary)">点击 ＋ 可以创建新的平台会话</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-(--ui-border) px-4">
        <div className="font-medium">{providerLabel(provider)}</div>
        <div className="truncate text-xs text-(--ui-text-tertiary)">{subtitle}</div>
        {project && <div className="ml-auto rounded bg-(--ui-control-background) px-2 py-1 text-xs text-(--ui-text-secondary)">{project.name}</div>}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {messages.length === 0 && (
          <div className="py-16 text-center text-sm text-(--ui-text-tertiary)">
            这是一个真实的 {providerLabel(provider)} 会话。发送第一条消息后才会启动对应运行时。
          </div>
        )}
        {messages.map(message => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[82%] whitespace-pre-wrap rounded-xl px-4 py-3 text-sm leading-6 ${message.role === 'user' ? 'bg-blue-600 text-white' : 'border border-(--ui-border) bg-(--ui-pane-background)'}`}>
              {message.content.startsWith('执行失败：') ? `执行失败：${localTurnFailureMessage(message.content)}` : message.content}
            </div>
          </div>
        ))}
        {busy && provider === 'codex' && (
          <div className="max-w-[88%] space-y-2 py-1 text-sm">
            {codexProgressLog.map((detail, index) => {
              const isLatest = index === codexProgressLog.length - 1
              const isCommand = detail.includes('命令')
              return (
                <div key={`${index}-${detail}`} className="flex items-start gap-2.5 text-(--ui-text-secondary)">
                  <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                    {isCommand
                      ? <span className="flex size-5 items-center justify-center rounded bg-(--ui-text-primary) text-white"><Codicon name="terminal" className="size-3" /></span>
                      : <span className={`size-2 rounded-full ${isLatest ? 'animate-pulse bg-blue-500' : 'bg-(--ui-text-tertiary)'}`} />}
                  </div>
                  <div className={`min-w-0 break-words leading-6 ${isLatest ? 'text-(--ui-text-primary)' : ''}`}>{detail}</div>
                </div>
              )
            })}
            <div ref={codexProgressEndRef} />
          </div>
        )}
        {busy && provider !== 'codex' && <div className="text-xs text-(--ui-text-tertiary)">正在执行 {providerLabel(provider)}…</div>}
        {failureMessage && (
          <div role="alert" className="space-y-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600">
            {recovery === 'model' && <div>当前模型可能不受账号支持。恢复本机默认设置后重新发送，或在新建会话时填写账号可用的模型。</div>}
            {recovery === 'auth' && <div>服务端拒绝了请求。本地存在登录凭证并不代表当前授权可用；请重新登录后重试，若仍返回 403，请检查账号访问权限和网络。</div>}
            {!recovery && <div>{failureMessage}</div>}
            {(recovery || canReauthorize) && <button disabled={busy} onClick={() => void recover()} className="rounded border border-current px-2 py-1 disabled:opacity-50">{recovery === 'model' ? '恢复本机默认设置' : '重新登录'}</button>}
          </div>
        )}
        {recoveryNotice && <div role="status" className="text-xs text-(--ui-text-secondary)">{recoveryNotice}</div>}
      </div>

      <div className="shrink-0 border-t border-(--ui-border) p-4">
        {requiresProject && !project && (
          <div className="mb-2 text-xs text-amber-600">本地 Agent 会访问工作目录，请先选择一个 Zero3 项目。</div>
        )}
        <div className="relative">
          <textarea
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            disabled={busy}
            placeholder={`给 ${providerLabel(provider)} 发送消息…`}
            className="min-h-[92px] w-full resize-none rounded-lg border border-(--ui-border) bg-(--ui-pane-background) p-3 pr-14 text-sm outline-none focus:border-blue-500 disabled:opacity-60"
          />
          <button
            disabled={!canSend}
            onClick={() => void send()}
            className="absolute bottom-3 right-3 rounded-md bg-blue-600 p-2 text-white disabled:opacity-40"
            aria-label="发送"
          >
            <Codicon name="send" className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

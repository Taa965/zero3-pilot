import { useEffect, useMemo, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { LocalSessionAdapter } from '../adapters/LocalSessionAdapter'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import type { LocalSessionProvider, LocalSessionRecord } from './session-types'

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
async function runCodexTurn(session: LocalSessionRecord, project: Zero3ProjectRecord | null, prompt: string) {
  const result = await window.zero3SessionProviders.codexTurn({
    text: prompt,
    cwd: project?.rootPath ?? null,
    threadId: session.runtimeId
  })
  if (result.threadId && result.threadId !== session.runtimeId) {
    LocalSessionAdapter.setRuntimeId(session.id, result.threadId)
  }
  return result.text
}

async function runClaudeTurn(session: LocalSessionRecord, project: Zero3ProjectRecord | null, prompt: string) {
  const result = await window.zero3SessionProviders.claudeTurn({
    text: prompt,
    cwd: project?.rootPath ?? null,
    sessionId: session.runtimeId
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
    cwd: project.rootPath,
    prompt
  })
  const result = await window.zero3Antigravity.waitTurn({ turnId: turn.turnId })
  if (result.status !== 'COMPLETE' && result.status !== 'PARTIAL') {
    throw new Error(result.error ?? `Antigravity turn 状态：${result.status}`)
  }
  return result.response ?? (result.structuredOutput ? JSON.stringify(result.structuredOutput, null, 2) : 'Antigravity 已完成，但没有返回文本。')
}

async function runZero3Turn(session: LocalSessionRecord) {
  if (!session.zero3ProfileId) throw new Error('该 Zero3 会话没有绑定 API Profile')
  const messages = session.messages.map(message => ({ role: message.role, content: message.content }))
  return (await window.zero3SessionProviders.zero3Turn({
    profileId: session.zero3ProfileId,
    messages
  })).text
}

export function LocalConversationSurface({ provider, session, project, onChanged }: LocalConversationSurfaceProps) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState(session?.messages ?? [])

  useEffect(() => {
    setMessages(session?.messages ?? [])
    setError(null)
  }, [session?.id, session?.updatedAt])

  const requiresProject = provider === 'codex' || provider === 'claude' || provider === 'antigravity'
  const canSend = Boolean(session && input.trim() && !busy && (!requiresProject || project))
  const subtitle = useMemo(() => {
    if (!session) return '未选择会话'
    if (provider === 'zero3') return session.zero3ProfileId ? `API Profile: ${session.zero3ProfileId}` : '未绑定 API Profile'
    return session.runtimeId ? `Runtime: ${session.runtimeId}` : '运行时将在首次发送时建立'
  }, [provider, session])

  const send = async () => {
    if (!session || !canSend) return
    const prompt = input.trim()
    setInput('')
    setBusy(true)
    setError(null)
    try {
      const withUser = LocalSessionAdapter.appendMessage(session.id, 'user', prompt)
      setMessages(withUser.messages)
      let response: string
      if (provider === 'codex') response = await runCodexTurn(withUser, project, prompt)
      else if (provider === 'claude') response = await runClaudeTurn(withUser, project, prompt)
      else if (provider === 'antigravity') response = await runAntigravityTurn(withUser, project, prompt)
      else response = await runZero3Turn(withUser)
      const withAssistant = LocalSessionAdapter.appendMessage(session.id, 'assistant', response)
      setMessages(withAssistant.messages)
      onChanged()
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError)
      setError(message)
      const withAssistant = LocalSessionAdapter.appendMessage(session.id, 'assistant', `执行失败：${message}`)
      setMessages(withAssistant.messages)
      onChanged()
    } finally {
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
              {message.content}
            </div>
          </div>
        ))}
        {busy && <div className="text-xs text-(--ui-text-tertiary)">正在执行 {providerLabel(provider)}…</div>}
        {error && <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600">{error}</div>}
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

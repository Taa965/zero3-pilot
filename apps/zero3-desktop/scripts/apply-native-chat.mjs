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
        `Zero3 native chat drift in ${relativePath}: could not find ${replacement.label}. ` +
          'The pinned Hermes Desktop source or the Zero3 native bridge changed; review the chat overlay before updating the pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3NativeChat() {
  patchFile('electron/main.ts', [
    {
      label: 'native chat IPC after Agent dispatch',
      from: `ipcMain.handle('zero3:agent:dispatch', async (_event, request: unknown) => {
  return dispatchZero3Agent(request)
})

ipcMain.handle('hermes:api', async (_event, request) => {`,
      to: `ipcMain.handle('zero3:agent:dispatch', async (_event, request: unknown) => {
  return dispatchZero3Agent(request)
})

type Zero3ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type Zero3ChatTurnPayload = {
  backend: string
  message: string
  history: Zero3ChatMessage[]
}

function parseZero3ChatTurn(value: unknown): Zero3ChatTurnPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero3 Chat payload must be an object')
  }

  const payload = value as Record<string, unknown>
  const backend = typeof payload.backend === 'string' ? payload.backend.trim() : ''
  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  const historyValue = Array.isArray(payload.history) ? payload.history : []

  if (!backend || backend.length > 128) {
    throw new Error('Zero3 Chat backend is required and must be at most 128 characters')
  }
  if (!message || message.length > 20000) {
    throw new Error('Zero3 Chat message is required and must be at most 20000 characters')
  }
  if (historyValue.length > 24) {
    throw new Error('Zero3 Chat history is limited to the most recent 24 messages')
  }

  const history = historyValue.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Zero3 Chat history item ' + String(index + 1) + ' must be an object')
    }
    const record = item as Record<string, unknown>
    const role = record.role
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    if (role !== 'user' && role !== 'assistant') {
      throw new Error('Zero3 Chat history roles must be user or assistant')
    }
    if (!content || content.length > 20000) {
      throw new Error('Zero3 Chat history content must be between 1 and 20000 characters')
    }
    return { role, content } as Zero3ChatMessage
  })

  return { backend, message, history }
}

function zero3ChatJobRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function zero3ChatJobText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function zero3ChatJobContent(job: Record<string, unknown>): string {
  const output = zero3ChatJobRecord(job.output)
  const summary = zero3ChatJobText(output.summary)
  if (summary) return summary

  const nested = zero3ChatJobRecord(output.output)
  return (
    zero3ChatJobText(nested.summary) ??
    zero3ChatJobText(nested.stdout) ??
    zero3ChatJobText(job.error) ??
    'Agent 已完成，但没有返回可显示的文本。'
  )
}

async function waitForZero3ChatJob(jobId: string): Promise<{ job_id: string; content: string }> {
  const deadline = Date.now() + 10 * 60 * 1000

  while (Date.now() < deadline) {
    const jobs = await readZero3Node('jobs')
    if (!Array.isArray(jobs)) {
      throw new Error('Zero3 Node jobs response is not an array')
    }

    const match = jobs
      .map(zero3ChatJobRecord)
      .find(job => zero3ChatJobText(job.id) === jobId)

    if (match) {
      const status = zero3ChatJobText(match.status)
      if (status === 'Succeeded') {
        return { job_id: jobId, content: zero3ChatJobContent(match) }
      }
      if (status === 'Failed') {
        throw new Error(zero3ChatJobText(match.error) ?? 'Zero3 Chat Agent job failed')
      }
      if (status === 'Cancelled') {
        throw new Error('Zero3 Chat Agent job was cancelled')
      }
    }

    await new Promise(resolve => setTimeout(resolve, 350))
  }

  throw new Error('Zero3 Chat turn timed out after 10 minutes')
}

ipcMain.handle('zero3:chat:turn', async (_event, request: unknown) => {
  const payload = parseZero3ChatTurn(request)
  const accepted = zero3ChatJobRecord(
    await dispatchZero3Agent({
      backend: payload.backend,
      goal: payload.message,
      context: {
        source: 'zero3-native-chat',
        transport: 'zero3-electron-ipc',
        history: payload.history
      }
    })
  )
  const jobId = zero3ChatJobText(accepted.job_id)
  if (!jobId) throw new Error('Zero3 Chat dispatch did not return a job id')
  return waitForZero3ChatJob(jobId)
})

ipcMain.handle('hermes:api', async (_event, request) => {`
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'native chat preload method',
      from: `  memory: () => ipcRenderer.invoke('zero3:read', 'memory'),
  dispatchAgent: request => ipcRenderer.invoke('zero3:agent:dispatch', request)
})`,
      to: `  memory: () => ipcRenderer.invoke('zero3:read', 'memory'),
  dispatchAgent: request => ipcRenderer.invoke('zero3:agent:dispatch', request),
  chatTurn: request => ipcRenderer.invoke('zero3:chat:turn', request)
})`
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'native chat renderer type',
      from: `      dispatchAgent: (request: {
        backend: string
        goal: string
        context?: Record<string, unknown>
      }) => Promise<{ job_id: string }>
    }`,
      to: `      dispatchAgent: (request: {
        backend: string
        goal: string
        context?: Record<string, unknown>
      }) => Promise<{ job_id: string }>
      chatTurn: (request: {
        backend: string
        message: string
        history?: Array<{ role: 'user' | 'assistant'; content: string }>
      }) => Promise<{ job_id: string; content: string }>
    }`
    }
  ])

  patchFile('src/app/settings/zero3-control-settings.tsx', [
    {
      label: 'native chat message type and persistence helpers',
      from: `type Snapshot = {
  health: JsonRecord
  status: JsonRecord
  jobs: unknown[]
  schedules: unknown[]
  memory: unknown[]
}

function record(value: unknown): JsonRecord {`,
      to: `type Snapshot = {
  health: JsonRecord
  status: JsonRecord
  jobs: unknown[]
  schedules: unknown[]
  memory: unknown[]
}

type NativeChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const NATIVE_CHAT_STORAGE_KEY = 'zero3-native-chat-phase-b2-v1'

function loadNativeChat(): NativeChatMessage[] {
  try {
    const raw = window.localStorage.getItem(NATIVE_CHAT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => item as Record<string, unknown>)
      .filter(item => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
      .slice(-40)
      .map((item, index) => ({
        id: typeof item.id === 'string' ? item.id : 'restored-' + String(index),
        role: item.role as 'user' | 'assistant',
        content: String(item.content)
      }))
  } catch {
    return []
  }
}

function nativeChatId(role: 'user' | 'assistant') {
  return role + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function record(value: unknown): JsonRecord {`
    },
    {
      label: 'native chat component state',
      from: `  const [dispatching, setDispatching] = useState(false)
  const [dispatchMessage, setDispatchMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {`,
      to: `  const [dispatching, setDispatching] = useState(false)
  const [dispatchMessage, setDispatchMessage] = useState<string | null>(null)
  const [chatBackend, setChatBackend] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatMessages, setChatMessages] = useState<NativeChatMessage[]>(loadNativeChat)

  const refresh = useCallback(async () => {`
    },
    {
      label: 'native chat backend selection and persistence',
      from: `  useEffect(() => {
    if (!agentBackend && agents.length > 0) {
      setAgentBackend(agentName(agents[0], 0))
    }
  }, [agentBackend, agents])

  const dispatchAgent = useCallback(async () => {`,
      to: `  useEffect(() => {
    if (!agentBackend && agents.length > 0) {
      setAgentBackend(agentName(agents[0], 0))
    }
    if (!chatBackend && agents.length > 0) {
      setChatBackend(agentName(agents[0], 0))
    }
  }, [agentBackend, agents, chatBackend])

  useEffect(() => {
    try {
      window.localStorage.setItem(NATIVE_CHAT_STORAGE_KEY, JSON.stringify(chatMessages.slice(-40)))
    } catch {
      // Persistence is best-effort; the current in-memory transcript remains usable.
    }
  }, [chatMessages])

  const dispatchAgent = useCallback(async () => {`
    },
    {
      label: 'native chat send callback',
      from: `  }, [agentBackend, agentGoal, refresh])

  const browser = record(snapshot?.status.browser)`,
      to: `  }, [agentBackend, agentGoal, refresh])

  const sendNativeChat = useCallback(async () => {
    const content = chatInput.trim()
    if (!chatBackend || !content || chatBusy) return

    const previous = chatMessages.slice(-24)
    const userMessage: NativeChatMessage = { id: nativeChatId('user'), role: 'user', content }
    setChatMessages(current => [...current, userMessage].slice(-40))
    setChatInput('')
    setChatBusy(true)

    try {
      const result = await window.zero3Desktop.chatTurn({
        backend: chatBackend,
        message: content,
        history: previous.map(message => ({ role: message.role, content: message.content }))
      })
      const assistantMessage: NativeChatMessage = {
        id: nativeChatId('assistant'),
        role: 'assistant',
        content: result.content
      }
      setChatMessages(current => [...current, assistantMessage].slice(-40))
      await refresh()
    } catch (nextError) {
      const assistantMessage: NativeChatMessage = {
        id: nativeChatId('assistant'),
        role: 'assistant',
        content: '执行失败：' + (nextError instanceof Error ? nextError.message : String(nextError))
      }
      setChatMessages(current => [...current, assistantMessage].slice(-40))
    } finally {
      setChatBusy(false)
    }
  }, [chatBackend, chatBusy, chatInput, chatMessages, refresh])

  const browser = record(snapshot?.status.browser)`
    },
    {
      label: 'native chat control surface',
      from: `      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B2 已开放第一个受控写入面：Agent dispatch。健康状态、系统状态、任务、定时任务和记忆仍通过固定只读资源读取；Schedule、Memory、Browser 和 Computer 写操作继续保持关闭，后续按独立白名单与原生审批逐项开放。
      </div>`,
      to: `      <div className="mt-7">
        <SectionHeading icon={Settings2} meta="Phase B2" title="Zero3 原生 Chat" />
        <div className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="grid min-w-48 gap-1.5 text-xs text-muted-foreground">
              Chat Agent
              <select
                className="h-9 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2 text-sm text-foreground outline-none"
                disabled={!online || chatBusy || agents.length === 0}
                onChange={event => setChatBackend(event.target.value)}
                value={chatBackend}
              >
                {agents.map((agent, index) => {
                  const name = agentName(agent, index)
                  return (
                    <option key={'chat-' + name} value={name}>
                      {name}
                    </option>
                  )
                })}
              </select>
            </label>
            <Button
              disabled={chatBusy || chatMessages.length === 0}
              onClick={() => setChatMessages([])}
              size="sm"
              type="button"
              variant="outline"
            >
              清空会话
            </Button>
          </div>

          <div className="mt-3 max-h-80 min-h-36 space-y-2 overflow-y-auto rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) p-3">
            {chatMessages.length === 0 ? (
              <div className="py-8 text-center text-xs leading-5 text-muted-foreground">
                这是第一条绕过 Hermes Gateway 的 Zero3 Desktop → Electron IPC → Zero3 Node → Agent 对话链路。
              </div>
            ) : (
              chatMessages.map(message => (
                <div
                  className={
                    message.role === 'user'
                      ? 'ml-auto max-w-[88%] rounded-lg bg-primary/10 px-3 py-2 text-sm leading-6'
                      : 'mr-auto max-w-[88%] rounded-lg bg-(--ui-bg-tertiary) px-3 py-2 text-sm leading-6'
                  }
                  key={message.id}
                >
                  <div className="mb-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {message.role === 'user' ? '你' : chatBackend || 'Agent'}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                </div>
              ))
            )}
            {chatBusy ? <div className="text-xs text-muted-foreground">Agent 正在执行…</div> : null}
          </div>

          <label className="mt-3 grid gap-1.5 text-xs text-muted-foreground">
            消息
            <textarea
              className="min-h-20 resize-y rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 py-2 text-sm leading-5 text-foreground outline-none"
              disabled={!online || chatBusy}
              maxLength={20000}
              onChange={event => setChatInput(event.target.value)}
              placeholder="输入消息，当前会把最近 24 条对话作为 Zero3 上下文交给 Agent。"
              value={chatInput}
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
              当前是 Phase B2 transport probe：聊天请求不经过 Hermes Gateway，而是走 Zero3 专用 IPC。底层 Agent job 仍沿用 Zero3 权限门禁，因此需要提升权限时会显示 Electron 原生确认。
            </p>
            <Button
              disabled={!online || chatBusy || !chatBackend || !chatInput.trim()}
              onClick={() => void sendNativeChat()}
              size="sm"
              type="button"
            >
              {chatBusy ? '执行中…' : '发送'}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-muted-foreground">
        Phase B2 已建立第一条 Zero3 原生 Chat transport：renderer 只能调用专用 chatTurn IPC，Electron 主进程负责参数校验、原生审批、Agent job 提交与结果等待。当前为非流式闭环；下一切片将加入事件流、停止生成和 Zero3 持久会话，再替换主聊天页的 Hermes compatibility transport。
      </div>`
    }
  ])
}

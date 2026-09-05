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
        `Zero3 native chat hardening drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review Phase B2 native chat before changing the pinned Hermes source or preceding overlays.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }

  fs.writeFileSync(file, source)
}

export function applyZero3NativeChatHardening() {
  patchFile('electron/main.ts', [
    {
      label: 'per-job polling instead of full job-list scans',
      from: `async function waitForZero3ChatJob(jobId: string): Promise<{ job_id: string; content: string }> {
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
}`,
      to: `async function readZero3ChatJob(jobId: string): Promise<Record<string, unknown>> {
  const response = await fetch(ZERO3_NODE_BASE + '/api/v1/jobs/' + encodeURIComponent(jobId), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(2500)
  })

  if (!response.ok) {
    throw new Error(await zero3NodeError(response))
  }

  return zero3ChatJobRecord(await response.json())
}

async function waitForZero3ChatJob(jobId: string): Promise<{ job_id: string; content: string }> {
  const deadline = Date.now() + 10 * 60 * 1000

  while (Date.now() < deadline) {
    const job = await readZero3ChatJob(jobId)
    const status = zero3ChatJobText(job.status)

    if (status === 'Succeeded') {
      return { job_id: jobId, content: zero3ChatJobContent(job) }
    }
    if (status === 'Failed') {
      throw new Error(zero3ChatJobText(job.error) ?? 'Zero3 Chat Agent job failed')
    }
    if (status === 'Cancelled') {
      throw new Error('Zero3 Chat Agent job was cancelled')
    }

    await new Promise(resolve => setTimeout(resolve, 350))
  }

  throw new Error('Zero3 Chat turn timed out after 10 minutes')
}`
    }
  ])

  patchFile('src/app/settings/zero3-control-settings.tsx', [
    {
      label: 'bounded transcript and explicit failed-message metadata',
      from: `type NativeChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const NATIVE_CHAT_STORAGE_KEY = 'zero3-native-chat-phase-b2-v1'`,
      to: `type NativeChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  failed?: boolean
}

const NATIVE_CHAT_STORAGE_KEY = 'zero3-native-chat-phase-b2-v1'
const MAX_NATIVE_CHAT_DISPLAY_CHARS = 64000
const MAX_NATIVE_CHAT_HISTORY_CHARS = 20000

function boundNativeChatContent(value: string) {
  if (value.length <= MAX_NATIVE_CHAT_DISPLAY_CHARS) return value
  const half = Math.floor(MAX_NATIVE_CHAT_DISPLAY_CHARS / 2)
  return (
    value.slice(0, half) +
    '\\n\\n[Zero3：回复过长，中间内容已截断]\\n\\n' +
    value.slice(-half)
  )
}

function nativeChatHistoryContent(value: string) {
  return value.length <= MAX_NATIVE_CHAT_HISTORY_CHARS
    ? value
    : value.slice(-MAX_NATIVE_CHAT_HISTORY_CHARS)
}`
    },
    {
      label: 'restore bounded content and failed metadata',
      from: `      .map((item, index) => ({
        id: typeof item.id === 'string' ? item.id : 'restored-' + String(index),
        role: item.role as 'user' | 'assistant',
        content: String(item.content)
      }))`,
      to: `      .map((item, index) => ({
        id: typeof item.id === 'string' ? item.id : 'restored-' + String(index),
        role: item.role as 'user' | 'assistant',
        content: boundNativeChatContent(String(item.content)),
        failed:
          item.failed === true ||
          (item.role === 'assistant' && String(item.content).startsWith('执行失败：'))
      }))`
    },
    {
      label: 'prefer Hermes as the native-chat backend',
      from: `  useEffect(() => {
    if (!agentBackend && agents.length > 0) {
      setAgentBackend(agentName(agents[0], 0))
    }
    if (!chatBackend && agents.length > 0) {
      setChatBackend(agentName(agents[0], 0))
    }
  }, [agentBackend, agents, chatBackend])`,
      to: `  useEffect(() => {
    if (agents.length === 0) return
    const names = agents.map(agentName)
    const preferred = names.find(name => name === 'hermes') ?? names[0] ?? ''
    if (!preferred) return
    if (!agentBackend) setAgentBackend(preferred)
    if (!chatBackend) setChatBackend(preferred)
  }, [agentBackend, agents, chatBackend])`
    },
    {
      label: 'exclude failed turns and bound history/output',
      from: `    const previous = chatMessages.slice(-24)
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
    } finally {`,
      to: `    const previous = chatMessages.filter(message => message.failed !== true).slice(-24)
    const userMessage: NativeChatMessage = { id: nativeChatId('user'), role: 'user', content }
    setChatMessages(current => [...current, userMessage].slice(-40))
    setChatInput('')
    setChatBusy(true)

    try {
      const result = await window.zero3Desktop.chatTurn({
        backend: chatBackend,
        message: content,
        history: previous.map(message => ({
          role: message.role,
          content: nativeChatHistoryContent(message.content)
        }))
      })
      const assistantMessage: NativeChatMessage = {
        id: nativeChatId('assistant'),
        role: 'assistant',
        content: boundNativeChatContent(result.content)
      }
      setChatMessages(current => [...current, assistantMessage].slice(-40))
      await refresh()
    } catch (nextError) {
      const assistantMessage: NativeChatMessage = {
        id: nativeChatId('assistant'),
        role: 'assistant',
        content: boundNativeChatContent(
          '执行失败：' + (nextError instanceof Error ? nextError.message : String(nextError))
        ),
        failed: true
      }
      setChatMessages(current => [...current, assistantMessage].slice(-40))
    } finally {`
    },
    {
      label: 'lock backend while a transcript is active',
      from: `                disabled={!online || chatBusy || agents.length === 0}
                onChange={event => setChatBackend(event.target.value)}`,
      to: `                disabled={!online || chatBusy || agents.length === 0 || chatMessages.length > 0}
                onChange={event => setChatBackend(event.target.value)}`
    },
    {
      label: 'explain backend lock',
      from: `              </select>
            </label>
            <Button`,
      to: `              </select>
              {chatMessages.length > 0 ? <span>清空会话后可切换 Chat Agent，避免跨 Agent 串上下文。</span> : null}
            </label>
            <Button`
    },
    {
      label: 'render failed turns distinctly',
      from: `                    message.role === 'user'
                      ? 'ml-auto max-w-[88%] rounded-lg bg-primary/10 px-3 py-2 text-sm leading-6'
                      : 'mr-auto max-w-[88%] rounded-lg bg-(--ui-bg-tertiary) px-3 py-2 text-sm leading-6'`,
      to: `                    message.role === 'user'
                      ? 'ml-auto max-w-[88%] rounded-lg bg-primary/10 px-3 py-2 text-sm leading-6'
                      : message.failed
                        ? 'mr-auto max-w-[88%] rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm leading-6 text-destructive'
                        : 'mr-auto max-w-[88%] rounded-lg bg-(--ui-bg-tertiary) px-3 py-2 text-sm leading-6'`
    },
    {
      label: 'failed-turn label',
      from: `{message.role === 'user' ? '你' : chatBackend || 'Agent'}`,
      to: `{message.role === 'user' ? '你' : message.failed ? '错误' : chatBackend || 'Agent'}`
    }
  ])
}

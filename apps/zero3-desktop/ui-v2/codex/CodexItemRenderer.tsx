import { Codicon } from '@/components/ui/codicon'
import type { Zero3SessionEvent } from '../adapters/Zero3SessionEventStore'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(raw => {
    const part = record(raw)
    return string(part.text) || string(part.content)
  }).filter(Boolean).join('\n')
}
function eventText(event: Zero3SessionEvent): string {
  return string(event.payload.text) || contentText(event.payload.content)
}
function duration(event: Zero3SessionEvent) {
  const ms = typeof event.payload.durationMs === 'number' ? event.payload.durationMs : null
  if (ms == null) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
function stateLabel(value: unknown) {
  const state = string(value)
  if (state === 'failed') return '失败'
  if (state === 'inProgress' || state === 'running') return '运行中'
  return '完成'
}
function Message({ event }: { event: Zero3SessionEvent }) {
  const user = event.type === 'userMessage'
  const value = eventText(event)
  if (!value) return null
  return (
    <div className={`flex ${user ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[82%] whitespace-pre-wrap rounded-xl px-4 py-3 text-sm leading-6 ${user ? 'bg-blue-600 text-white' : 'border border-(--ui-border) bg-(--ui-pane-background)'}`}>
        {value}
      </div>
    </div>
  )
}

function Reasoning({ event }: { event: Zero3SessionEvent }) {
  const value = eventText(event) || string(event.payload.summary)
  if (!value) return null
  const running = event.payload.phase === 'running'
  return (
    <div className="max-w-[90%] text-sm text-(--ui-text-secondary)">
      <div className="flex items-start gap-2.5">
        <span className={`mt-2 size-2 shrink-0 rounded-full ${running ? 'animate-pulse bg-blue-500' : 'bg-(--ui-text-tertiary)'}`} />
        <div className="min-w-0 whitespace-pre-wrap leading-6">{value}</div>
      </div>
    </div>
  )
}

function Command({ event }: { event: Zero3SessionEvent }) {
  const command = string(event.payload.command) || string(record(event.payload.commandAction).command)
  const output = string(event.payload.aggregatedOutput) || string(event.payload.output)
  const status = event.payload.status
  const cwd = string(event.payload.cwd)
  return (
    <details className="max-w-[92%] overflow-hidden rounded-lg border border-(--ui-border) bg-(--ui-pane-background) text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-(--ui-text-secondary)">
        <Codicon name="terminal" className="size-4 shrink-0" />
        <span className="font-medium text-(--ui-text-primary)">{stateLabel(status)}命令</span>
        {duration(event) && <span className="text-(--ui-text-tertiary)">{duration(event)}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{command || 'command'}</span>
      </summary>
      <div className="border-t border-(--ui-border) px-3 py-2">
        {cwd && <div className="mb-2 truncate text-xs text-(--ui-text-tertiary)">{cwd}</div>}
        {command && <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-5">{command}</pre>}
        {output && <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap border-t border-(--ui-border) pt-3 font-mono text-xs leading-5">{output}</pre>}
        {typeof event.payload.exitCode === 'number' && <div className="mt-2 text-xs text-(--ui-text-tertiary)">exit {event.payload.exitCode}</div>}
      </div>
    </details>
  )
}
function FileChange({ event }: { event: Zero3SessionEvent }) {
  const changes = Array.isArray(event.payload.changes) ? event.payload.changes.map(record) : []
  const paths = changes.map(change => string(change.path)).filter(Boolean)
  const diffs = changes.map(change => string(change.diff)).filter(Boolean)
  return (
    <details className="max-w-[92%] overflow-hidden rounded-lg border border-(--ui-border) bg-(--ui-pane-background) text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-(--ui-text-secondary)">
        <Codicon name="edit" className="size-4" />
        <span className="font-medium text-(--ui-text-primary)">{event.payload.phase === 'running' ? '正在编辑' : '编辑了'} {paths.length || '文件'}</span>
        <span className="min-w-0 flex-1 truncate text-xs">{paths.join(' · ')}</span>
      </summary>
      <div className="border-t border-(--ui-border) px-3 py-2">
        {paths.map(path => <div key={path} className="truncate font-mono text-xs leading-6">{path}</div>)}
        {diffs.length > 0 && <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap border-t border-(--ui-border) pt-2 font-mono text-xs leading-5">{diffs.join('\n\n')}</pre>}
      </div>
    </details>
  )
}

function Tool({ event }: { event: Zero3SessionEvent }) {
  const server = string(event.payload.server)
  const tool = string(event.payload.tool) || string(event.payload.name) || 'tool'
  const progress = string(event.payload.progress)
  return (
    <details className="max-w-[92%] rounded-lg border border-(--ui-border) bg-(--ui-pane-background) text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <Codicon name="tools" className="size-4" />
        <span className="font-medium">{stateLabel(event.payload.status)}工具</span>
        <span className="min-w-0 flex-1 truncate text-xs text-(--ui-text-secondary)">{server ? `${server} / ` : ''}{tool}</span>
      </summary>
      {progress && <div className="border-t border-(--ui-border) px-3 py-2 whitespace-pre-wrap text-xs text-(--ui-text-secondary)">{progress}</div>}
    </details>
  )
}

function ProviderSwitch({ event }: { event: Zero3SessionEvent }) {
  const to = record(event.payload.to)
  const inherited = typeof event.payload.inheritedEventCount === 'number' ? event.payload.inheritedEventCount : 0
  return (
    <div className="max-w-[92%] rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-(--ui-text-secondary)">
      已切换至 {string(to.name) || string(to.profileId) || string(to.provider) || '新的 API 服务商'}{to.model ? ` · ${string(to.model)}` : ''}；已继承共享记忆 + {inherited} 条未覆盖会话事件。
    </div>
  )
}
export function CodexItemRenderer({ event }: { event: Zero3SessionEvent }) {
  if (event.type === 'userMessage' || event.type === 'agentMessage') return <Message event={event} />
  if (event.type === 'reasoning') return <Reasoning event={event} />
  if (event.type === 'commandExecution') return <Command event={event} />
  if (event.type === 'fileChange') return <FileChange event={event} />
  if (event.type === 'mcpToolCall') return <Tool event={event} />
  if (event.type === 'providerSwitch') return <ProviderSwitch event={event} />
  if (event.type === 'turnState' && event.payload.status === 'failed') {
    return <div className="max-w-[92%] rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600">Turn 执行失败：{string(event.payload.error) || 'unknown error'}</div>
  }
  return null
}

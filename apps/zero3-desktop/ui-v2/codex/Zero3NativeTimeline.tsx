import type { Zero3SessionEvent } from '../adapters/Zero3SessionEventStore'
import { CodexItemRenderer } from './CodexItemRenderer'

export function Zero3NativeTimeline({ events }: { events: Zero3SessionEvent[] }) {
  if (!events.length) {
    return <div className="py-16 text-center text-sm text-(--ui-text-tertiary)">发送第一条消息后，Zero3 会在这里显示 Codex 原生执行时间线。</div>
  }
  return <div className="space-y-4">{events.map(event => <CodexItemRenderer key={event.eventId} event={event} />)}</div>
}

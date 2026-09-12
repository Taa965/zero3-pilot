import type { Zero3SessionEvent } from '../adapters/Zero3SessionEventStore'
import { CodexItemRenderer } from './CodexItemRenderer'

export function CodexMessageList({ events = [] }: { events?: Zero3SessionEvent[] }) {
  if (!events.length) {
    return <div className="flex-1 p-6 text-sm text-(--ui-text-tertiary)">暂无 Codex 原生事件。</div>
  }
  return <div className="flex-1 overflow-y-auto p-4 space-y-4">{events.map(event => <CodexItemRenderer key={event.eventId} event={event} />)}</div>
}

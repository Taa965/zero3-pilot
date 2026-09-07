import { useMemo, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import type { WebSession } from '../adapters/WebWorkspaceAdapter'

interface UnifiedSessionListProps {
  sessions: WebSession[]
  activeId: string | null
  onSelect: (session: WebSession) => void
  onCreateGpt: () => void
  error: string | null
}

const PROVIDER_MARKS = {
  codex: { symbol: '⌘', color: 'text-green-500' },
  gpt: { symbol: '◎', color: 'text-blue-500' },
  gemini: { symbol: '✦', color: 'text-violet-500' }
} as const

export function UnifiedSessionList({ sessions, activeId, onSelect, onCreateGpt, error }: UnifiedSessionListProps) {
  const [filter, setFilter] = useState<'all' | 'codex' | 'gpt' | 'gemini'>('all')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions.filter(session => {
      if (filter !== 'all' && session.provider !== filter) return false
      if (!needle) return true
      return session.title.toLowerCase().includes(needle) || session.subtitle.toLowerCase().includes(needle)
    })
  }, [sessions, filter, query])

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Codicon name="search" className="absolute left-2 top-1.5 size-4 text-(--ui-text-tertiary)" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索会话"
              className="w-full rounded-md border border-(--ui-border) bg-(--ui-control-background) py-1 pl-8 pr-2 text-sm text-foreground outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={onCreateGpt}
            title="新建 GPT 网页会话"
            className="flex size-7 items-center justify-center rounded-md border border-(--ui-border) hover:bg-(--ui-control-hover-background)"
          >
            <Codicon name="plus" className="size-4" />
          </button>
        </div>
        <div className="flex gap-1 text-xs text-(--ui-text-secondary)">
          {(['all', 'codex', 'gpt', 'gemini'] as const).map(value => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-md px-2 py-1 hover:bg-(--ui-control-hover-background)',
                filter === value && 'bg-(--ui-control-active-background) font-medium text-foreground'
              )}
            >
              {value === 'all' ? '全部' : value === 'codex' ? 'Codex' : value === 'gpt' ? 'GPT' : 'Gemini'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {error && <div className="px-2 py-3 text-xs text-red-600">{error}</div>}

        {filtered.map(session => {
          const active = session.id === activeId
          const mark = PROVIDER_MARKS[session.provider]
          return (
            <button
              key={session.id}
              onClick={() => onSelect(session)}
              className={cn(
                'mb-1 flex w-full flex-col items-start gap-1 rounded-lg border border-transparent p-3 text-left text-sm transition-colors',
                active
                  ? 'border-(--ui-border) bg-(--ui-control-active-background)'
                  : 'hover:bg-(--ui-control-hover-background)'
              )}
            >
              <div className="flex w-full items-center justify-between">
                <div className="flex min-w-0 items-center gap-1.5 font-medium">
                  <span className={cn('text-xs', mark.color)}>{mark.symbol}</span>
                  <span className="truncate">{session.title}</span>
                </div>
                <span className="shrink-0 pl-2 text-xs text-(--ui-text-tertiary)">{session.updatedAt}</span>
              </div>
              <div className="w-full truncate text-xs text-(--ui-text-secondary)">{session.subtitle}</div>
            </button>
          )
        })}

        {!error && filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-(--ui-text-tertiary)">
            {filter === 'codex' ? (
              // Codex threads come from the app-server, not the workspace store,
              // and that path is not wired into this list yet.
              <>Codex 会话尚未接入此列表</>
            ) : sessions.length === 0 ? (
              <>还没有会话，点击 ＋ 新建 GPT 网页会话</>
            ) : (
              <>没有匹配的会话</>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

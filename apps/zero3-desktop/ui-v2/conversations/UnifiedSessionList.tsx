import { useMemo, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import type { WebSession } from '../adapters/WebWorkspaceAdapter'

interface UnifiedSessionListProps {
  sessions: WebSession[]
  activeId: string | null
  activeProjectId: string | null
  projects: Zero3ProjectRecord[]
  onSelect: (session: WebSession) => void
  onCreateGpt: () => void
  error: string | null
}

const PROVIDER_MARKS = {
  codex: { symbol: '⌘', color: 'text-green-500' },
  gpt: { symbol: '◎', color: 'text-blue-500' },
  gemini: { symbol: '✦', color: 'text-violet-500' }
} as const

export function UnifiedSessionList({
  sessions,
  activeId,
  activeProjectId,
  projects,
  onSelect,
  onCreateGpt,
  error
}: UnifiedSessionListProps) {
  const [filter, setFilter] = useState<'all' | 'codex' | 'gpt' | 'gemini'>('all')
  const [query, setQuery] = useState('')

  const projectSessions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (session: WebSession) => {
      if (filter !== 'all' && session.provider !== filter) return false
      if (!needle) return true
      return session.title.toLowerCase().includes(needle) || session.subtitle.toLowerCase().includes(needle)
    }
    return sessions.filter(
      session => (activeProjectId === null || session.projectId === activeProjectId) && matches(session)
    )
  }, [sessions, activeProjectId, filter, query])

  const renderSession = (session: WebSession) => {
    const active = session.id === activeId
    const mark = PROVIDER_MARKS[session.provider]
    // Only in the unscoped view: inside a project every row would repeat the
    // same name, and the switcher above already says which project that is.
    const ownerLabel =
      activeProjectId !== null
        ? null
        : (projects.find(project => project.id === session.projectId)?.name ?? '未归属')
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
        <div className="flex w-full items-center gap-1.5 text-xs text-(--ui-text-secondary)">
          {ownerLabel && (
            <span className="shrink-0 rounded bg-(--ui-control-background) px-1.5 py-0.5 text-(--ui-text-tertiary)">
              {ownerLabel}
            </span>
          )}
          <span className="truncate">{session.subtitle}</span>
        </div>
      </button>
    )
  }

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
            title={activeProjectId ? '在当前项目中新建 GPT 网页会话' : '新建未归属 GPT 网页会话'}
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

        {projectSessions.map(renderSession)}

        {!error && projectSessions.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-(--ui-text-tertiary)">
            {filter === 'codex' ? (
              <>Codex 会话尚未接入此列表</>
            ) : sessions.length === 0 ? (
              <>还没有会话，点击 ＋ 新建 GPT 网页会话</>
            ) : activeProjectId ? (
              <>当前项目没有匹配的会话</>
            ) : (
              <>没有匹配的会话</>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

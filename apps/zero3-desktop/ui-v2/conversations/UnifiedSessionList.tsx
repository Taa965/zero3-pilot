import { useEffect, useMemo, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import type { WorkspaceProvider, WorkspaceSession } from './session-types'

interface UnifiedSessionListProps {
  sessions: WorkspaceSession[]
  activeId: string | null
  activeProjectId: string | null
  focusedProjectId: string | null
  projects: Zero3ProjectRecord[]
  onSelect: (session: WorkspaceSession) => void
  onSelectProjectContext: (projectId: string | null) => void
  onCreate: () => void
  onDelete: (session: WorkspaceSession) => void
  onArchive: (session: WorkspaceSession, archived: boolean) => void
  onRename: (session: WorkspaceSession) => void
  error: string | null
}

const CONTEXT_MENU_WIDTH = 184
const CONTEXT_MENU_HEIGHT = 152
const GPT_PREWARM_DELAY_MS = 150
type SessionFilter = 'all' | 'archived' | WorkspaceProvider
const FILTERS: SessionFilter[] = ['all', 'gpt', 'gemini', 'codex', 'claude', 'antigravity', 'zero3', 'archived']

const PROVIDER_MARKS: Record<WorkspaceProvider, { symbol: string; color: string; label: string }> = {
  gpt: { symbol: '◎', color: 'text-blue-500', label: 'GPT' },
  gemini: { symbol: '✦', color: 'text-violet-500', label: 'Gemini' },
  codex: { symbol: '⌘', color: 'text-green-500', label: 'Codex' },
  claude: { symbol: 'C', color: 'text-orange-500', label: 'Claude' },
  antigravity: { symbol: 'A', color: 'text-fuchsia-500', label: 'Antigravity' },
  zero3: { symbol: 'Z', color: 'text-blue-600', label: 'Zero3' }
}

export function UnifiedSessionList({
  sessions,
  activeId,
  activeProjectId,
  focusedProjectId,
  projects,
  onSelect,
  onSelectProjectContext,
  onCreate,
  onDelete,
  onArchive,
  onRename,
  error
}: UnifiedSessionListProps) {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ session: WorkspaceSession; x: number; y: number } | null>(null)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const paneRef = useRef<HTMLDivElement>(null)
  const prewarmTimersRef = useRef(new Map<string, number>())

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  useEffect(() => {
    return () => {
      for (const timer of prewarmTimersRef.current.values()) window.clearTimeout(timer)
      prewarmTimersRef.current.clear()
    }
  }, [])

  const cancelPrewarm = (id: string) => {
    const timer = prewarmTimersRef.current.get(id)
    if (timer == null) return
    window.clearTimeout(timer)
    prewarmTimersRef.current.delete(id)
  }

  const queuePrewarm = (session: WorkspaceSession) => {
    if (session.archived || session.provider !== 'gpt' || session.source !== 'web' || session.id === activeId) return
    cancelPrewarm(session.id)
    const timer = window.setTimeout(() => {
      prewarmTimersRef.current.delete(session.id)
      void window.zero3GptWeb.warm({ id: session.id }).catch(() => {})
    }, GPT_PREWARM_DELAY_MS)
    prewarmTimersRef.current.set(session.id, timer)
  }

  const openMenu = (session: WorkspaceSession, event: React.MouseEvent) => {
    event.preventDefault()
    const bounds = paneRef.current?.getBoundingClientRect()
    const maxX = bounds ? bounds.right - CONTEXT_MENU_WIDTH - 4 : event.clientX
    const minX = bounds ? bounds.left + 4 : 4
    setMenu({
      session,
      x: Math.max(minX, Math.min(event.clientX, maxX)),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - 4)
    })
  }

  const projectSessions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions.filter(session => {
      if (activeProjectId !== null && session.projectId !== activeProjectId) return false
      if (filter === 'archived') {
        if (!session.archived) return false
      } else {
        if (session.archived) return false
        if (filter !== 'all' && session.provider !== filter) return false
      }
      if (!needle) return true
      return session.title.toLowerCase().includes(needle) || session.subtitle.toLowerCase().includes(needle)
    })
  }, [sessions, activeProjectId, filter, query])

  const projectGroups = useMemo(() => {
    const names = new Map(projects.map(project => [project.id, project.name]))
    const groups = new Map<string, { key: string; projectId: string | null; name: string; sessions: WorkspaceSession[] }>()
    for (const session of projectSessions) {
      const key = session.projectId ?? '__unassigned__'
      const existing = groups.get(key)
      if (existing) existing.sessions.push(session)
      else groups.set(key, { key, projectId: session.projectId, name: session.projectId ? (names.get(session.projectId) ?? '未知项目') : '未归属项目', sessions: [session] })
    }
    return [...groups.values()]
  }, [projectSessions, projects])

  const toggleProjectGroup = (key: string) => {
    setCollapsedProjectIds(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderSession = (session: WorkspaceSession) => {
    const active = session.id === activeId
    const archived = session.archived === true
    const executing = session.executing === true
    const completionUnread = session.completionUnread === true
    const health = session.executionHealth ?? (executing ? 'active' : null)
    const idle = health === 'idle'
    const stalled = health === 'stalled'
    const timeoutError = health === 'timeout_error'
    const connectionLost = health === 'connection_lost'
    const recovering = health === 'recovering'
    const recoveryFailed = health === 'recovery_failed'
    const rotating = health === 'rotating'
    const rotationFailed = health === 'rotation_failed'
    const attentionRing = executing || completionUnread || timeoutError || connectionLost || recovering || recoveryFailed || rotating || rotationFailed
    const mark = PROVIDER_MARKS[session.provider]
    return (
      <button
        key={session.id}
        onClick={() => {
          cancelPrewarm(session.id)
          if (!archived) onSelect(session)
        }}
        onMouseEnter={() => queuePrewarm(session)}
        onMouseLeave={() => cancelPrewarm(session.id)}
        onFocus={() => queuePrewarm(session)}
        onBlur={() => cancelPrewarm(session.id)}
        onContextMenu={event => openMenu(session, event)}
        data-session-executing={executing ? '' : undefined}
        data-session-health={health ?? undefined}
        data-session-completion-unread={completionUnread ? '' : undefined}
        className={cn(
          'mb-1 flex w-full flex-col items-start gap-1 rounded-lg border border-transparent p-3 text-left text-sm transition-colors',
          active ? 'border-(--ui-border) bg-(--ui-control-active-background)' : 'hover:bg-(--ui-control-hover-background)'
        )}
      >
        <div className="flex w-full items-center justify-between">
          <div className="flex min-w-0 items-center gap-1.5 font-medium">
            <span
              className="relative grid size-4 shrink-0 place-items-center"
              title={rotationFailed ? '新会话接管失败，需要人工处理' : rotating ? '旧会话锁死，正在切换新的 GPT 会话' : recoveryFailed ? '自动恢复失败，准备切换新会话' : recovering ? '检测到会话故障，正在自动继续（1/1）' : connectionLost ? 'ChatGPT 连接已中断，正在确认是否需要重开会话' : timeoutError ? '检测到消息发送超时，准备自动恢复' : stalled ? '疑似卡住：已超过 5 分钟没有可见进展' : idle ? '执行中：已超过 90 秒没有可见进展' : executing ? '正在执行' : completionUnread ? '执行完成，尚未查看' : undefined}
            >
              {attentionRing && (
                <span className={cn(
                  'pointer-events-none absolute inset-[-2px] rounded-full border',
                  rotationFailed || recoveryFailed || timeoutError || connectionLost || stalled ? 'border-red-500' : rotating || recovering || idle ? 'border-amber-500' : 'border-emerald-500'
                )} />
              )}
              {executing && health === 'active' && (
                <span className="pointer-events-none absolute inset-[-2px] rounded-full border border-emerald-400/80 motion-safe:animate-ping" />
              )}
              {idle && (
                <span className="pointer-events-none absolute inset-[-2px] rounded-full border border-amber-400/80 motion-safe:animate-pulse" />
              )}
              {stalled && (
                <span className="pointer-events-none absolute inset-[-3px] rounded-full border border-red-400/80 motion-safe:animate-pulse" />
              )}
              {timeoutError && (
                <span className="pointer-events-none absolute inset-[-3px] rounded-full border border-red-400/80 motion-safe:animate-pulse" />
              )}
              {connectionLost && (
                <span className="pointer-events-none absolute inset-[-3px] rounded-full border border-red-400/80 motion-safe:animate-pulse" />
              )}
              {recovering && (
                <span className="pointer-events-none absolute inset-[-3px] rounded-full border border-amber-400/80 motion-safe:animate-pulse" />
              )}
              {rotating && (
                <span className="pointer-events-none absolute inset-[-3px] rounded-full border border-amber-400/80 motion-safe:animate-pulse" />
              )}
              {completionUnread && !executing && health === null && (
                <span className="pointer-events-none absolute -right-1 -top-1 z-20 size-2 rounded-full bg-red-500" />
              )}
              <span className={cn('relative z-10 text-xs', mark.color)}>{mark.symbol}</span>
            </span>
            <span className="truncate">{session.title}</span>
            {idle && <span className="shrink-0 rounded bg-amber-500/10 px-1 text-[10px] font-normal text-amber-600">等待进展</span>}
            {stalled && <span className="shrink-0 rounded bg-red-500/10 px-1 text-[10px] font-normal text-red-600">疑似卡住</span>}
            {timeoutError && <span className="shrink-0 rounded bg-red-500/10 px-1 text-[10px] font-normal text-red-600">发送超时</span>}
            {connectionLost && <span className="shrink-0 rounded bg-red-500/10 px-1 text-[10px] font-normal text-red-600">连接中断</span>}
            {recovering && <span className="shrink-0 rounded bg-amber-500/10 px-1 text-[10px] font-normal text-amber-600">自动恢复 1/1</span>}
            {recoveryFailed && <span className="shrink-0 rounded bg-red-500/10 px-1 text-[10px] font-normal text-red-600">准备换会话</span>}
            {rotating && <span className="shrink-0 rounded bg-amber-500/10 px-1 text-[10px] font-normal text-amber-600">切换新会话</span>}
            {rotationFailed && <span className="shrink-0 rounded bg-red-500/10 px-1 text-[10px] font-normal text-red-600">换会话失败</span>}
            {archived && <Codicon name="archive" className="size-3.5 shrink-0 text-(--ui-text-tertiary)" />}
          </div>
          <span className="shrink-0 pl-2 text-xs text-(--ui-text-tertiary)">{session.updatedAt}</span>
        </div>
        <div className="flex w-full items-center gap-1.5 text-xs text-(--ui-text-secondary)">
          <span className="truncate">{session.subtitle}</span>
        </div>
      </button>
    )
  }

  return (
    <div ref={paneRef} className="flex h-full flex-col">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Codicon name="search" className="absolute left-2 top-1.5 size-4 text-(--ui-text-tertiary)" />
            <input
              value={query}
              onChange={event => {
                setMenu(null)
                setQuery(event.target.value)
              }}
              placeholder="搜索会话"
              className="w-full rounded-md border border-(--ui-border) bg-(--ui-control-background) py-1 pl-8 pr-2 text-sm text-foreground outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={onCreate}
            title="新建会话并选择运行平台"
            className="flex size-7 items-center justify-center rounded-md border border-(--ui-border) hover:bg-(--ui-control-hover-background)"
          >
            <Codicon name="plus" className="size-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-1 text-xs text-(--ui-text-secondary)">
          {FILTERS.map(value => (
            <button
              key={value}
              onClick={() => {
                setMenu(null)
                setFilter(value)
              }}
              className={cn(
                'rounded-md px-2 py-1 hover:bg-(--ui-control-hover-background)',
                filter === value && 'bg-(--ui-control-active-background) font-medium text-foreground'
              )}
            >
              {value === 'all' ? '\u5168\u90e8' : value === 'archived' ? '\u5f52\u6863' : PROVIDER_MARKS[value].label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {error && <div className="px-2 py-3 text-xs text-red-600">{error}</div>}
        {activeProjectId === null
          ? projectGroups.map(group => {
              const collapsed = collapsedProjectIds.has(group.key)
              return (
                <section key={group.key} data-project-group={group.key} className="mb-2">
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => {
                      onSelectProjectContext(group.projectId)
                      toggleProjectGroup(group.key)
                    }}
                    className={cn(
                      'mb-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                      focusedProjectId !== null && group.projectId === focusedProjectId && 'bg-(--ui-control-active-background) text-foreground'
                    )}
                  >
                    <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{group.name}</span>
                    <span className="shrink-0 text-[11px] font-normal text-(--ui-text-tertiary)">{group.sessions.length}</span>
                  </button>
                  {!collapsed && <div>{group.sessions.map(renderSession)}</div>}
                </section>
              )
            })
          : projectSessions.map(renderSession)}

        {!error && projectSessions.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-(--ui-text-tertiary)">
            {sessions.length === 0 ? '还没有会话，点击 ＋ 选择平台创建' : '没有匹配的会话'}
          </div>
        )}
      </div>

      {menu && (
        <div
          role="menu"
          style={{ left: menu.x, top: menu.y, width: CONTEXT_MENU_WIDTH }}
          onMouseDown={event => event.stopPropagation()}
          className="fixed z-50 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-1 shadow-lg"
        >
          <button
            role="menuitem"
            onClick={() => {
              const target = menu.session
              setMenu(null)
              onRename(target)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-(--ui-control-hover-background)"
          >
            <Codicon name="edit" className="size-4" />
            修改名称
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const target = menu.session
              setMenu(null)
              onArchive(target, !target.archived)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-(--ui-control-hover-background)"
          >
            <Codicon name="archive" className="size-4" />
            {menu.session.archived ? '\u53d6\u6d88\u5f52\u6863' : '\u5f52\u6863\u4f1a\u8bdd'}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const target = menu.session
              setMenu(null)
              onDelete(target)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-red-600 hover:bg-(--ui-control-hover-background)"
          >
            <Codicon name="trash" className="size-4" />
            删除会话
          </button>
          <div className="px-2 pb-1 pt-0.5 text-[11px] leading-tight text-(--ui-text-tertiary)">
            {'\u5f52\u6863\u4f1a\u540c\u6b65\u5230\u652f\u6301\u539f\u751f\u5f52\u6863\u7684\u5e73\u53f0'}
          </div>
        </div>
      )}
    </div>
  )
}

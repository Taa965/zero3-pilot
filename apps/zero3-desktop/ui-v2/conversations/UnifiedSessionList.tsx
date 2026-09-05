import { useState } from 'react'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

export type SessionEntry = {
  id: string
  title: string
  subtitle: string
  provider: 'codex' | 'gpt' | 'gemini'
  updatedAt: string
  status?: string
}

const mockSessions: SessionEntry[] = [
  { id: '1', title: 'UI 重构方案', subtitle: 'Zero3 Pilot · UI2.0', provider: 'gpt', updatedAt: '17:28', status: '待审核' },
  { id: '2', title: '实现 Workspace Router', subtitle: 'Zero3 Pilot · ui-v2', provider: 'codex', updatedAt: '16:45', status: '执行中' },
  { id: '3', title: 'Gemini UI 设计研究', subtitle: 'UI2-GEMINI-01', provider: 'gemini', updatedAt: '昨天', status: '' },
]

export function UnifiedSessionList() {
  const [activeId, setActiveId] = useState('1')
  const [filter, setFilter] = useState<'all' | 'codex' | 'gpt' | 'gemini'>('all')

  const filtered = filter === 'all' ? mockSessions : mockSessions.filter(s => s.provider === filter)

  const providerIcon = (provider: string) => {
    switch (provider) {
      case 'codex': return { icon: 'terminal', color: 'text-green-500', symbol: '⌘' }
      case 'gpt': return { icon: 'globe', color: 'text-blue-500', symbol: '◎' }
      case 'gemini': return { icon: 'sparkle', color: 'text-violet-500', symbol: '✦' }
      default: return { icon: 'comment', color: 'text-gray-500', symbol: '' }
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Codicon name="search" className="absolute left-2 top-1.5 size-4 text-(--ui-text-tertiary)" />
            <input 
              placeholder="搜索会话" 
              className="w-full rounded-md border border-(--ui-border) bg-(--ui-control-background) py-1 pl-8 pr-2 text-sm text-foreground outline-none focus:border-blue-500"
            />
          </div>
          <button className="flex size-7 items-center justify-center rounded-md border border-(--ui-border) hover:bg-(--ui-control-hover-background)">
            <Codicon name="plus" className="size-4" />
          </button>
        </div>
        <div className="flex gap-1 text-xs text-(--ui-text-secondary)">
          {(['all', 'codex', 'gpt', 'gemini'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md px-2 py-1 hover:bg-(--ui-control-hover-background)',
                filter === f && 'bg-(--ui-control-active-background) text-foreground font-medium'
              )}
            >
              {f === 'all' ? '全部' : f === 'codex' ? 'Codex' : f === 'gpt' ? 'GPT' : 'Gemini'}
            </button>
          ))}
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {filtered.map(session => {
          const active = session.id === activeId
          const prov = providerIcon(session.provider)
          return (
            <button
              key={session.id}
              onClick={() => setActiveId(session.id)}
              className={cn(
                'mb-1 flex w-full flex-col items-start gap-1 rounded-lg border border-transparent p-3 text-left text-sm transition-colors',
                active 
                  ? 'border-(--ui-border) bg-(--ui-control-active-background)' 
                  : 'hover:bg-(--ui-control-hover-background)'
              )}
            >
              <div className="flex w-full items-center justify-between">
                <div className="flex items-center gap-1.5 font-medium">
                  <span className={cn("text-xs", prov.color)}>{prov.symbol}</span>
                  <span className="truncate">{session.title}</span>
                </div>
                <span className="shrink-0 text-xs text-(--ui-text-tertiary)">{session.updatedAt}</span>
              </div>
              <div className="text-xs text-(--ui-text-secondary) truncate w-full">{session.subtitle}</div>
              {session.status && (
                <div className="flex items-center gap-1.5 mt-1 text-xs">
                  <span className="size-1.5 rounded-full bg-blue-500"></span>
                  <span className="text-(--ui-text-tertiary)">{session.status}</span>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

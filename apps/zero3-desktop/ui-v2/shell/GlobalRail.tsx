import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

type ModuleType = 'conversations' | 'tasks' | 'groups' | 'projects' | 'skills' | 'runtime'

interface GlobalRailProps {
  activeModule: ModuleType
  onModuleChange: (mod: ModuleType) => void
}

export function GlobalRail({ activeModule, onModuleChange }: GlobalRailProps) {
  const navItems = [
    { id: 'conversations', icon: 'comment-discussion', label: '工作台' },
    { id: 'tasks', icon: 'check', label: '任务看板' },
    { id: 'groups', icon: 'organization', label: '开发组' },
    { id: 'projects', icon: 'repo', label: '项目' },
    { id: 'skills', icon: 'extensions', label: 'Skills' },
    { id: 'runtime', icon: 'server-environment', label: '运行中心' },
  ] as const

  return (
    <div className="flex w-16 shrink-0 flex-col items-center border-r border-(--ui-border) bg-(--ui-rail-background) py-4">
      {/* Profile / Zero3 Logo */}
      <button className="mb-6 flex size-10 items-center justify-center rounded-full bg-blue-600 text-white">
        Z
      </button>

      {/* Main Navigation */}
      <nav className="flex flex-1 flex-col items-center gap-4">
        {navItems.map((item) => (
          <button
            key={item.id}
            title={item.label}
            onClick={() => onModuleChange(item.id)}
            className={cn(
              'flex size-10 items-center justify-center rounded-xl transition-colors',
              activeModule === item.id 
                ? 'bg-(--ui-control-active-background) text-foreground' 
                : 'text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground'
            )}
          >
            <Codicon name={item.icon} className="size-6" />
          </button>
        ))}
      </nav>

      {/* Bottom Actions */}
      <div className="flex flex-col items-center gap-4 mt-auto">
        <button title="待处理" className="relative flex size-10 items-center justify-center rounded-xl text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground">
          <Codicon name="bell" className="size-6" />
          <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">1</span>
        </button>
        <button title="设置" className="flex size-10 items-center justify-center rounded-xl text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground">
          <Codicon name="settings-gear" className="size-6" />
        </button>
      </div>
    </div>
  )
}

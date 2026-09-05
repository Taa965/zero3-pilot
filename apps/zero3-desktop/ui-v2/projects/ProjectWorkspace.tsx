import { useState } from 'react'

export function ProjectWorkspace() {
  const [activeTab, setActiveTab] = useState('overview')

  const tabs = [
    { id: 'overview', label: '总览' },
    { id: 'files', label: '文件' },
    { id: 'git', label: 'Git' },
    { id: 'worktrees', label: '工作区' },
    { id: 'context', label: '上下文' },
    { id: 'tasks', label: '任务' },
    { id: 'artifacts', label: '产物' },
  ]

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-14 shrink-0 flex-col justify-center border-b border-(--ui-border) px-6">
        <div className="flex items-center gap-3">
          <div className="font-medium text-lg">Zero3 Pilot</div>
          <div className="text-xs text-(--ui-text-tertiary)">c:/Users/aaaa/Documents/zero3-pilot</div>
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-6 border-b border-(--ui-border) px-6 text-sm font-medium overflow-x-auto">
        {tabs.map(t => (
          <button 
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`h-full border-b-2 transition-colors whitespace-nowrap ${activeTab === t.id ? 'border-blue-500 text-foreground' : 'border-transparent text-(--ui-text-secondary) hover:border-(--ui-border) hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-6 bg-(--ui-pane-background)">
        {activeTab === 'overview' && (
          <div className="text-sm text-(--ui-text-secondary)">
             项目总览视图建设中...
          </div>
        )}
        {activeTab === 'files' && (
          <div className="text-sm text-(--ui-text-secondary)">
             文件树视图建设中...
          </div>
        )}
      </div>
    </div>
  )
}

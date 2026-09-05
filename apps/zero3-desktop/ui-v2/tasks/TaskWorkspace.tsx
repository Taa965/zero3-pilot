import { useState } from 'react'

export function TaskWorkspace() {
  const [activeTab, setActiveTab] = useState('review')

  const tabs = [
    { id: 'overview', label: '总览' },
    { id: 'execution', label: '执行过程' },
    { id: 'changes', label: '代码变更' },
    { id: 'artifacts', label: '产物' },
    { id: 'verification', label: '验证' },
    { id: 'review', label: '审核' },
    { id: 'timeline', label: '时间轴' },
  ]

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-14 shrink-0 flex-col justify-center border-b border-(--ui-border) px-6">
        <div className="flex items-center gap-3">
          <div className="font-medium">UI2-GEMINI-001</div>
          <div className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-500">
            ✦ Gemini
          </div>
          <div className="text-xs text-(--ui-text-tertiary)">审核轮次 2 / 5</div>
          <div className="text-xs font-medium text-blue-500 ml-auto px-2 py-0.5 border border-blue-500/30 rounded bg-blue-500/10">运行中</div>
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-6 border-b border-(--ui-border) px-6 text-sm font-medium">
        {tabs.map(t => (
          <button 
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`h-full border-b-2 transition-colors ${activeTab === t.id ? 'border-blue-500 text-foreground' : 'border-transparent text-(--ui-text-secondary) hover:border-(--ui-border) hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {activeTab === 'review' ? (
          <div className="flex h-full">
            <div className="w-1/3 border-r border-(--ui-border) p-4 overflow-y-auto">
              <div className="text-sm font-medium mb-2">初始目标</div>
              <div className="text-xs text-(--ui-text-secondary) mb-6">重新设计 Zero3 UI...</div>
              <div className="text-sm font-medium mb-2">变更文件</div>
              <div className="text-xs font-mono text-(--ui-text-secondary)">M apps/zero3-desktop/ui-v2/shell/Zero3AppShell.tsx</div>
            </div>
            <div className="w-1/3 border-r border-(--ui-border) p-4 overflow-y-auto bg-(--ui-pane-background)">
              <div className="text-sm font-medium mb-2">差异与产物</div>
              <div className="text-xs text-(--ui-text-tertiary) italic">Diff 视图...</div>
            </div>
            <div className="w-1/3 p-4 overflow-y-auto">
              <div className="text-sm font-medium mb-2">验证结果</div>
              <div className="text-xs text-green-500 mb-6 flex gap-2">✓ npm typecheck</div>
              <div className="text-sm font-medium mb-2">阻塞项</div>
              <div className="text-xs text-(--ui-text-tertiary) mb-6">无</div>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-(--ui-text-tertiary)">
            {activeTab} 视图建设中...
          </div>
        )}
      </div>
      {activeTab === 'review' && (
        <div className="flex h-14 shrink-0 items-center gap-3 border-t border-(--ui-border) px-6 bg-(--ui-control-background)">
          <button className="rounded bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700">通过</button>
          <button className="rounded bg-amber-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-600">要求修改</button>
          <button className="rounded border border-(--ui-border) px-4 py-1.5 text-sm font-medium hover:bg-(--ui-control-hover-background)">标记阻塞</button>
          <button className="rounded border border-(--ui-border) px-4 py-1.5 text-sm font-medium hover:bg-(--ui-control-hover-background)">转人工</button>
        </div>
      )}
    </div>
  )
}

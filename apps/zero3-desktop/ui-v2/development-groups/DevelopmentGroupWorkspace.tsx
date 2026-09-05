import { useState } from 'react'

export function DevelopmentGroupWorkspace() {
  const [activeTab, setActiveTab] = useState('overview')

  const tabs = [
    { id: 'overview', label: '总览' },
    { id: 'requirements', label: '需求' },
    { id: 'sessions', label: '会话' },
    { id: 'waves', label: '波次' },
    { id: 'integration', label: '集成' },
    { id: 'verification', label: '验证' },
    { id: 'activity', label: '活动' },
  ]

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-20 shrink-0 flex-col justify-center border-b border-(--ui-border) px-6 gap-2">
        <div className="flex items-center gap-3">
          <div className="font-medium text-lg">Zero3 UI 2.0</div>
          <div className="text-xs text-(--ui-text-tertiary)">代码库: zero3-pilot</div>
          <div className="text-xs text-(--ui-text-tertiary)">当前波次: Wave 3</div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 w-48">
             <span className="text-(--ui-text-secondary)">进度:</span>
             <div className="h-1.5 flex-1 bg-(--ui-border) rounded-full overflow-hidden">
               <div className="h-full bg-green-500 w-[72%]"></div>
             </div>
             <span>72%</span>
          </div>
          <div className="text-amber-500 flex items-center gap-1">
             ⚠ 1 项需注意
          </div>
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
      <div className="flex-1 overflow-y-auto p-6 bg-(--ui-pane-background)">
        {activeTab === 'overview' && (
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-background border border-(--ui-border) rounded-lg p-4">
              <div className="text-sm text-(--ui-text-secondary) mb-1">需求完成度</div>
              <div className="text-2xl font-medium">6 / 9 <span className="text-sm font-normal text-(--ui-text-tertiary)">已验证</span></div>
            </div>
            <div className="bg-background border border-(--ui-border) rounded-lg p-4">
              <div className="text-sm text-(--ui-text-secondary) mb-1">活跃会话</div>
              <div className="text-2xl font-medium">4 <span className="text-sm font-normal text-(--ui-text-tertiary)">运行中</span></div>
            </div>
            <div className="bg-background border border-(--ui-border) rounded-lg p-4">
              <div className="text-sm text-(--ui-text-secondary) mb-1">当前波次</div>
              <div className="text-2xl font-medium">Wave 3</div>
            </div>
            <div className="bg-background border border-amber-500/50 rounded-lg p-4">
              <div className="text-sm text-amber-600 mb-1">需关注</div>
              <div className="text-2xl font-medium text-amber-600">1</div>
            </div>
          </div>
        )}
        {activeTab === 'requirements' && (
           <table className="w-full text-sm text-left border-collapse">
             <thead>
               <tr className="border-b border-(--ui-border) text-(--ui-text-secondary)">
                 <th className="font-medium pb-2">需求名称</th>
                 <th className="font-medium pb-2 w-32">负责人</th>
                 <th className="font-medium pb-2 w-24">状态</th>
               </tr>
             </thead>
             <tbody>
               <tr className="border-b border-(--ui-border) hover:bg-(--ui-control-hover-background)">
                 <td className="py-3">三栏基础框架</td>
                 <td className="text-(--ui-text-secondary)">UI-01</td>
                 <td className="text-green-500">✓ 已验证</td>
               </tr>
               <tr className="border-b border-(--ui-border) hover:bg-(--ui-control-hover-background)">
                 <td className="py-3">统一会话列表</td>
                 <td className="text-(--ui-text-secondary)">UI-02</td>
                 <td className="text-green-500">✓ 已验证</td>
               </tr>
               <tr className="border-b border-(--ui-border) hover:bg-(--ui-control-hover-background)">
                 <td className="py-3">Gemini 视图</td>
                 <td className="text-(--ui-text-secondary)">UI-03</td>
                 <td className="text-blue-500">● 运行中</td>
               </tr>
               <tr className="border-b border-(--ui-border) hover:bg-(--ui-control-hover-background)">
                 <td className="py-3">任务中心</td>
                 <td className="text-(--ui-text-secondary)">UI-04</td>
                 <td className="text-(--ui-text-tertiary)">○ 计划中</td>
               </tr>
               <tr className="border-b border-(--ui-border) hover:bg-(--ui-control-hover-background)">
                 <td className="py-3">监控中心</td>
                 <td className="text-(--ui-text-secondary)">UI-05</td>
                 <td className="text-amber-500">⚠ 阻塞中</td>
               </tr>
             </tbody>
           </table>
        )}
      </div>
    </div>
  )
}

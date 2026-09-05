import { Codicon } from '@/components/ui/codicon'

export function GeminiWorkspaceSurface() {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-4 border-b border-(--ui-border) px-4 text-sm font-medium text-(--ui-text-secondary)">
        <button className="h-full border-b-2 border-transparent hover:border-(--ui-border) hover:text-foreground">网页对话</button>
        <button className="h-full border-b-2 border-violet-500 text-foreground">Agent 运行</button>
        <button className="h-full border-b-2 border-transparent hover:border-(--ui-border) hover:text-foreground">产物</button>
        <button className="h-full border-b-2 border-transparent hover:border-(--ui-border) hover:text-foreground">Diff</button>
        <button className="h-full border-b-2 border-transparent hover:border-(--ui-border) hover:text-foreground">审核</button>
      </div>
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="mb-6 rounded-lg border border-(--ui-border) bg-(--ui-pane-background) p-4 text-sm">
          <div className="mb-4 font-medium flex items-center gap-2">
            <Codicon name="server-environment" className="text-violet-500" />
            Antigravity Runtime
          </div>
          <div className="grid grid-cols-2 gap-y-2">
            <div className="text-(--ui-text-tertiary)">状态</div>
            <div className="text-green-500">就绪 (READY)</div>
            <div className="text-(--ui-text-tertiary)">授权</div>
            <div className="text-foreground">已授权 (AUTHENTICATED)</div>
            <div className="text-(--ui-text-tertiary)">任务</div>
            <div className="text-foreground">UI2-GEMINI-01</div>
          </div>
        </div>
        
        <div className="text-sm font-medium mb-3">运行时事件</div>
        <div className="flex flex-col gap-2 text-xs font-mono text-(--ui-text-secondary)">
          <div className="flex gap-4"><span className="text-(--ui-text-tertiary)">18:10</span> <span>task.started</span></div>
          <div className="flex gap-4"><span className="text-(--ui-text-tertiary)">18:10</span> <span>context.loaded</span></div>
          <div className="flex gap-4"><span className="text-(--ui-text-tertiary)">18:11</span> <span>tool.call</span></div>
        </div>
      </div>
      <div className="shrink-0 border-t border-(--ui-border) p-4 flex justify-end">
         <button className="rounded-md border border-red-500/30 px-4 py-1.5 text-sm text-red-500 hover:bg-red-500/10">中断任务</button>
      </div>
    </div>
  )
}

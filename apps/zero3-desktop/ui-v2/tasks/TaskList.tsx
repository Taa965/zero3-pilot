export function TaskList() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 p-3 border-b border-(--ui-border)">
        <div className="font-medium text-sm">任务</div>
      </div>
      <div className="flex gap-2 p-2 text-xs text-(--ui-text-secondary) overflow-x-auto">
        <button className="bg-(--ui-control-active-background) text-foreground px-2 py-1 rounded">全部</button>
        <button className="hover:bg-(--ui-control-hover-background) px-2 py-1 rounded whitespace-nowrap">运行中</button>
        <button className="hover:bg-(--ui-control-hover-background) px-2 py-1 rounded whitespace-nowrap">待审核</button>
        <button className="hover:bg-(--ui-control-hover-background) px-2 py-1 rounded whitespace-nowrap">异常</button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <button className="w-full text-left p-3 rounded-lg border border-(--ui-border) bg-(--ui-control-active-background) mb-2">
          <div className="text-xs font-mono text-(--ui-text-tertiary)">UI2-GEMINI-001</div>
          <div className="font-medium text-sm mt-1">重构消息工作区</div>
          <div className="text-xs text-(--ui-text-secondary) mt-2 flex items-center gap-1">
            <span className="text-violet-500">✦ Gemini</span> → <span className="text-blue-500">◎ GPT Review</span>
          </div>
          <div className="text-xs text-(--ui-text-tertiary) mt-1">审核轮次 2/5</div>
          <div className="text-xs font-medium text-amber-500 mt-2 text-right">待审核</div>
        </button>
      </div>
    </div>
  )
}

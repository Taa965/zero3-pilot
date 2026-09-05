import { Codicon } from '@/components/ui/codicon'

export function DevelopmentGroupList() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 p-3 border-b border-(--ui-border)">
        <div className="font-medium text-sm flex items-center gap-2"><Codicon name="organization" /> 开发组</div>
        <button className="flex items-center gap-1 text-xs text-blue-500 hover:underline"><Codicon name="plus" className="size-3.5" /> 新建</button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <button className="w-full text-left p-3 rounded-lg border border-(--ui-border) bg-(--ui-control-active-background) mb-2 hover:bg-(--ui-control-hover-background)">
          <div className="font-medium text-sm">Zero3 UI 2.0</div>
          <div className="mt-2 text-xs text-(--ui-text-secondary) flex items-center gap-2">
            <div className="h-1.5 flex-1 bg-(--ui-border) rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 w-[72%]"></div>
            </div>
            72%
          </div>
          <div className="text-xs text-(--ui-text-tertiary) mt-2 flex flex-col gap-1">
            <div className="flex items-center gap-1"><Codicon name="check-all" className="size-3.5" /> 6/9 项需求完成</div>
            <div className="flex items-center gap-1"><Codicon name="sync~spin" className="size-3.5" /> 4 个会话运行中</div>
            <div className="flex items-center gap-1 text-amber-500"><Codicon name="warning" className="size-3.5" /> 1 项需要处理</div>
          </div>
        </button>
      </div>
    </div>
  )
}

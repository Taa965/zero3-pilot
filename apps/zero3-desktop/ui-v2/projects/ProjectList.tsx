import { Codicon } from '@/components/ui/codicon'

export function ProjectList() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 p-3 border-b border-(--ui-border)">
        <div className="font-medium text-sm flex items-center gap-2"><Codicon name="repo" /> 项目</div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <button className="w-full text-left p-3 rounded-lg border border-(--ui-border) bg-(--ui-control-active-background) mb-2 hover:bg-(--ui-control-hover-background)">
          <div className="font-medium text-sm">Zero3 Pilot</div>
          <div className="text-xs text-(--ui-text-tertiary) mt-2 flex flex-col gap-1">
            <div className="flex items-center gap-2"><Codicon name="git-branch" className="size-3.5" /> feature/ui-v2</div>
            <div className="flex items-center gap-2 text-amber-500"><Codicon name="diff-modified" className="size-3.5" /> 12 个未提交文件</div>
            <div className="flex items-center gap-2 mt-1"><Codicon name="sync~spin" className="size-3.5 text-blue-500" /> 2 个运行中的会话</div>
          </div>
        </button>
      </div>
    </div>
  )
}

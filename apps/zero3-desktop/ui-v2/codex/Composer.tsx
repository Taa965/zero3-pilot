import { Codicon } from '@/components/ui/codicon'

export function Composer() {
  return (
    <div className="flex flex-col border-t border-(--ui-border) p-4 bg-background shrink-0">
      <div className="flex items-center gap-2 mb-2 text-xs text-(--ui-text-tertiary)">
        <Codicon name="list-tree" className="size-3" />
        <span>模式: Codex Local</span>
      </div>
      <div className="relative">
        <textarea 
          className="w-full min-h-[80px] bg-(--ui-pane-background) border border-(--ui-border) rounded-lg p-3 text-sm focus:outline-none focus:border-blue-500 resize-none"
          placeholder="给 Codex 发送消息..."
        />
        <div className="absolute right-3 bottom-3 flex items-center gap-2">
          <button className="p-1.5 rounded text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background)"><Codicon name="paperclip" /></button>
          <button className="p-1.5 rounded text-white bg-blue-600 hover:bg-blue-700"><Codicon name="send" /></button>
        </div>
      </div>
    </div>
  )
}

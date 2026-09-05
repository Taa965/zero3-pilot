import { Codicon } from '@/components/ui/codicon'

export function GptWebSurface() {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-(--ui-border) px-4 text-sm">
        <button className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)">交给 Codex</button>
        <button className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)">交给 Gemini</button>
        <button className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)">任务</button>
        <button className="rounded-md border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)">浏览器</button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center text-(--ui-text-secondary)">
        <Codicon name="globe" className="mb-4 size-12 text-blue-500 opacity-50" />
        <div>ChatGPT Web 视图区</div>
        <div className="text-xs mt-2 text-(--ui-text-tertiary)">(原生浏览器视图将在此处挂载)</div>
      </div>
    </div>
  )
}

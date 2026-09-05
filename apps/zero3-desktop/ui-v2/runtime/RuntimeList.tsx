import { Codicon } from '@/components/ui/codicon'

export function RuntimeList() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 p-3 border-b border-(--ui-border)">
        <div className="font-medium text-sm flex items-center gap-2"><Codicon name="server-environment" /> 运行中心</div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <div className="text-xs font-medium text-(--ui-text-tertiary) uppercase mb-2 px-2 mt-2">核心 (Kernel)</div>
        <button className="w-full text-left px-3 py-2 rounded-md hover:bg-(--ui-control-hover-background) flex items-center justify-between text-sm">
          <span>Codex Kernel</span>
          <span className="text-green-500 text-xs font-medium">就绪</span>
        </button>

        <div className="text-xs font-medium text-(--ui-text-tertiary) uppercase mb-2 px-2 mt-4">服务提供商 (Providers)</div>
        <button className="w-full text-left px-3 py-2 rounded-md hover:bg-(--ui-control-hover-background) text-sm">GPT Web</button>
        <button className="w-full text-left px-3 py-2 rounded-md hover:bg-(--ui-control-hover-background) text-sm">Gemini Web</button>
        <button className="w-full text-left px-3 py-2 rounded-md hover:bg-(--ui-control-hover-background) text-sm bg-(--ui-control-active-background)">Antigravity</button>

        <div className="text-xs font-medium text-(--ui-text-tertiary) uppercase mb-2 px-2 mt-4">执行引擎 (Execution)</div>
        <button className="w-full text-left px-3 py-2 rounded-md hover:bg-(--ui-control-hover-background) text-sm">执行器池 (Executor Pool)</button>
        <button className="w-full text-left px-3 py-2 rounded-md hover:bg-(--ui-control-hover-background) text-sm">Agent 路由 (Agent Router)</button>

        <div className="text-xs font-medium text-(--ui-text-tertiary) uppercase mb-2 px-2 mt-4">工具集 (Tools)</div>
        <button className="w-full text-left px-3 py-2 rounded-md hover:bg-(--ui-control-hover-background) flex items-center justify-between text-sm">
          <span>MCP 网关 (Gateways)</span>
          <span className="bg-blue-500 text-white text-[10px] px-1.5 rounded-full">1</span>
        </button>
      </div>
    </div>
  )
}

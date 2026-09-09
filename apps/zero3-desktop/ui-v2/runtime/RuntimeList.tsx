import { Codicon } from '@/components/ui/codicon'
import type { RuntimeTarget } from './runtime-types'

interface RuntimeListProps {
  activeTarget: RuntimeTarget
  onTargetChange: (target: RuntimeTarget) => void
}

function itemClass(active: boolean): string {
  return `w-full rounded-md px-3 py-2 text-left text-sm hover:bg-(--ui-control-hover-background) ${active ? 'bg-(--ui-control-active-background)' : ''}`
}

export function RuntimeList({ activeTarget, onTargetChange }: RuntimeListProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-(--ui-border) p-3">
        <div className="flex items-center gap-2 text-sm font-medium"><Codicon name="server-environment" /> 运行中心</div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <div className="mb-2 mt-2 px-2 text-xs font-medium uppercase text-(--ui-text-tertiary)">核心 (Kernel)</div>
        <button onClick={() => onTargetChange('kernel')} className={`${itemClass(activeTarget === 'kernel')} flex items-center justify-between`}>
          <span>Codex Kernel</span>
          <span className="text-xs font-medium text-green-500">就绪</span>
        </button>

        <div className="mb-2 mt-4 px-2 text-xs font-medium uppercase text-(--ui-text-tertiary)">服务提供商 (Providers)</div>
        <button className={itemClass(false)}>GPT Web</button>
        <button className={itemClass(false)}>Gemini Web</button>
        <button className={itemClass(false)}>Antigravity</button>

        <div className="mb-2 mt-4 px-2 text-xs font-medium uppercase text-(--ui-text-tertiary)">机器人 (Robots)</div>
        <button onClick={() => onTargetChange('weixin')} className={`${itemClass(activeTarget === 'weixin')} flex items-center justify-between`}>
          <span className="flex items-center gap-2"><Codicon name="comment-discussion" /> 微信机器人</span>
          <span className="text-xs text-(--ui-text-tertiary)">管理</span>
        </button>

        <div className="mb-2 mt-4 px-2 text-xs font-medium uppercase text-(--ui-text-tertiary)">执行引擎 (Execution)</div>
        <button className={itemClass(false)}>执行器池 (Executor Pool)</button>
        <button className={itemClass(false)}>Agent 路由 (Agent Router)</button>

        <div className="mb-2 mt-4 px-2 text-xs font-medium uppercase text-(--ui-text-tertiary)">工具集 (Tools)</div>
        <button className={`${itemClass(false)} flex items-center justify-between`}>
          <span>MCP 网关 (Gateways)</span>
          <span className="rounded-full bg-blue-500 px-1.5 text-[10px] text-white">1</span>
        </button>
      </div>
    </div>
  )
}

import { Codicon } from '@/components/ui/codicon'
import { ReasoningSummaryCard } from './ReasoningSummaryCard'
import { PlanCard } from './PlanCard'
import { ToolExecutionCard } from './ToolExecutionCard'
import { FileChangeCard } from './FileChangeCard'

interface CodexItemRendererProps {
  item: {
    id: string
    role: string
    content: string
    reasoning?: string
    plan?: string
    tools?: Array<{name: string, status: 'running' | 'completed' | 'error', duration: string}>
    files?: Array<{path: string, status: 'modified' | 'added' | 'deleted'}>
  }
}

export function CodexItemRenderer({ item }: CodexItemRendererProps) {
  const isUser = item.role === 'user'

  return (
    <div className={`flex gap-4 ${isUser ? '' : 'bg-(--ui-pane-background) p-4 rounded-lg border border-(--ui-border)'}`}>
      <div className="shrink-0">
        <div className={`size-8 rounded-full flex items-center justify-center ${isUser ? 'bg-blue-500 text-white' : 'bg-violet-600 text-white'}`}>
          <Codicon name={isUser ? 'person' : 'robot'} />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm mb-2">{isUser ? '用户' : 'Codex 本地'}</div>
        
        {item.reasoning && <ReasoningSummaryCard summary={item.reasoning} expanded={false} />}
        {item.plan && <PlanCard plan={item.plan} />}
        
        {item.tools?.map((t, i) => (
          <ToolExecutionCard key={i} toolName={t.name} status={t.status} duration={t.duration} />
        ))}
        
        {item.files?.map((f, i) => (
          <FileChangeCard
            key={i}
            filePath={f.path}
            changeType={f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M'}
          />
        ))}
        
        {item.content && (
          <div className="text-sm mt-3 whitespace-pre-wrap leading-relaxed">
            {item.content}
          </div>
        )}
      </div>
    </div>
  )
}

import { Codicon } from '@/components/ui/codicon'

interface ToolExecutionCardProps {
  toolName: string
  status: 'running' | 'completed' | 'error'
  duration?: string
}

export function ToolExecutionCard({ toolName, status, duration }: ToolExecutionCardProps) {
  const isRunning = status === 'running'
  
  return (
    <div className="flex items-center gap-3 rounded-lg border border-(--ui-border) bg-(--ui-pane-background) p-3 text-sm mb-3">
      {isRunning ? (
        <Codicon name="sync~spin" className="text-blue-500" />
      ) : status === 'error' ? (
        <Codicon name="error" className="text-red-500" />
      ) : (
        <Codicon name="pass-filled" className="text-green-500" />
      )}
      <div className="flex-1 font-mono text-xs">{toolName}</div>
      <div className="text-xs text-(--ui-text-tertiary)">
        {isRunning ? '运行中...' : duration}
      </div>
    </div>
  )
}

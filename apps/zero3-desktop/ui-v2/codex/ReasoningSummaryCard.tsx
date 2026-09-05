import { Codicon } from '@/components/ui/codicon'

interface ReasoningSummaryCardProps {
  summary: string
  expanded?: boolean
}

export function ReasoningSummaryCard({ summary, expanded }: ReasoningSummaryCardProps) {
  return (
    <div className="rounded-lg border border-(--ui-border) bg-(--ui-pane-background) text-sm mb-3">
      <div className="flex items-center justify-between p-3 border-b border-(--ui-border) cursor-pointer hover:bg-(--ui-control-hover-background)">
        <div className="flex items-center gap-2 font-medium text-(--ui-text-secondary)">
          <Codicon name="lightbulb" className="text-amber-500" />
          推理摘要
        </div>
        <Codicon name={expanded ? "chevron-up" : "chevron-down"} className="text-(--ui-text-tertiary)" />
      </div>
      {expanded && (
        <div className="p-3 text-(--ui-text-secondary) whitespace-pre-wrap">
          {summary}
        </div>
      )}
    </div>
  )
}

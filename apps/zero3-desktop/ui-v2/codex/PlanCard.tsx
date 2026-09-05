import { Codicon } from '@/components/ui/codicon'

interface PlanCardProps {
  plan: string
}

export function PlanCard({ plan }: PlanCardProps) {
  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 text-sm mb-3">
      <div className="flex items-center gap-2 p-3 border-b border-blue-500/20 font-medium text-blue-600">
        <Codicon name="tasklist" />
        执行计划
      </div>
      <div className="p-3 text-foreground whitespace-pre-wrap">
        {plan}
      </div>
    </div>
  )
}

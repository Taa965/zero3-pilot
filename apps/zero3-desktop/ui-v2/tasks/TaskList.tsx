import { useEffect, useMemo, useState } from 'react'

import { WorkflowAdapter, type WorkflowRunSummary } from './WorkflowAdapter'
import { setTaskSelection, useTaskSelection } from './task-selection'

type Filter = 'all' | 'running' | 'human' | 'error' | 'completed'
const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'human', label: '等待人工' },
  { id: 'error', label: '异常' },
  { id: 'completed', label: '已完成' }
]

function matches(run: WorkflowRunSummary, filter: Filter): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return ['READY', 'RUNNING'].includes(run.status)
  if (filter === 'human') return run.status === 'WAITING_HUMAN'
  if (filter === 'error') return ['BLOCKED', 'FAILED'].includes(run.status)
  return run.status === 'COMPLETED'
}

export function TaskList() {
  const selection = useTaskSelection()
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const values = await WorkflowAdapter.listRuns()
        if (!cancelled) {
          setRuns(values)
          setError(null)
          if (selection.kind === 'none' && values[0]) setTaskSelection({ kind: 'run', runId: values[0].workflowRunId })
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [selection.kind === 'none'])

  const visible = useMemo(() => runs.filter(run => matches(run, filter)), [runs, filter])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-(--ui-border) p-3">
        <div className="font-medium text-sm">任务</div>
        <button onClick={() => setTaskSelection({ kind: 'new' })} className="ml-auto rounded border border-(--ui-border) px-2 py-1 text-xs hover:bg-(--ui-control-hover-background)">＋ 新建</button>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-(--ui-border) p-2 text-xs text-(--ui-text-secondary)">
        {filters.map(item => <button key={item.id} onClick={() => setFilter(item.id)} className={`whitespace-nowrap rounded px-2 py-1 ${filter === item.id ? 'bg-(--ui-control-active-background) text-foreground' : 'hover:bg-(--ui-control-hover-background)'}`}>{item.label}</button>)}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {error && <div className="mb-2 rounded border border-red-500/20 bg-red-500/5 p-2 text-xs text-red-500">{error}</div>}
        {visible.map(run => {
          const selected = selection.kind === 'run' && selection.runId === run.workflowRunId
          return <button key={run.workflowRunId} onClick={() => setTaskSelection({ kind: 'run', runId: run.workflowRunId })} className={`mb-2 w-full rounded-lg border p-3 text-left ${selected ? 'border-blue-500/50 bg-blue-500/5' : 'border-(--ui-border) hover:bg-(--ui-control-hover-background)'}`}>
            <div className="truncate text-sm font-medium">{run.title}</div>
            <div className="mt-1 truncate text-[11px] text-(--ui-text-tertiary)">{run.moduleId} · v{run.moduleVersion}</div>
            <div className="mt-3 h-1.5 overflow-hidden rounded bg-(--ui-control-background)"><div className="h-full bg-blue-500" style={{ width: `${Math.round(run.progress * 100)}%` }} /></div>
            <div className="mt-2 flex items-center justify-between text-[11px]"><span className="text-(--ui-text-tertiary)">{Math.round(run.progress * 100)}%</span><span className={run.status === 'COMPLETED' ? 'text-green-500' : ['FAILED', 'BLOCKED'].includes(run.status) ? 'text-red-500' : 'text-blue-500'}>{run.status}</span></div>
          </button>
        })}
        {!error && visible.length === 0 && <div className="p-6 text-center text-xs text-(--ui-text-tertiary)">暂无任务</div>}
      </div>
    </div>
  )
}

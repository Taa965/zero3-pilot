import { useState } from 'react'
import { useTasks } from './TaskContext'
import { matchesTask, percent, statusLabel, type TaskFilter } from './task-model'
const filters: [TaskFilter, string][] = [['all', '全部'], ['running', '运行中'], ['review', '待审核'], ['error', '异常'], ['completed', '已完成']]
export function TaskList() {
  const { tasks, selectedId, select, creating, setCreating, loading, busy, error, refresh } = useTasks()
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState('')
  const projects = [...new Set(tasks.map(task => task.definition.task.projectId).filter((id): id is string => !!id))]
  const visible = tasks.filter(task => matchesTask(task, filter, query, projectId))
  return <div className="flex h-full flex-col">
    <div className="flex items-center justify-between border-b border-(--ui-border) p-3 text-sm">
      <span>任务 · {tasks.length}</span>
      <button type="button" disabled={busy} onClick={() => setCreating(true)} className="text-blue-500 disabled:opacity-50">＋ 新建任务</button>
    </div>
    <div className="space-y-2 p-3">
      <input aria-label="搜索任务" placeholder="搜索任务名称、编号或目标" value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded border border-(--ui-border) bg-background p-2 text-xs" />
      <select aria-label="按项目筛选任务" value={projectId} onChange={event => setProjectId(event.target.value)} className="w-full rounded border border-(--ui-border) bg-background p-2 text-xs">
        <option value="">全部项目</option>{projects.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
      <div className="flex flex-wrap gap-1 text-xs">{filters.map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={`rounded px-2 py-1 ${filter === id ? 'bg-(--ui-control-active-background)' : 'hover:bg-(--ui-control-hover-background)'}`}>{label}</button>)}</div>
    </div>
    {error && <div role="alert" className="mx-3 mb-2 rounded border border-red-500/30 p-2 text-xs text-red-500">{error}</div>}
    <button type="button" disabled={busy} onClick={() => void refresh()} className="px-3 pb-2 text-left text-xs text-blue-500">刷新</button>
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
      {loading ? <p className="p-3 text-sm">正在加载任务…</p> : visible.length === 0 ? <p className="p-3 text-xs text-(--ui-text-secondary)">{error ? '暂时无法读取任务。' : tasks.length ? '没有符合筛选条件的任务。' : '暂无任务，点击“新建任务”开始。'}</p> : visible.map(task => {
        const definition = task.definition.task
        const attention = task.runtime.steps.filter(step => ['verifying', 'waiting_human', 'blocked', 'failed', 'fix_required', 'outcome_unknown'].includes(step.status))
        return <button key={definition.taskId} type="button" aria-pressed={!creating && selectedId === definition.taskId} onClick={() => { select(definition.taskId); setCreating(false) }} className={`w-full rounded-lg border border-(--ui-border) p-3 text-left ${!creating && selectedId === definition.taskId ? 'bg-(--ui-control-active-background)' : 'hover:bg-(--ui-control-hover-background)'}`}>
          <div className="break-words text-sm font-medium">{definition.title}</div>
          <div className="mt-1 truncate text-xs text-(--ui-text-tertiary)" title={definition.taskId}>{definition.taskId}</div>
          <div className="mt-2 flex justify-between text-xs"><span>{statusLabel(task.runtime.task.status)}</span><span>{percent(task.runtime.task.progress)}</span></div>
          <progress aria-label={`${definition.title}进度`} className="mt-2 h-1 w-full" max={1} value={task.runtime.task.progress} />
          {attention.length > 0 && <div className="mt-2 text-xs text-amber-500">{[...new Set(attention.map(step => statusLabel(step.status)))].join(' · ')} · {attention.length} 步</div>}
        </button>
      })}
    </div>
  </div>
}

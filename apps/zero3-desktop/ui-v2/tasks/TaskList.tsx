import { useEffect, useRef, useState } from 'react'
import type { ExecutionTaskSnapshot } from '../../execution-runtime/contracts.ts'
import { useTasks } from './TaskContext'
import { taskBridge } from './TaskAdapter'
import { matchesTask, percent, statusLabel, type TaskFilter } from './task-model'
const filters: [TaskFilter, string][] = [['all', '全部'], ['running', '运行中'], ['review', '待审核'], ['error', '异常'], ['completed', '已完成'], ['archived', '归档']]
const CONTEXT_MENU_WIDTH = 176
const CONTEXT_MENU_HEIGHT = 104
type TaskMenu = { task: ExecutionTaskSnapshot; x: number; y: number }
export function TaskList() {
  const { tasks, selectedId, select, creating, setCreating, setCreatingMode, loading, busy, error, refresh, mutate } = useTasks()
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState('')
  const [menu, setMenu] = useState<TaskMenu | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ExecutionTaskSnapshot | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const projects = [...new Set(tasks.map(task => task.definition.task.projectId).filter((id): id is string => !!id))]
  const visible = tasks.filter(task => matchesTask(task, filter, query, projectId))
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    // 点击菜单自身不能关闭菜单；用包含判断而不是依赖事件传播顺序。
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      close()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  const openMenu = (task: ExecutionTaskSnapshot, event: React.MouseEvent) => {
    event.preventDefault()
    const bounds = paneRef.current?.getBoundingClientRect()
    const maxX = bounds ? bounds.right - CONTEXT_MENU_WIDTH - 4 : event.clientX
    const minX = bounds ? bounds.left + 4 : 4
    setMenu({
      task,
      x: Math.max(minX, Math.min(event.clientX, maxX)),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - 4)
    })
  }
  const setArchived = (task: ExecutionTaskSnapshot, archived: boolean) => {
    void mutate(() => taskBridge().setTaskArchived(task.definition.task.taskId, archived))
  }
  const confirmDelete = async () => {
    const target = pendingDelete
    setPendingDelete(null)
    if (!target) return
    await mutate(() => taskBridge().deleteTask(target.definition.task.taskId))
  }
  return <div ref={paneRef} className="flex h-full flex-col">
    <div className="flex items-center justify-between border-b border-(--ui-border) p-3 text-sm">
      <span>任务 · {tasks.length}</span>
      <div className="flex gap-3">
        <button type="button" disabled={busy} onClick={() => { setCreatingMode('goal'); setCreating(true) }} className="text-emerald-600 disabled:opacity-50">◎ 自主目标</button>
        <button type="button" disabled={busy} onClick={() => { setCreatingMode('task'); setCreating(true) }} className="text-blue-500 disabled:opacity-50">＋ 新建任务</button>
      </div>
    </div>
    <div className="space-y-2 p-3">
      <input aria-label="搜索任务" placeholder="搜索任务名称、编号或目标" value={query} onChange={event => { setMenu(null); setQuery(event.target.value) }} className="w-full rounded border border-(--ui-border) bg-background p-2 text-xs" />
      <select aria-label="按项目筛选任务" value={projectId} onChange={event => { setMenu(null); setProjectId(event.target.value) }} className="w-full rounded border border-(--ui-border) bg-background p-2 text-xs">
        <option value="">全部项目</option>{projects.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
      <div className="flex flex-wrap gap-1 text-xs">{filters.map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => { setMenu(null); setFilter(id) }} className={`rounded px-2 py-1 ${filter === id ? 'bg-(--ui-control-active-background)' : 'hover:bg-(--ui-control-hover-background)'}`}>{label}</button>)}</div>
    </div>
    {error && <div role="alert" className="mx-3 mb-2 rounded border border-red-500/30 p-2 text-xs text-red-500">{error}</div>}
    <button type="button" disabled={busy} onClick={() => void refresh()} className="px-3 pb-2 text-left text-xs text-blue-500">刷新</button>
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
      {loading ? <p className="p-3 text-sm">正在加载任务…</p> : visible.length === 0 ? <p className="p-3 text-xs text-(--ui-text-secondary)">{error ? '暂时无法读取任务。' : tasks.length ? '没有符合筛选条件的任务。' : '暂无任务，点击“新建任务”开始。'}</p> : visible.map(task => {
        const definition = task.definition.task
        const attention = task.runtime.steps.filter(step => ['verifying', 'waiting_human', 'blocked', 'failed', 'fix_required', 'outcome_unknown'].includes(step.status))
        const current = task.runtime.steps.find(step => ['dispatching', 'running', 'waiting_report', 'verifying', 'fix_required'].includes(step.status))
          ?? task.runtime.steps.find(step => ['ready', 'blocked', 'waiting_human', 'outcome_unknown'].includes(step.status))
        const currentDefinition = current ? task.definition.steps.find(step => step.stepId === current.stepId) : null
        return <button key={definition.taskId} type="button" aria-pressed={!creating && selectedId === definition.taskId} title="右键可归档或删除任务" onClick={() => { select(definition.taskId); setCreating(false) }} onContextMenu={event => openMenu(task, event)} className={`w-full rounded-lg border border-(--ui-border) p-3 text-left ${!creating && selectedId === definition.taskId ? 'bg-(--ui-control-active-background)' : 'hover:bg-(--ui-control-hover-background)'}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 break-words text-sm font-medium">{definition.title}</div>
            <div className="flex shrink-0 gap-1">
              {definition.metadata?.autonomousRootGoal === true && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600">自主目标</span>}
              {definition.metadata?.autonomous === true && definition.metadata?.autonomousRootGoal !== true && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-500">AUTO</span>}
              {task.archived && <span className="rounded bg-(--ui-control-active-background) px-1.5 py-0.5 text-[10px] text-(--ui-text-secondary)">已归档</span>}
            </div>
          </div>
          <div className="mt-1 truncate text-xs text-(--ui-text-tertiary)" title={definition.taskId}>{definition.taskId}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-(--ui-text-tertiary)">
            <span>项目：{definition.projectId ?? '无项目'}</span>
            <span className="truncate">{String(definition.metadata?.workflowName ?? definition.workflowId ?? '自定义任务')}</span>
          </div>
          {currentDefinition && current && <div className="mt-1 truncate text-xs text-(--ui-text-secondary)">当前：{currentDefinition.title} · {currentDefinition.executor} · {statusLabel(current.status)}</div>}
          <div className="mt-2 flex justify-between text-xs"><span>{statusLabel(task.runtime.task.status)}</span><span>{percent(task.runtime.task.progress)}</span></div>
          <progress aria-label={`${definition.title}进度`} className="mt-2 h-1 w-full" max={1} value={task.runtime.task.progress} />
          {attention.length > 0 && <div className="mt-2 text-xs text-amber-500">{[...new Set(attention.map(step => statusLabel(step.status)))].join(' · ')} · {attention.length} 步</div>}
        </button>
      })}
    </div>
    {menu && <div ref={menuRef} role="menu" aria-label="任务操作" style={{ left: menu.x, top: menu.y, width: CONTEXT_MENU_WIDTH }} onMouseDown={event => event.stopPropagation()} className="fixed z-50 rounded-md border border-(--ui-border) bg-background p-1 shadow-lg">
      <button role="menuitem" disabled={busy} onClick={() => { const target = menu.task; setMenu(null); setArchived(target, !target.archived) }} className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-(--ui-control-hover-background) disabled:opacity-40">
        {menu.task.archived ? '取消归档' : '归档任务'}
      </button>
      <button role="menuitem" disabled={busy} onClick={() => { const target = menu.task; setMenu(null); setPendingDelete(target) }} className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-red-600 hover:bg-(--ui-control-hover-background) disabled:opacity-40">
        删除任务
      </button>
      <div className="px-2 pb-1 pt-0.5 text-[11px] leading-tight text-(--ui-text-tertiary)">归档后不再出现在日常列表与自动调度中</div>
    </div>}
    {pendingDelete && <div role="dialog" aria-label="删除任务确认" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-sm space-y-3 rounded-lg border border-(--ui-border) bg-background p-4 shadow-xl">
        <h2 className="text-sm font-medium">删除任务</h2>
        <p className="break-words text-xs text-(--ui-text-secondary)">将永久删除「{pendingDelete.definition.task.title}」及其步骤、会话绑定、产物记录与全部事件历史，无法撤销。</p>
        <p className="break-all text-[11px] text-(--ui-text-tertiary)">{pendingDelete.definition.task.taskId}</p>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setPendingDelete(null)} className="rounded border border-(--ui-border) px-3 py-1.5 text-sm hover:bg-(--ui-control-hover-background)">取消</button>
          <button type="button" disabled={busy} onClick={() => void confirmDelete()} className="rounded border border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-40">{busy ? '正在删除…' : '确认删除'}</button>
        </div>
      </div>
    </div>}
  </div>
}

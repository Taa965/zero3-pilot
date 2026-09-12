import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ExecutionTaskSnapshot } from '../../execution-runtime/contracts.ts'
import { readTaskSnapshots, taskBridge } from './TaskAdapter'
interface TaskState {
  tasks: ExecutionTaskSnapshot[]
  selectedId: string | null
  select: (id: string | null) => void
  creating: boolean
  setCreating: (value: boolean) => void
  creatingMode: 'task' | 'goal'
  setCreatingMode: (value: 'task' | 'goal') => void
  loading: boolean
  busy: boolean
  error: string | null
  refresh: () => Promise<void>
  mutate: (operation: () => Promise<unknown>) => Promise<boolean>
}
const TaskContext = createContext<TaskState | null>(null)
export function TaskProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const [tasks, setTasks] = useState<ExecutionTaskSnapshot[]>([])
  const [selectedId, select] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingMode, setCreatingMode] = useState<'task' | 'goal'>('task')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const mutation = useRef(false)
  const refreshing = useRef(0)
  const generation = useRef(0)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    refreshing.current++
    try {
      const next = readTaskSnapshots(await taskBridge().listTasks())
      if (!mounted.current || request !== generation.current) return
      setTasks(next)
      select(current => next.some(task => task.definition.task.taskId === current) ? current : next[0]?.definition.task.taskId ?? null)
      setError(null)
    } catch (cause) {
      if (mounted.current && request === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      refreshing.current--
      if (mounted.current && request === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])
  useEffect(() => {
    if (!active) return
    void refresh()
    const timer = window.setInterval(() => { if (!mutation.current && refreshing.current === 0 && document.visibilityState !== 'hidden') void refresh() }, 3000)
    return () => { window.clearInterval(timer); generation.current++ }
  }, [active, refresh])
  const mutate = useCallback(async (operation: () => Promise<unknown>) => {
    if (mutation.current) return false
    mutation.current = true
    generation.current++
    setBusy(true)
    setActionError(null)
    try {
      await operation()
      await refresh()
      return true
    } catch (cause) {
      await refresh()
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      mutation.current = false
      if (mounted.current) setBusy(false)
    }
  }, [refresh])
  return <TaskContext.Provider value={{ tasks, selectedId, select, creating, setCreating, creatingMode, setCreatingMode, loading, busy, error: actionError ?? error, refresh, mutate }}>{children}</TaskContext.Provider>
}
export function useTasks() {
  const value = useContext(TaskContext)
  if (!value) throw new Error('TaskProvider is required')
  return value
}

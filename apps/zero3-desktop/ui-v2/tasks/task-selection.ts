import { useSyncExternalStore } from 'react'

export type TaskSelection = { kind: 'none' } | { kind: 'new'; moduleId?: string } | { kind: 'run'; runId: string }

let selection: TaskSelection = { kind: 'none' }
const listeners = new Set<() => void>()

export function setTaskSelection(next: TaskSelection): void {
  selection = next
  for (const listener of listeners) listener()
}

export function useTaskSelection(): TaskSelection {
  return useSyncExternalStore(
    callback => { listeners.add(callback); return () => listeners.delete(callback) },
    () => selection,
    () => selection
  )
}

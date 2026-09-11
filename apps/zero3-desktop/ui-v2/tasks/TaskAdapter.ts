import type { ExecutionTaskSnapshot } from '../../execution-runtime/contracts.ts'
import type { TaskInput } from './task-model.ts'

export type TaskWorkflowSummary = {
  id: string
  name: string
  description: string
  category: string
  revision: number
}

export type CreateWorkflowTaskInput = {
  title: string
  description: string
  projectId: string | null
  workspace?: string | null
  workflowId: string
}

export interface TaskBridge {
  listTasks(): Promise<unknown>
  setTaskArchived(taskId: string, archived: boolean): Promise<unknown>
  deleteTask(taskId: string): Promise<unknown>
  listTaskWorkflows(): Promise<unknown>
  createWorkflowTask(input: CreateWorkflowTaskInput): Promise<unknown>
  skillCapabilities(): Promise<unknown>
  refreshSkillPreflight(taskId: string): Promise<unknown>
  reconcileReadiness(taskId: string): Promise<unknown>
  createTask(input: TaskInput): Promise<unknown>
  addSteps(taskId: string, steps: Record<string, unknown>[]): Promise<unknown>
  createAssignment(taskId: string, stepId: string, executor: string): Promise<unknown>
  createRoutedAssignment(taskId: string, stepId: string, executorId?: string | null): Promise<unknown>
  bindSession(assignmentId: string, input: Record<string, unknown>): Promise<unknown>
  transitionStep(taskId: string, stepId: string, status: string, reason?: string): Promise<unknown>
  gatePassed(taskId: string, stepId: string, evidence?: Record<string, unknown>): Promise<unknown>
  gateFailed(taskId: string, stepId: string, reason: string): Promise<unknown>
}

export function taskBridge(): TaskBridge {
  const bridge = (window as unknown as { zero3Execution?: TaskBridge }).zero3Execution
  if (!bridge) throw new Error('任务服务未连接，请在 Zero3 桌面中打开，并更新或重启桌面服务。')
  return bridge
}

export function readTaskWorkflows(value: unknown): TaskWorkflowSummary[] {
  if (!Array.isArray(value)) throw new Error('工作流服务返回了无效列表')
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('工作流数据不完整')
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.description !== 'string' ||
        typeof row.category !== 'string' || !Number.isSafeInteger(row.revision)) {
      throw new Error('工作流数据不完整')
    }
    return row as TaskWorkflowSummary
  })
}
export function readTaskSnapshots(value: unknown): ExecutionTaskSnapshot[] {
  if (!Array.isArray(value)) throw new Error('任务服务返回了无效的任务列表')
  for (const item of value) {
    if (item?.definition?.task?.contract !== 'zero3.pilot.execution-task.v1' ||
        item?.definition?.task?.taskId !== item?.runtime?.task?.taskId ||
        typeof item?.archived !== 'boolean' ||
        !Array.isArray(item?.definition?.steps) || !Array.isArray(item?.runtime?.steps) ||
        !Array.isArray(item?.runtime?.assignments) || !Array.isArray(item?.runtime?.sessionBindings) || !Array.isArray(item?.events)) {
      throw new Error('任务数据不完整，请检查任务服务版本')
    }
  }
  return [...value].sort((a, b) => b.runtime.task.updatedAt.localeCompare(a.runtime.task.updatedAt))
}

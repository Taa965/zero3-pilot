import type { ExecutionExecutorTarget, ExecutionExpectedOutput } from '../contracts.ts'

export const ZERO3_TASK_WORKFLOW = 'zero3.pilot.task-workflow.v1' as const

export interface TaskWorkflowSummary {
  id: string
  name: string
  description: string
  category: string
  revision: number
  /** 该工作流要求项目生产配置；新建任务前用户需要准备好生产输入。 */
  requiresProductionProfile?: boolean
}

export interface TaskWorkflowCreateInput {
  title: string
  description: string
  projectId: string | null
  workspace?: string | null
  workflowId: string
}

export interface TaskWorkflowStepTemplate {
  key: string
  title: string
  objective: string
  executor: ExecutionExecutorTarget
  dependsOn?: readonly string[]
  requiredSkills?: readonly string[]
  optionalSkills?: readonly string[]
  expectedOutputs?: readonly ExecutionExpectedOutput[]
  completionGate?: readonly string[]
  maxAttempts?: number
  metadata?: Readonly<Record<string, unknown>>
}

export interface TaskWorkflowPlan {
  maxParallelSteps: number
  steps: readonly TaskWorkflowStepTemplate[]
  metadata?: Readonly<Record<string, unknown>>
}

export interface TaskWorkflowModule {
  summary: TaskWorkflowSummary
  compile(input: TaskWorkflowCreateInput): TaskWorkflowPlan
}

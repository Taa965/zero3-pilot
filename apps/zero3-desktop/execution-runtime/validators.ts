import {
  ZERO3_EXECUTION_STEP,
  ZERO3_EXECUTION_TASK,
  type ExecutionExecutorTarget,
  type ExecutionWorkflowDefinition
} from './contracts.ts'
import { validateExecutionDag } from './scheduler.ts'

const EXECUTORS = new Set<ExecutionExecutorTarget>([
  'GPT_WEB', 'GEMINI_WEB', 'CODEX', 'CLAUDE', 'ANTIGRAVITY', 'ZERO3', 'REMOTE_COMPUTE', 'HUMAN', 'AUTO'
])

function text(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function validateExecutionWorkflowDefinition(definition: ExecutionWorkflowDefinition): readonly string[] {
  const errors: string[] = []
  const task = definition.task
  if (task.contract !== ZERO3_EXECUTION_TASK) errors.push('task contract is invalid')
  if (!text(task.taskId)) errors.push('taskId is required')
  if (!text(task.title)) errors.push('task title is required')
  if (!text(task.goal)) errors.push('task goal is required')
  if (!Number.isSafeInteger(definition.revision) || definition.revision < 1) errors.push('workflow revision must be a positive integer')
  if (!Number.isSafeInteger(task.maxParallelSteps) || task.maxParallelSteps < 1 || task.maxParallelSteps > 256) {
    errors.push('maxParallelSteps must be an integer between 1 and 256')
  }
  for (const step of definition.steps) {
    if (step.contract !== ZERO3_EXECUTION_STEP) errors.push(`${step.stepId || '<unknown>'} step contract is invalid`)
    if (step.taskId !== task.taskId) errors.push(`${step.stepId || '<unknown>'} belongs to a different task`)
    if (!text(step.stepId)) errors.push('stepId is required')
    if (!text(step.title)) errors.push(`${step.stepId} title is required`)
    if (!text(step.objective)) errors.push(`${step.stepId} objective is required`)
    if (!EXECUTORS.has(step.executor)) errors.push(`${step.stepId} executor is invalid`)
    if (!Number.isSafeInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 100) errors.push(`${step.stepId} maxAttempts must be between 1 and 100`)
    if (new Set(step.dependsOn).size !== step.dependsOn.length) errors.push(`${step.stepId} has duplicate dependencies`)
    for (const input of step.inputArtifacts) if (!text(input.logicalName)) errors.push(`${step.stepId} has an input artifact without logicalName`)
    for (const output of step.expectedOutputs) {
      if (!text(output.logicalName)) errors.push(`${step.stepId} has an expected output without logicalName`)
      if (output.minCount != null && (!Number.isSafeInteger(output.minCount) || output.minCount < 0)) errors.push(`${step.stepId}/${output.logicalName} minCount is invalid`)
      if (output.maxCount != null && (!Number.isSafeInteger(output.maxCount) || output.maxCount < 0)) errors.push(`${step.stepId}/${output.logicalName} maxCount is invalid`)
      if (output.minCount != null && output.maxCount != null && output.minCount > output.maxCount) errors.push(`${step.stepId}/${output.logicalName} count range is invalid`)
    }
  }
  errors.push(...validateExecutionDag(definition.steps))
  return [...new Set(errors)].sort()
}

import type { ExecutionStepDefinition, ExecutionStepRuntime } from './contracts.ts'

const ACTIVE_STATUSES = new Set<ExecutionStepRuntime['status']>(['dispatching', 'running', 'waiting_report', 'verifying'])
const READINESS_STATUSES = new Set<ExecutionStepRuntime['status']>(['pending', 'waiting_dependency', 'ready'])

export interface ExecutionSchedulePlan {
  valid: boolean
  errors: readonly string[]
  activeCount: number
  capacity: number
  dispatchableStepIds: readonly string[]
  dependencyReadyStepIds: readonly string[]
  waitingStepIds: readonly string[]
}

export function validateExecutionDag(steps: readonly ExecutionStepDefinition[]): readonly string[] {
  const errors: string[] = []
  const byId = new Map<string, ExecutionStepDefinition>()
  for (const step of steps) {
    if (byId.has(step.stepId)) errors.push(`duplicate step id ${step.stepId}`)
    else byId.set(step.stepId, step)
  }
  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      if (dependencyId === step.stepId) errors.push(`${step.stepId} cannot depend on itself`)
      else if (!byId.has(dependencyId)) errors.push(`${step.stepId} depends on unknown step ${dependencyId}`)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stepId: string, path: readonly string[]) => {
    if (visited.has(stepId)) return
    if (visiting.has(stepId)) {
      const start = path.indexOf(stepId)
      errors.push(`cycle detected: ${[...path.slice(Math.max(0, start)), stepId].join(' -> ')}`)
      return
    }
    visiting.add(stepId)
    const step = byId.get(stepId)
    if (step) for (const dependency of step.dependsOn) if (byId.has(dependency)) visit(dependency, [...path, stepId])
    visiting.delete(stepId)
    visited.add(stepId)
  }
  for (const step of steps) visit(step.stepId, [])
  return [...new Set(errors)].sort()
}

export function dependencyReady(
  step: ExecutionStepDefinition,
  runtimes: ReadonlyMap<string, ExecutionStepRuntime>
): boolean {
  return step.dependsOn.every(dependencyId => runtimes.get(dependencyId)?.status === 'completed')
}

export function planExecutionSchedule(input: {
  steps: readonly ExecutionStepDefinition[]
  runtimes: readonly ExecutionStepRuntime[]
  maxParallelSteps: number
}): ExecutionSchedulePlan {
  const errors = [...validateExecutionDag(input.steps)]
  const runtimeById = new Map(input.runtimes.map(runtime => [runtime.stepId, runtime] as const))
  for (const step of input.steps) {
    const runtime = runtimeById.get(step.stepId)
    if (!runtime) errors.push(`runtime missing for step ${step.stepId}`)
    else if (runtime.taskId !== step.taskId) errors.push(`runtime task mismatch for step ${step.stepId}`)
  }
  for (const runtime of input.runtimes) if (!input.steps.some(step => step.stepId === runtime.stepId)) errors.push(`orphan runtime ${runtime.stepId}`)
  if (!Number.isInteger(input.maxParallelSteps) || input.maxParallelSteps < 1) errors.push('maxParallelSteps must be a positive integer')
  if (errors.length > 0) {
    return { valid: false, errors: [...new Set(errors)].sort(), activeCount: 0, capacity: 0, dispatchableStepIds: [], dependencyReadyStepIds: [], waitingStepIds: [] }
  }

  const activeCount = input.runtimes.filter(runtime => ACTIVE_STATUSES.has(runtime.status)).length
  const capacity = Math.max(0, input.maxParallelSteps - activeCount)
  const dependencyReadyStepIds: string[] = []
  const waitingStepIds: string[] = []
  for (const step of input.steps) {
    const runtime = runtimeById.get(step.stepId)!
    if (!READINESS_STATUSES.has(runtime.status)) continue
    if (dependencyReady(step, runtimeById)) dependencyReadyStepIds.push(step.stepId)
    else waitingStepIds.push(step.stepId)
  }
  const dispatchableStepIds = dependencyReadyStepIds
    .filter(stepId => runtimeById.get(stepId)?.status === 'ready')
    .slice(0, capacity)
  return { valid: true, errors: [], activeCount, capacity, dispatchableStepIds, dependencyReadyStepIds, waitingStepIds }
}

export function computeTaskProgress(runtimes: readonly ExecutionStepRuntime[]): number {
  if (runtimes.length === 0) return 0
  const total = runtimes.reduce((sum, runtime) => sum + (runtime.status === 'completed' ? 1 : Math.max(0, Math.min(1, runtime.progress))), 0)
  return Math.round((total / runtimes.length) * 10_000) / 10_000
}

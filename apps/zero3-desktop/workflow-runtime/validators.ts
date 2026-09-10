import type { WorkflowRunPlan, WorkflowStageDefinition } from './contracts.ts'

export function validateWorkflowStageDag(stages: readonly WorkflowStageDefinition[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const stage of stages) {
    if (!stage.stageId.trim()) errors.push('stageId is required')
    else if (ids.has(stage.stageId)) errors.push(`duplicate stageId: ${stage.stageId}`)
    ids.add(stage.stageId)
  }
  for (const stage of stages) {
    if (stage.dependsOn.includes(stage.stageId)) errors.push(`stage ${stage.stageId} depends on itself`)
    for (const dependency of stage.dependsOn) if (!ids.has(dependency)) errors.push(`stage ${stage.stageId} depends on unknown stage ${dependency}`)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(stages.map(stage => [stage.stageId, stage] as const))
  const visit = (stageId: string, trail: string[]): void => {
    if (visiting.has(stageId)) {
      errors.push(`stage cycle detected: ${[...trail, stageId].join(' -> ')}`)
      return
    }
    if (visited.has(stageId)) return
    visiting.add(stageId)
    for (const dependency of byId.get(stageId)?.dependsOn ?? []) visit(dependency, [...trail, stageId])
    visiting.delete(stageId)
    visited.add(stageId)
  }
  for (const stage of stages) visit(stage.stageId, [])
  return [...new Set(errors)]
}

export function validateWorkflowRunPlan(plan: WorkflowRunPlan): string[] {
  const errors = validateWorkflowStageDag(plan.stages)
  if (!plan.workflowRunId.trim()) errors.push('workflowRunId is required')
  if (!plan.moduleId.trim() || !plan.moduleVersion.trim()) errors.push('module identity is required')
  if (!plan.projectId.trim()) errors.push('projectId is required')
  if (plan.items.length === 0) errors.push('at least one WorkItem is required')

  const workerIds = new Set<string>()
  for (const worker of plan.workers) {
    if (workerIds.has(worker.workerDefinitionId)) errors.push(`duplicate workerDefinitionId: ${worker.workerDefinitionId}`)
    workerIds.add(worker.workerDefinitionId)
    if (!Number.isSafeInteger(worker.concurrency) || worker.concurrency < 1 || worker.concurrency > 32) errors.push(`worker ${worker.workerDefinitionId} concurrency must be 1..32`)
  }
  const stageIds = new Set(plan.stages.map(stage => stage.stageId))
  for (const stage of plan.stages) {
    if (stage.workerDefinitionId && !workerIds.has(stage.workerDefinitionId)) errors.push(`stage ${stage.stageId} references unknown worker ${stage.workerDefinitionId}`)
    const worker = plan.workers.find(value => value.workerDefinitionId === stage.workerDefinitionId)
    if (worker && worker.executor !== stage.executor) errors.push(`stage ${stage.stageId} executor does not match worker ${worker.workerDefinitionId}`)
    if (!Number.isSafeInteger(stage.maxAttempts) || stage.maxAttempts < 1 || stage.maxAttempts > 100) errors.push(`stage ${stage.stageId} maxAttempts must be 1..100`)
  }

  const itemIds = new Set<string>()
  for (const item of plan.items) {
    if (itemIds.has(item.itemId)) errors.push(`duplicate WorkItem id: ${item.itemId}`)
    itemIds.add(item.itemId)
    for (const stageId of item.completedStageIds ?? []) if (!stageIds.has(stageId)) errors.push(`WorkItem ${item.itemId} completed unknown stage ${stageId}`)
    for (const artifact of item.initialArtifacts ?? []) if (!stageIds.has(artifact.stageId)) errors.push(`WorkItem ${item.itemId} artifact references unknown stage ${artifact.stageId}`)
  }
  return [...new Set(errors)]
}

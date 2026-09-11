import { randomUUID } from 'node:crypto'

import type { CreateExecutionTaskInput } from '../runtime.ts'
import { bugFixWorkflow } from './bug-fix.ts'
import type { TaskWorkflowCreateInput, TaskWorkflowModule, TaskWorkflowSummary } from './contracts.ts'
import { genericTaskWorkflow } from './generic-task.ts'
import { researchWorkflow } from './research.ts'
import { softwareDevelopmentWorkflow } from './software-development.ts'

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is invalid`)
  return text
}

function optionalId(value: string | null | undefined, label: string): string | null {
  if (value == null) return null
  const text = value.trim()
  if (!ID_RE.test(text)) throw new Error(`${label} is invalid`)
  return text
}

export class Zero3TaskWorkflowRegistry {
  private readonly modules = new Map<string, TaskWorkflowModule>()

  constructor(modules: readonly TaskWorkflowModule[]) {
    for (const module of modules) {
      const id = requiredText(module.summary.id, 'workflow id', 256)
      if (!ID_RE.test(id)) throw new Error(`workflow id is invalid: ${id}`)
      if (this.modules.has(id)) throw new Error(`duplicate task workflow: ${id}`)
      this.modules.set(id, module)
    }
    if (!this.modules.size) throw new Error('at least one task workflow is required')
  }

  list(): TaskWorkflowSummary[] {
    return [...this.modules.values()].map(module => ({ ...module.summary }))
  }

  compile(inputValue: TaskWorkflowCreateInput): CreateExecutionTaskInput {
    const input: TaskWorkflowCreateInput = {
      title: requiredText(inputValue.title, 'task title', 512),
      description: requiredText(inputValue.description, 'task description', 16_384),
      projectId: optionalId(inputValue.projectId, 'projectId'),
      workspace: inputValue.workspace?.trim() || null,
      workflowId: requiredText(inputValue.workflowId, 'workflowId', 256)
    }
    const module = this.modules.get(input.workflowId)
    if (!module) throw new Error(`unknown task workflow: ${input.workflowId}`)
    const plan = module.compile(input)
    if (!Number.isInteger(plan.maxParallelSteps) || plan.maxParallelSteps < 1 || plan.maxParallelSteps > 256) {
      throw new Error(`workflow ${input.workflowId} has invalid parallel capacity`)
    }
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) throw new Error(`workflow ${input.workflowId} has no steps`)
    const keys = new Set<string>()
    for (const step of plan.steps) {
      const key = requiredText(step.key, 'workflow step key', 128)
      if (!ID_RE.test(key) || keys.has(key)) throw new Error(`workflow ${input.workflowId} has invalid or duplicate step key: ${key}`)
      keys.add(key)
    }
    for (const step of plan.steps) {
      for (const dependency of step.dependsOn ?? []) {
        if (!keys.has(dependency)) throw new Error(`workflow ${input.workflowId} has unknown dependency: ${dependency}`)
      }
    }
    const taskId = `task-${randomUUID()}`
    return {
      task: {
        taskId,
        projectId: input.projectId,
        workspace: input.workspace ?? null,
        title: input.title,
        goal: input.description,
        workflowId: input.workflowId,
        maxParallelSteps: plan.maxParallelSteps,
        createdBySessionId: null,
        metadata: {
          source: 'task-workflow',
          workflowId: input.workflowId,
          workflowRevision: module.summary.revision,
          workflowName: module.summary.name,
          ...(plan.metadata ?? {})
        }
      },
      steps: plan.steps.map(step => ({
        stepId: `wf-${step.key}`,
        title: step.title,
        objective: step.objective,
        executor: step.executor,
        dependsOn: (step.dependsOn ?? []).map(key => `wf-${key}`),
        requiredSkills: [...(step.requiredSkills ?? [])],
        optionalSkills: [...(step.optionalSkills ?? [])],
        inputArtifacts: [],
        expectedOutputs: [...(step.expectedOutputs ?? [])],
        completionGate: [...(step.completionGate ?? [])],
        maxAttempts: step.maxAttempts ?? 3,
        metadata: { workflowStepKey: step.key, ...(step.metadata ?? {}) }
      }))
    }
  }
}

export function createDefaultTaskWorkflowRegistry(): Zero3TaskWorkflowRegistry {
  return new Zero3TaskWorkflowRegistry([
    genericTaskWorkflow,
    softwareDevelopmentWorkflow,
    bugFixWorkflow,
    researchWorkflow
  ])
}

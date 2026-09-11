import type { TaskWorkflowModule } from './contracts.ts'

export const genericTaskWorkflow: TaskWorkflowModule = {
  summary: { id: 'generic-task', name: '通用任务', description: '适合未匹配专用 SOP 的任务，由 Zero3 自动路由执行。', category: '通用', revision: 1 },
  compile(input) {
    return {
      maxParallelSteps: 1,
      metadata: { workflowKind: 'generic-task' },
      steps: [{
        key: 'execute', title: '执行任务', objective: input.description, executor: 'AUTO',
        completionGate: ['human_review'], maxAttempts: 3, metadata: { workflowRole: 'execute' }
      }]
    }
  }
}

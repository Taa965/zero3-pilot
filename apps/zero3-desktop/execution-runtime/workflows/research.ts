import type { TaskWorkflowModule } from './contracts.ts'

export const researchWorkflow: TaskWorkflowModule = {
  summary: { id: 'research', name: '调研工作流', description: '明确问题、收集证据、综合分析并输出可执行结论。', category: '研究', revision: 1 },
  compile(input) {
    return {
      maxParallelSteps: 1, metadata: { workflowKind: 'research' },
      steps: [
        { key: 'scope', title: '明确调研问题', objective: `界定问题、约束和输出标准：${input.description}`, executor: 'AUTO', maxAttempts: 2 },
        { key: 'research', title: '收集与核验信息', objective: '收集相关资料并核验关键事实，保留来源和不确定性。', executor: 'AUTO', dependsOn: ['scope'], maxAttempts: 3 },
        { key: 'synthesize', title: '综合分析', objective: '归纳证据、比较方案并形成结论与建议，提交结果审核。', executor: 'AUTO', dependsOn: ['research'], completionGate: ['human_review'], maxAttempts: 2 }
      ]
    }
  }
}

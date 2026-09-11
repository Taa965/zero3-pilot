import type { TaskWorkflowModule } from './contracts.ts'

export const bugFixWorkflow: TaskWorkflowModule = {
  summary: { id: 'bug-fix', name: 'Bug 修复工作流', description: '定位根因、实施修复、回归验证并完成审核。', category: '开发', revision: 1 },
  compile(input) {
    return {
      maxParallelSteps: 1, metadata: { workflowKind: 'bug-fix' },
      steps: [
        { key: 'diagnose', title: '定位根因', objective: `分析并定位问题根因：${input.description}`, executor: 'AUTO', optionalSkills: ['debugging'], maxAttempts: 2 },
        { key: 'implement', title: '实施修复', objective: '根据根因完成最小且正确的修复，避免引入无关改动。', executor: 'AUTO', dependsOn: ['diagnose'], maxAttempts: 3 },
        { key: 'verify', title: '回归验证', objective: '执行与改动范围匹配的静态检查、测试和回归验证，并提交审核。', executor: 'AUTO', dependsOn: ['implement'], completionGate: ['human_review'], maxAttempts: 2 }
      ]
    }
  }
}

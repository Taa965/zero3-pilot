import type { TaskWorkflowModule } from './contracts.ts'

export const softwareDevelopmentWorkflow: TaskWorkflowModule = {
  summary: { id: 'software-development', name: '软件开发工作流', description: '方案确认、实现、验证、交付审核的标准开发 SOP。', category: '开发', revision: 1 },
  compile(input) {
    return {
      maxParallelSteps: 1, metadata: { workflowKind: 'software-development' },
      steps: [
        { key: 'plan', title: '方案与影响分析', objective: `理解需求并形成实施方案：${input.description}`, executor: 'AUTO', maxAttempts: 2 },
        { key: 'implement', title: '实现变更', objective: '按方案完成代码、配置与必要文档变更。', executor: 'AUTO', dependsOn: ['plan'], maxAttempts: 3 },
        { key: 'verify', title: '静态检查与回归', objective: '完成类型、编译、测试及架构门禁验证，并提交交付审核。', executor: 'AUTO', dependsOn: ['implement'], completionGate: ['human_review'], maxAttempts: 2 }
      ]
    }
  }
}

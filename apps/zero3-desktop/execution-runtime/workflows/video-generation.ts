import type { TaskWorkflowModule } from './contracts.ts'

export const VIDEO_GENERATION_WORKFLOW_ID = 'video-generation-v1'

export const videoGenerationWorkflow: TaskWorkflowModule = {
  summary: {
    id: VIDEO_GENERATION_WORKFLOW_ID,
    name: '视频生成任务',
    description: '脚本重构、视觉规划、批量出图、云端 GPU/Remotion、剪映工程与最终验证的标准生产流程。需要项目生产配置与原始脚本，第一步「生产输入与项目配置」由人工在任务看板登记。',
    category: '内容生产',
    revision: 1,
    requiresProductionProfile: true
  },
  compile(input) {
    const description = input.description.trim()
    return {
      maxParallelSteps: 1,
      metadata: {
        workflowKind: 'video-generation',
        workflowWorkerModuleId: 'video-generation',
        sourceOfTruth: 'execution-task',
        requiresProductionProfile: true
      },
      steps: [
        {
          key: 'intake', title: '生产输入与项目配置',
          objective: `绑定项目组、生产配置与一个或多个原始脚本：${description}`,
          executor: 'HUMAN',
          expectedOutputs: [{ logicalName: 'video-production-inputs.json', kind: 'json', mimeType: 'application/json', required: true }],
          completionGate: ['required_outputs'], maxAttempts: 2,
          metadata: { workflowPhase: 'intake' }
        },
        {
          key: 'rewrite', title: '脚本重构',
          objective: '为每个脚本创建受项目约束的 GPT Web 工位，并调用脚本 Skill 生成重构稿。',
          executor: 'ZERO3', dependsOn: ['intake'],
          expectedOutputs: [{ logicalName: 'rewrite-manifest.json', kind: 'json', mimeType: 'application/json', required: true }],
          maxAttempts: 3, metadata: { workflowPhase: 'rewrite', executionStrategy: 'workflow-worker' }
        },
        {
          key: 'visual', title: '视觉构建',
          objective: '调用视觉 Skill 生成可读视觉方案、机器可读视觉计划以及 Remotion35 云端执行交接包。',
          executor: 'ZERO3', dependsOn: ['rewrite'],
          expectedOutputs: [{ logicalName: 'visual-plan-manifest.json', kind: 'json', mimeType: 'application/json', required: true }],
          maxAttempts: 3, metadata: { workflowPhase: 'visual', executionStrategy: 'workflow-worker' }
        },
        {
          key: 'plan-production', title: '解析分镜与生产计划',
          objective: '解析 zero3.visual-plan.v1，校验分镜并按最多 10 张图片一个批次生成稳定生产计划。',
          executor: 'ZERO3', dependsOn: ['visual'],
          expectedOutputs: [{ logicalName: 'production-plan.json', kind: 'json', mimeType: 'application/json', required: true }],
          maxAttempts: 2, metadata: { workflowPhase: 'production-plan' }
        },
        {
          key: 'image-production', title: '图片生产',
          objective: '按 Shot ID 和稳定批次生成全部静态图与图生视频首帧，缺图只补缺失 Shot。',
          executor: 'ZERO3', dependsOn: ['plan-production'],
          expectedOutputs: [{ logicalName: 'image-production-manifest.json', kind: 'json', mimeType: 'application/json', required: true }],
          maxAttempts: 3, metadata: { workflowPhase: 'image-production', executionStrategy: 'workflow-worker' }
        },
        {
          key: 'cloud-production', title: 'GPU / Remotion 云端生产',
          objective: '校验并执行图生视频与 Remotion 交接包，防重复提交，等待云端完成并拉回产物。',
          executor: 'ZERO3', dependsOn: ['image-production'],
          expectedOutputs: [{ logicalName: 'cloud-production-manifest.json', kind: 'json', mimeType: 'application/json', required: true }],
          maxAttempts: 3, metadata: { workflowPhase: 'cloud-production', executionStrategy: 'host-capability' }
        },
        {
          key: 'jianying', title: '生成剪映工程',
          objective: '依据视觉方案与全部已验证素材生成可打开的剪映工程。',
          executor: 'ZERO3', dependsOn: ['cloud-production'],
          expectedOutputs: [{ logicalName: 'jianying-project-manifest.json', kind: 'json', mimeType: 'application/json', required: true }],
          maxAttempts: 3, metadata: { workflowPhase: 'jianying', executionStrategy: 'host-capability' }
        },
        {
          key: 'final-verify', title: '最终生产验证',
          objective: '核对分镜覆盖、必需产物、未解决阻塞与工程完整性，通过后完成任务。',
          executor: 'ZERO3', dependsOn: ['jianying'], completionGate: ['required_outputs', 'human_review'],
          expectedOutputs: [{ logicalName: 'production-manifest.json', kind: 'json', mimeType: 'application/json', required: true }],
          maxAttempts: 2, metadata: { workflowPhase: 'final-verification' }
        }
      ]
    }
  }
}
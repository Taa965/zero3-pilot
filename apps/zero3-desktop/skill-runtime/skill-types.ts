export type Zero3SkillBindingTargetType = 'agent' | 'workflow' | 'task-template'
export type Zero3SkillSelectionSource =
  | 'explicit'
  | 'agent-binding'
  | 'workflow-binding'
  | 'task-template-binding'
  | 'router'

export type Zero3NativeSkillMetadata = {
  name: string
  description: string
  path: string
  scope: string
  enabled: boolean
  displayName: string | null
  shortDescription: string | null
  pluginId: string | null
}

export type Zero3SkillBinding = {
  bindingId: string
  targetType: Zero3SkillBindingTargetType
  targetId: string
  skillName: string
  skillPath: string
  enabled: boolean
  autoInvoke: boolean
  priority: number
  createdAt: string
  updatedAt: string
}

export type Zero3ResolvedTaskSkill = {
  name: string
  path: string
  scope: string
  description: string
  source: Zero3SkillSelectionSource
  priority: number
}

export type Zero3SkillUsageRecord = {
  usageId: string
  taskId: string
  executionId: string
  projectId: string
  workflowId: string | null
  target: string
  skillName: string
  skillPath: string
  source: Zero3SkillSelectionSource
  outcome: 'selected' | 'completed' | 'failed'
  latencyMs: number | null
  at: string
}

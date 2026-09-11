import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3SkillRouter } from './skill-router.ts'

const task = {
  taskId: 'task-1', executionId: 'exec-1', projectId: 'project-1', target: 'CODEX', type: 'IMPLEMENT',
  title: '认知便利店脚本重构', goal: '使用认知便利店作者方法重构知识视频脚本', contextVersion: 1,
  workflowId: 'workflow-script', skillSelectors: ['explicit-skill'], requirements: ['保留事实纪律'], constraints: [],
  requiredContracts: [], inputArtifacts: [], expectedOutputs: [], verification: [], completionGate: [],
  reviewPolicy: { required: false, reviewer: 'CODEX' }, createdBySessionId: 'session-1', createdAt: new Date().toISOString()
} as any

const skills = [
  { name: 'explicit-skill', description: '显式', path: '/skills/explicit/SKILL.md', scope: 'user', enabled: true, displayName: null, shortDescription: null, pluginId: null },
  { name: 'author-skill', description: '认知便利店作者脚本与事实纪律', path: '/skills/author/SKILL.md', scope: 'user', enabled: true, displayName: '认知便利店', shortDescription: null, pluginId: null },
  { name: 'workflow-skill', description: 'script workflow', path: '/skills/workflow/SKILL.md', scope: 'repo', enabled: true, displayName: null, shortDescription: null, pluginId: null },
  { name: 'unrelated', description: 'database migration', path: '/skills/unrelated/SKILL.md', scope: 'user', enabled: true, displayName: null, shortDescription: null, pluginId: null }
]

const bindings = [
  { bindingId: 'a', targetType: 'agent', targetId: 'CODEX', skillName: 'author-skill', skillPath: '/skills/author/SKILL.md', enabled: true, autoInvoke: true, priority: 10, createdAt: '', updatedAt: '' },
  { bindingId: 'w', targetType: 'workflow', targetId: 'workflow-script', skillName: 'workflow-skill', skillPath: '/skills/workflow/SKILL.md', enabled: true, autoInvoke: true, priority: 5, createdAt: '', updatedAt: '' }
] as any

test('router combines explicit selectors and matching bindings without duplicates', () => {
  const result = new Zero3SkillRouter().resolve({ task, target: 'CODEX', skills, bindings, topN: 2 })
  assert.equal(result[0]?.name, 'explicit-skill')
  assert.equal(result.filter(item => item.name === 'author-skill').length, 1)
  assert.equal(result.filter(item => item.name === 'workflow-skill').length, 1)
  assert.equal(result.some(item => item.name === 'unrelated'), false)
  assert.equal(result.find(item => item.name === 'author-skill')?.source, 'agent-binding')
  assert.equal(result.find(item => item.name === 'workflow-skill')?.source, 'workflow-binding')
})

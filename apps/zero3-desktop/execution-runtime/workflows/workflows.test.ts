import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createExecutionDesktopRuntime } from '../desktop/desktop-runtime.ts'
import { createDefaultTaskWorkflowRegistry, Zero3TaskWorkflowRegistry } from './registry.ts'

test('default task workflows compile user intent into authoritative execution steps', () => {
  const registry = createDefaultTaskWorkflowRegistry()
  assert.deepEqual(registry.list().map(item => item.id), [
    'generic-task', 'software-development', 'bug-fix', 'research'
  ])
  const input = registry.compile({
    title: '修复输入框锁死',
    description: '复现并修复 GPT 输入框锁死，完成回归验证。',
    projectId: 'project-1',
    workspace: 'C:/repo',
    workflowId: 'bug-fix'
  })
  assert.equal(input.task.workflowId, 'bug-fix')
  assert.equal(input.task.goal, '复现并修复 GPT 输入框锁死，完成回归验证。')
  assert.equal(input.task.metadata.workflowName, 'Bug 修复工作流')
  assert.equal(input.task.metadata.source, 'task-workflow')
  assert.deepEqual(input.steps.map(step => step.stepId), [
    'wf-diagnose', 'wf-implement', 'wf-verify'
  ])
  assert.deepEqual(input.steps[1].dependsOn, ['wf-diagnose'])
  assert.deepEqual(input.steps[2].dependsOn, ['wf-implement'])
  assert.equal(input.steps[2].executor, 'AUTO')
  assert.deepEqual(input.steps[2].completionGate, ['human_review'])
})

test('workflow registry rejects unknown workflows and invalid module graphs', () => {
  const registry = createDefaultTaskWorkflowRegistry()
  assert.throws(() => registry.compile({
    title: 'x', description: 'y', projectId: null, workflowId: 'missing'
  }), /unknown task workflow/)
  const broken = new Zero3TaskWorkflowRegistry([{
    summary: { id: 'broken', name: 'broken', description: 'broken', category: 'test', revision: 1 },
    compile: () => ({
      maxParallelSteps: 1,
      steps: [{ key: 'only', title: 'only', objective: 'only', executor: 'AUTO', dependsOn: ['missing'] }]
    })
  }])
  assert.throws(() => broken.compile({
    title: 'x', description: 'y', projectId: null, workflowId: 'broken'
  }), /unknown dependency/)
})
test('desktop task service persists workflow-generated tasks without exposing step drafting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zero3-task-workflow-'))
  const desktop = createExecutionDesktopRuntime(root, {
    reporterClientPath: path.resolve('apps/zero3-desktop/execution-runtime/zero3-exec.mjs'),
    reporterClientKind: 'node'
  })
  try {
    const workflows = await desktop.listTaskWorkflows() as Array<{ id: string }>
    assert.equal(workflows.some(item => item.id === 'software-development'), true)
    const created = await desktop.createWorkflowTask({
      title: '实现任务工作流入口',
      description: '只提交任务说明，由模块生成执行计划。',
      projectId: 'project-1',
      workflowId: 'software-development'
    }) as any
    assert.equal(created.definition.task.workflowId, 'software-development')
    assert.equal(created.definition.steps.length, 3)
    assert.equal(created.definition.steps[0].title, '方案与影响分析')
    const [persisted] = await desktop.listTasks() as any[]
    assert.equal(persisted.definition.task.taskId, created.definition.task.taskId)
  } finally {
    await desktop.stop()
    await rm(root, { recursive: true, force: true })
  }
})

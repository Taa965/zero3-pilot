import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Zero3ExecutionRuntime } from '../execution-runtime/runtime.ts'
import { Zero3ExecutionStore } from '../execution-runtime/store.ts'
import { makeStep, makeTask, matchesTask, requiredOutputGaps } from '../ui-v2/tasks/task-model.ts'
import { readTaskSnapshots, readTaskWorkflows } from '../ui-v2/tasks/TaskAdapter.ts'

async function withRuntime(run: (runtime: Zero3ExecutionRuntime, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-task-ui-'))
  try { await run(new Zero3ExecutionRuntime(new Zero3ExecutionStore(dir)), dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}
test('task UI payload persists and review/filter projections follow real step state across restart', async () => {
  await withRuntime(async (runtime, dir) => {
    const first = makeStep('实现变更', 'CODEX')
    const second = makeStep('发布检查', 'HUMAN', [first.stepId])
    const input = makeTask('交付任务', '完成两个步骤', 'project-1', [first, second])
    const id = input.task.taskId
    await runtime.createTask(input)
    await runtime.createAssignment(id, first.stepId, 'CODEX')
    await runtime.transitionStep(id, first.stepId, 'verifying')
    let snapshot = await runtime.snapshot(id)
    assert.equal(matchesTask(snapshot, 'review', '交付', 'project-1'), true)
    assert.equal(matchesTask(snapshot, 'review', '', 'project-2'), false)
    assert.equal(matchesTask(snapshot, 'completed', '', ''), false)
    await runtime.gateFailed(id, first.stepId, '缺少测试')
    snapshot = await runtime.snapshot(id)
    assert.equal(matchesTask(snapshot, 'error', '', ''), true)
    await runtime.transitionStep(id, first.stepId, 'verifying')
    await runtime.gatePassed(id, first.stepId, { source: 'human_task_review', note: '测试记录已核对', assignmentId: snapshot.runtime.steps[0].assignmentId })
    await runtime.createAssignment(id, second.stepId, 'HUMAN')
    await runtime.transitionStep(id, second.stepId, 'verifying')
    await runtime.gatePassed(id, second.stepId, { note: '人工检查完成' })
    const restored = readTaskSnapshots([await new Zero3ExecutionRuntime(new Zero3ExecutionStore(dir)).snapshot(id)])[0]
    assert.equal(restored.runtime.task.status, 'completed')
    assert.equal(matchesTask(restored, 'completed', '', ''), true)
    assert.equal(restored.events.filter(event => event.type === 'gate.passed').length, 2)
  })
})
test('assignment API enforces dependencies, capacity, executor, and completion authority', async () => {
  await withRuntime(async runtime => {
    const a = makeStep('a', 'CODEX'), b = makeStep('b', 'CODEX'), c = makeStep('c', 'CODEX', [a.stepId])
    const input = makeTask('test', 'test', null, [a, b, c])
    const id = input.task.taskId
    await runtime.createTask(input)
    await assert.rejects(runtime.createAssignment(id, a.stepId, 'GPT_WEB'), /executor/)
    await assert.rejects(runtime.transitionStep(id, c.stepId, 'ready'), /dependencies/)
    await assert.rejects(runtime.createAssignment(id, c.stepId, 'CODEX'), /not assignable/)
    await runtime.createAssignment(id, a.stepId, 'CODEX')
    await assert.rejects(runtime.createAssignment(id, b.stepId, 'CODEX'), /capacity/)
    await runtime.transitionStep(id, a.stepId, 'verifying')
    await assert.rejects(runtime.transitionStep(id, a.stepId, 'completed'), /gatePassed/)
    await runtime.gatePassed(id, a.stepId)
    await assert.rejects(runtime.gatePassed(id, a.stepId), /verifying/)
  })
})
test('human review requires current-attempt output evidence and rejects stale or empty approval', async () => {
  await withRuntime(async runtime => {
    const step = makeStep('deliver', 'CODEX')
    step.expectedOutputs = [{ logicalName: 'result.txt', required: true, minCount: 1 }]
    const input = makeTask('review', 'review', null, [step]), id = input.task.taskId
    await runtime.createTask(input)
    const first = await runtime.createAssignment(id, step.stepId, 'CODEX')
    await runtime.recordArtifact(id, step.stepId, { logicalName: 'result.txt', artifactId: 'old' })
    await runtime.transitionStep(id, step.stepId, 'verifying')
    await runtime.gateFailed(id, step.stepId, 'retry')
    const second = await runtime.createAssignment(id, step.stepId, 'CODEX')
    await runtime.transitionStep(id, step.stepId, 'verifying')
    assert.deepEqual(requiredOutputGaps(await runtime.snapshot(id), step.stepId), ['result.txt'])
    await assert.rejects(runtime.gatePassed(id, step.stepId, { source: 'human_task_review', note: 'ok', assignmentId: first.assignmentId }), /stale/)
    await assert.rejects(runtime.gatePassed(id, step.stepId, { source: 'human_task_review', note: ' ', assignmentId: second.assignmentId }), /evidence/)
    await assert.rejects(runtime.gatePassed(id, step.stepId, { source: 'human_task_review', note: 'ok', assignmentId: second.assignmentId }), /missing required output/)
    await runtime.recordArtifact(id, step.stepId, { logicalName: 'result.txt', artifactId: 'new' })
    assert.deepEqual(requiredOutputGaps(await runtime.snapshot(id), step.stepId), [])
    await runtime.gatePassed(id, step.stepId, { source: 'human_task_review', note: '已核对产物', assignmentId: second.assignmentId })
  })
})
test('cancelling all steps closes the task with a durable event', async () => {
  await withRuntime(async runtime => {
    const a = makeStep('a', 'CODEX'), b = makeStep('b', 'CODEX', [a.stepId])
    const input = makeTask('cancel', 'cancel', null, [a, b]), id = input.task.taskId
    await runtime.createTask(input)
    await runtime.transitionStep(id, a.stepId, 'cancelled', '用户取消')
    const snapshot = await runtime.transitionStep(id, b.stepId, 'cancelled', '用户取消')
    assert.equal(snapshot.runtime.task.status, 'cancelled')
    assert.equal(snapshot.events.at(-1)?.payload?.to, 'cancelled')
  })
})
test('invalid task form and incompatible bridge data fail explicitly', () => {
  assert.throws(() => makeTask(' ', 'goal', null, []), /请填写/)
  assert.throws(() => makeStep(' ', 'CODEX'), /请填写/)
  assert.throws(() => readTaskSnapshots({ tasks: [] }), /无效/)
  assert.throws(() => readTaskSnapshots([{}]), /不完整/)
  assert.deepEqual(readTaskSnapshots([]), [])
})

test('resuming a paused assignment respects capacity and submits an auditable completion request', async () => {
  await withRuntime(async runtime => {
    const a = makeStep('a', 'CODEX'), b = makeStep('b', 'CODEX')
    const input = makeTask('resume', 'resume', null, [a, b]), id = input.task.taskId
    await runtime.createTask(input)
    await runtime.createAssignment(id, a.stepId, 'CODEX')
    await runtime.transitionStep(id, a.stepId, 'waiting_human', '确认范围')
    await runtime.createAssignment(id, b.stepId, 'CODEX')
    await assert.rejects(runtime.transitionStep(id, a.stepId, 'running'), /capacity/)
    await assert.rejects(runtime.transitionStep(id, a.stepId, 'verifying'), /capacity/)
    await runtime.transitionStep(id, b.stepId, 'cancelled', '不再需要')
    await runtime.transitionStep(id, a.stepId, 'running', '范围已确认')
    const review = await runtime.transitionStep(id, a.stepId, 'verifying', '人工提交审核依据')
    assert.equal(review.events.at(-1)?.type, 'completion.requested')
    assert.equal(review.events.at(-1)?.payload?.reason, '人工提交审核依据')
    const result = await runtime.gatePassed(id, a.stepId)
    assert.equal(result.runtime.task.status, 'cancelled')
  })
})

test('task workflow adapter accepts registry summaries and rejects malformed data', () => {
  assert.deepEqual(readTaskWorkflows([{
    id: 'generic-task', name: 'Generic', description: 'Generic workflow', category: 'test', revision: 1
  }]).map(item => item.id), ['generic-task'])
  assert.throws(() => readTaskWorkflows({ workflows: [] }), /无效列表/)
  assert.throws(() => readTaskWorkflows([{ id: 'bad' }]), /不完整/)
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ZERO3_EXECUTION_EVENT,
  Zero3ExecutionRuntime,
  Zero3ExecutionStore,
  ExecutionStateTransitionError,
  assertStepTransition,
  planExecutionSchedule,
  validateExecutionDag,
  type ExecutionStepDefinition
} from './index.ts'

async function withRuntime(run: (runtime: Zero3ExecutionRuntime, store: Zero3ExecutionStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-execution-'))
  try {
    const store = new Zero3ExecutionStore(dir)
    await run(new Zero3ExecutionRuntime(store), store)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

function step(stepId: string, dependsOn: readonly string[] = [], executor: ExecutionStepDefinition['executor'] = 'GPT_WEB') {
  return {
    stepId,
    title: stepId,
    objective: `execute ${stepId}`,
    executor,
    dependsOn,
    inputArtifacts: [],
    expectedOutputs: [],
    completionGate: ['required_outputs'],
    maxAttempts: 3,
    metadata: {}
  }
}

function taskInput(steps: ReturnType<typeof step>[], maxParallelSteps = 2) {
  return {
    task: {
      taskId: 'video-001',
      projectId: 'zero3',
      title: '资本论视频生产',
      goal: '从脚本重构一直执行到视频生成',
      workflowId: 'cognitive-store-video-v1',
      maxParallelSteps,
      createdBySessionId: 'gpt-origin',
      metadata: {}
    },
    steps
  }
}

test('completion must pass through verifying instead of executor self-completing', () => {
  assert.throws(() => assertStepTransition('running', 'completed'), ExecutionStateTransitionError)
  assert.doesNotThrow(() => assertStepTransition('running', 'verifying'))
  assert.doesNotThrow(() => assertStepTransition('verifying', 'completed'))
})

test('scheduler validates DAGs and enforces cross-app concurrency capacity', async () => {
  await withRuntime(async runtime => {
    const created = await runtime.createTask(taskInput([step('a'), step('b'), step('c')], 2))
    const invalid = [
      { ...created.definition.steps[0], dependsOn: ['c'] },
      created.definition.steps[1],
      { ...created.definition.steps[2], dependsOn: ['a'] }
    ]
    assert.ok(validateExecutionDag(invalid).some(error => error.includes('cycle detected')))

    const firstPlan = planExecutionSchedule({
      steps: created.definition.steps,
      runtimes: created.runtime.steps,
      maxParallelSteps: 2
    })
    assert.deepEqual(firstPlan.dispatchableStepIds, ['a', 'b'])

    await runtime.createAssignment('video-001', 'a', 'GPT_WEB')
    const after = await runtime.snapshot('video-001')
    const secondPlan = planExecutionSchedule({ steps: after.definition.steps, runtimes: after.runtime.steps, maxParallelSteps: 2 })
    assert.equal(secondPlan.activeCount, 1)
    assert.equal(secondPlan.capacity, 1)
    assert.deepEqual(secondPlan.dispatchableStepIds, ['b'])
  })
})

test('video workflow crosses GPT Web and Codex with durable session bindings and completion gates', async () => {
  await withRuntime(async (runtime, store) => {
    const created = await runtime.createTask(taskInput([
      step('script-rewrite'),
      step('visual-plan', ['script-rewrite']),
      step('video-render', ['visual-plan'], 'CODEX')
    ]))
    assert.equal(created.runtime.steps.find(item => item.stepId === 'script-rewrite')?.status, 'ready')
    assert.equal(created.runtime.steps.find(item => item.stepId === 'visual-plan')?.status, 'waiting_dependency')

    const script = await runtime.createAssignment('video-001', 'script-rewrite', 'GPT_WEB')
    await runtime.bindSession(script.assignmentId, {
      logicalSessionId: 'gpt-web-script',
      conversationUrl: 'https://chatgpt.com/c/script'
    })
    await runtime.transitionStep('video-001', 'script-rewrite', 'running')
    await runtime.recordProgress('video-001', 'script-rewrite', 0.7, '正在重构脚本')
    await runtime.recordArtifact('video-001', 'script-rewrite', { logicalName: '资本论.md', artifactId: 'artifact-script' })
    await runtime.requestCompletion('video-001', 'script-rewrite')
    const afterScript = await runtime.gatePassed('video-001', 'script-rewrite', { requiredOutputs: true })
    assert.equal(afterScript.runtime.steps.find(item => item.stepId === 'visual-plan')?.status, 'ready')

    const visual = await runtime.createAssignment('video-001', 'visual-plan', 'GPT_WEB')
    await runtime.bindSession(visual.assignmentId, { logicalSessionId: 'gpt-web-visual' })
    await runtime.transitionStep('video-001', 'visual-plan', 'running')
    await runtime.requestCompletion('video-001', 'visual-plan')
    const rejected = await runtime.gateFailed('video-001', 'visual-plan', '缺少逐条完整提示词.md')
    assert.equal(rejected.runtime.steps.find(item => item.stepId === 'visual-plan')?.status, 'fix_required')

    const visualRetry = await runtime.createAssignment('video-001', 'visual-plan', 'GPT_WEB')
    assert.equal(visualRetry.attempt, 2)
    await runtime.bindSession(visualRetry.assignmentId, { logicalSessionId: 'gpt-web-visual-retry' })
    await runtime.transitionStep('video-001', 'visual-plan', 'running')
    await runtime.recordArtifact('video-001', 'visual-plan', { logicalName: '导演审片单.md' })
    await runtime.recordArtifact('video-001', 'visual-plan', { logicalName: '逐条完整提示词.md' })
    await runtime.requestCompletion('video-001', 'visual-plan')
    const afterVisual = await runtime.gatePassed('video-001', 'visual-plan')
    assert.equal(afterVisual.runtime.steps.find(item => item.stepId === 'video-render')?.status, 'ready')

    const render = await runtime.createAssignment('video-001', 'video-render', 'CODEX', 'codex-local')
    await runtime.bindSession(render.assignmentId, { logicalSessionId: 'codex-video-render', runtimeConversationId: 'thread-1' })
    await runtime.transitionStep('video-001', 'video-render', 'running')
    await runtime.requestCompletion('video-001', 'video-render')
    const finished = await runtime.gatePassed('video-001', 'video-render', { finalVideo: 'final.mp4' })
    assert.equal(finished.runtime.task.status, 'completed')
    assert.equal(finished.runtime.task.progress, 1)
    assert.equal(finished.runtime.sessionBindings.length, 4)
    assert.ok(finished.events.some(event => event.type === 'task.completed'))

    const reconciliation = await store.reconcile('video-001')
    assert.equal(reconciliation.needsSemanticReplay, false)
    assert.equal(reconciliation.eventCount, finished.runtime.task.lastEventSequence)
  })
})

test('dynamic DAG expansion is revisioned and event ledger exposes crash-replay gaps', async () => {
  await withRuntime(async (runtime, store) => {
    await runtime.createTask(taskInput([step('plan')]))
    await runtime.createAssignment('video-001', 'plan', 'GPT_WEB')
    await runtime.transitionStep('video-001', 'plan', 'running')

    const expanded = await runtime.addSteps('video-001', [
      step('image-batch-01', ['plan']),
      step('image-batch-02', ['plan'])
    ])
    assert.equal(expanded.definition.revision, 2)
    assert.equal(expanded.runtime.steps.find(item => item.stepId === 'image-batch-01')?.status, 'waiting_dependency')

    await runtime.requestCompletion('video-001', 'plan')
    const released = await runtime.gatePassed('video-001', 'plan')
    assert.equal(released.runtime.steps.find(item => item.stepId === 'image-batch-01')?.status, 'ready')
    assert.equal(released.runtime.task.status, 'running')

    const nextSequence = released.events.length + 1
    await store.appendEvent({
      contract: ZERO3_EXECUTION_EVENT,
      eventId: 'simulated-after-crash',
      sequence: nextSequence,
      taskId: 'video-001',
      stepId: 'image-batch-01',
      type: 'progress.updated',
      payload: { progress: 0.1 },
      at: '2026-09-10T00:00:00.000Z'
    })
    const reconcile = await store.reconcile('video-001')
    assert.equal(reconcile.needsSemanticReplay, true)
    assert.equal(reconcile.eventCount, reconcile.stateEventSequence + 1)
  })
})

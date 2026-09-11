import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Zero3ArtifactReferenceStore } from '../../artifact-runtime/artifact-reference-store.ts'
import { Zero3ExecutionRuntime } from '../../execution-runtime/runtime.ts'
import { Zero3ExecutionStore } from '../../execution-runtime/store.ts'
import { Zero3AgentLifecycleRuntime, type LifecycleMemoryPort } from './lifecycle-runtime.ts'
import { Zero3AgentLifecycleStore } from './lifecycle-store.ts'

class FakeMemory implements LifecycleMemoryPort {
  failPublish = false
  sequence = 0
  entities: any[] = []
  events = new Map<string, any>()

  async getProject(projectId: string) {
    return { projectId, version: this.sequence, payload: { policies: [] }, sync: { last_sequence: this.sequence, stale: false }, entities: structuredClone(this.entities) }
  }

  async publish(event: any) {
    if (this.failPublish) throw new Error('simulated memory outage')
    const existingEvent = this.events.get(event.event_id)
    if (existingEvent) return existingEvent
    const key = `${event.memory.class}:${event.scope.task_id ?? ''}:${event.memory.entity_type}:${event.memory.entity_id}`
    const index = this.entities.findIndex(entity => entity._key === key)
    const current = index >= 0 ? this.entities[index] : null
    const currentVersion = current?.version ?? 0
    if (event.memory.expected_entity_version !== currentVersion) throw new Error('memory version conflict')
    this.sequence += 1
    const entity = {
      _key: key,
      entity_id: event.memory.entity_id,
      entity_type: event.memory.entity_type,
      memory_class: event.memory.class,
      task_id: event.scope.task_id ?? null,
      version: currentVersion + 1,
      authority: event.memory.authority,
      content: structuredClone(event.payload),
      updated_sequence: this.sequence
    }
    if (index >= 0) this.entities[index] = entity
    else this.entities.push(entity)
    const result = { state: 'acked', server_sequence: this.sequence }
    this.events.set(event.event_id, result)
    return result
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zero3-lifecycle-'))
  const execution = new Zero3ExecutionRuntime(new Zero3ExecutionStore(join(root, 'execution')))
  const lifecycleStore = new Zero3AgentLifecycleStore(join(root, 'lifecycle.sqlite3'))
  const artifactStore = new Zero3ArtifactReferenceStore(join(root, 'artifacts'))
  const memory = new FakeMemory()
  const port = {
    listTasks: async () => Promise.all((await execution.store.listTaskIds()).map(taskId => execution.snapshot(taskId))),
    getTask: (taskId: string) => execution.snapshot(taskId),
    createTask: (input: any) => execution.createTask(input),
    createAssignment: (taskId: string, stepId: string, executor: 'GPT_WEB', executorId?: string | null) => execution.createAssignment(taskId, stepId, executor, executorId),
    bindSession: (assignmentId: string, input: any) => execution.bindSession(assignmentId, input),
    recordProgress: (taskId: string, stepId: string, progress: number, currentActivity?: string | null, identity?: any) => execution.recordProgress(taskId, stepId, progress, currentActivity, identity),
    recordArtifact: (taskId: string, stepId: string, artifact: any, identity?: any) => execution.recordArtifact(taskId, stepId, artifact, identity),
    requestCompletion: (taskId: string, stepId: string, identity?: any) => execution.requestCompletion(taskId, stepId, identity),
    updateSessionState: (taskId: string, bindingId: string, state: any) => execution.updateSessionBindingState(taskId, bindingId, state),
    transitionStep: (taskId: string, stepId: string, status: any, reason?: string) => execution.transitionStep(taskId, stepId, status, reason)
  }
  const runtime = new Zero3AgentLifecycleRuntime(lifecycleStore, port, artifactStore as any, {
    memoryForProject: async () => memory
  })
  return { root, execution, lifecycleStore, artifactStore, memory, runtime }
}

async function cleanup(value: Fixture) {
  value.lifecycleStore.close()
  await rm(value.root, { recursive: true, force: true })
}

async function createTask(value: Fixture, taskId = 'task-1', twoSteps = false) {
  await value.execution.createTask({
    task: {
      taskId, projectId: 'project-1', title: taskId, goal: 'Shared agent lifecycle test', workflowId: 'workflow-1',
      maxParallelSteps: 1, createdBySessionId: null, metadata: { agentClaimMode: 'exclusive' }
    },
    steps: [
      {
        stepId: 'script-1', title: 'Script 1', objective: 'Produce script 1', executor: 'GPT_WEB', dependsOn: [],
        inputArtifacts: [], expectedOutputs: [{ logicalName: 'script_01.md', kind: 'markdown', required: true }],
        completionGate: ['required_outputs'], maxAttempts: 3, metadata: {}
      },
      ...(twoSteps ? [{
        stepId: 'script-2', title: 'Script 2', objective: 'Produce script 2', executor: 'GPT_WEB', dependsOn: ['script-1'],
        inputArtifacts: [], expectedOutputs: [{ logicalName: 'script_02.md', kind: 'markdown', required: true }],
        completionGate: ['required_outputs'], maxAttempts: 3, metadata: {}
      }] : [])
    ]
  })
}

async function startAndClaim(value: Fixture, sessionId: string, taskId = 'task-1') {
  const started = await value.runtime.sessionStart({
    agent_type: 'web_gpt', session_id: sessionId, project_id: 'project-1', task_id: taskId,
    idempotency_key: `start-${sessionId}`
  })
  const claimed = await value.runtime.taskClaim({ session_id: sessionId, task_id: taskId, idempotency_key: `claim-${sessionId}` })
  return { started, claimed }
}

function artifactInput(sessionId: string, key = `artifact-${sessionId}`) {
  return {
    session_id: sessionId, artifact_id: `art-${sessionId}`, type: 'file', name: 'script_01.md', kind: 'markdown',
    storage: { provider: 'google_drive', file_id: `drive-${sessionId}` },
    description: 'rewritten script', status: 'approved', idempotency_key: key
  }
}

test('Case 1: a fresh GPT session resolves prior agent completion, artifact, worklog and next task step', async () => {
  const value = await fixture()
  try {
    await createTask(value, 'task-1', true)
    await startAndClaim(value, 'gpt-a')
    await value.runtime.artifactRegister(artifactInput('gpt-a'))
    const completed = await value.runtime.taskComplete({
      session_id: 'gpt-a', summary: '脚本1已经完成', recommended_next_actions: ['处理脚本2'], idempotency_key: 'complete-a'
    })
    assert.equal(completed.state, 'COMPLETION_REQUESTED')
    assert.equal(completed.executionStepStatus, 'verifying')
    await value.execution.gatePassed('task-1', 'script-1', { artifacts: ['art-gpt-a'] })

    await value.runtime.sessionStart({ agent_type: 'web_gpt', session_id: 'gpt-b', project_id: 'project-1', task_id: 'task-1', idempotency_key: 'start-b' })
    const context = await value.runtime.contextResolve({ session_id: 'gpt-b' })
    assert.equal((context.artifacts[0] as any).logicalName, 'script_01.md')
    assert.ok(context.worklog.some(entry => entry.sessionId === 'gpt-a' && entry.eventType === 'task.complete'))
    assert.ok(context.upstreamResults.some((entry: any) => entry.content?.summary === '脚本1已经完成'))
    assert.ok(context.nextActions.some((entry: any) => typeof entry === 'object' && entry.stepId === 'script-2'))
  } finally { await cleanup(value) }
})

test('Case 2: a project decision recorded by GPT-A is visible to GPT-B without chat history', async () => {
  const value = await fixture()
  try {
    await createTask(value)
    await startAndClaim(value, 'gpt-a')
    await value.runtime.eventRecord({
      session_id: 'gpt-a', event_type: 'decision', scope: 'project', importance: 'high',
      content: { text: '项目统一改为16:9' }, idempotency_key: 'decision-16x9'
    })
    await value.runtime.sessionStart({ agent_type: 'web_gpt', session_id: 'gpt-b', project_id: 'project-1', task_id: 'task-1', idempotency_key: 'start-b' })
    const context = await value.runtime.contextResolve({ session_id: 'gpt-b' })
    assert.ok(context.decisions.some((entry: any) => entry.content?.text === '项目统一改为16:9'))
  } finally { await cleanup(value) }
})

test('Case 3: memory failure yields COMPLETED_WITH_WARNINGS and a durable compensation outbox', async () => {
  const value = await fixture()
  try {
    await createTask(value)
    await startAndClaim(value, 'gpt-a')
    await value.runtime.artifactRegister(artifactInput('gpt-a'))
    value.memory.failPublish = true
    const result = await value.runtime.taskComplete({
      session_id: 'gpt-a', summary: '完成但记忆服务暂时故障', decisions: ['保持16:9'], idempotency_key: 'complete-memory-fail'
    })
    assert.equal(result.state, 'COMPLETED_WITH_WARNINGS')
    assert.ok((result.warnings as string[]).some(item => item.includes('memory commit pending')))
    assert.ok(value.lifecycleStore.memoryOutboxPending('task-1').length >= 2)
    assert.equal(result.executionStepStatus, 'verifying')
    value.memory.failPublish = false
    const recovered = await value.runtime.contextResolve({ session_id: 'gpt-a' })
    assert.equal(value.lifecycleStore.memoryOutboxPending('task-1').length, 0)
    assert.ok(recovered.decisions.some((entry: any) => entry.content?.text === '保持16:9'))
    assert.ok(recovered.upstreamResults.some((entry: any) => entry.content?.summary === '完成但记忆服务暂时故障'))
  } finally { await cleanup(value) }
})

test('Case 4: artifact.register retried three times creates one logical artifact', async () => {
  const value = await fixture()
  try {
    await createTask(value)
    await startAndClaim(value, 'gpt-a')
    const input = artifactInput('gpt-a', 'same-artifact-key')
    const one = await value.runtime.artifactRegister(input)
    const two = await value.runtime.artifactRegister(input)
    const three = await value.runtime.artifactRegister(input)
    assert.equal((one.artifact as any).artifactId, (two.artifact as any).artifactId)
    assert.equal((two.artifact as any).artifactId, (three.artifact as any).artifactId)
    assert.equal((await value.artifactStore.list('task-1')).length, 1)
  } finally { await cleanup(value) }
})

test('Case 5: interrupted GPT-A releases the Execution step and GPT-B reclaims with shared state intact', async () => {
  const value = await fixture()
  try {
    await createTask(value)
    await startAndClaim(value, 'gpt-a')
    await value.runtime.eventRecord({
      session_id: 'gpt-a', event_type: 'decision', importance: 'high', content: { text: 'A留下的Decision' }, idempotency_key: 'a-decision'
    })
    await value.runtime.artifactRegister(artifactInput('gpt-a'))
    await value.runtime.sessionInterrupt({ session_id: 'gpt-a', reason: 'browser closed' })

    await value.runtime.sessionStart({ agent_type: 'web_gpt', session_id: 'gpt-b', project_id: 'project-1', task_id: 'task-1', idempotency_key: 'start-b' })
    const context = await value.runtime.contextResolve({ session_id: 'gpt-b' })
    assert.ok(context.worklog.some(entry => entry.sessionId === 'gpt-a' && entry.eventType === 'session.interrupted'))
    assert.equal((context.artifacts[0] as any).logicalName, 'script_01.md')
    assert.ok(context.decisions.some((entry: any) => entry.content?.text === 'A留下的Decision'))

    const reclaimed = await value.runtime.taskClaim({ session_id: 'gpt-b', idempotency_key: 'claim-b' })
    assert.equal(reclaimed.state, 'CLAIMED')
    assert.equal((reclaimed.claim as any).stepId, 'script-1')
    const snapshot = await value.execution.snapshot('task-1')
    assert.equal(snapshot.runtime.steps[0].attempt, 2)
    assert.equal(snapshot.runtime.steps[0].status, 'running')
  } finally { await cleanup(value) }
})

test('task.complete can atomically register supplied artifacts before completion validation', async () => {
  const value = await fixture()
  try {
    await createTask(value)
    await startAndClaim(value, 'gpt-a')
    const result = await value.runtime.taskComplete({
      session_id: 'gpt-a', summary: 'complete with bundled artifact',
      artifacts: [{
        artifact_id: 'art-bundled', name: 'script_01.md', kind: 'markdown',
        storage: { provider: 'google_drive', file_id: 'drive-bundled' }, status: 'approved'
      }],
      idempotency_key: 'complete-with-artifact'
    })
    assert.equal(result.state, 'COMPLETION_REQUESTED')
    const artifacts = await value.artifactStore.list('task-1')
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].artifactId, 'art-bundled')
    assert.equal(artifacts[0].logicalName, 'script_01.md')
  } finally { await cleanup(value) }
})

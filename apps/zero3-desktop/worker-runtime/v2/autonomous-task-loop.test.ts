import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createExecutionDesktopRuntime } from '../../execution-runtime/desktop/desktop-runtime.ts'
import type { ExecutionExecutorTarget, ExecutionSkillPreflight } from '../../execution-runtime/contracts.ts'
import { Zero3AgentLifecycleRuntime } from './lifecycle-runtime.ts'
import { Zero3AgentLifecycleStore } from './lifecycle-store.ts'
import { ZERO3_AUTONOMOUS_TASK_LOOP, Zero3AutonomousTaskLoop } from './autonomous-task-loop.ts'

const PROJECT_ID = 'project-1'

type MemoryEntity = Record<string, unknown>

class FakeMemory {
  readonly context: { entities: MemoryEntity[]; sync: { last_sequence: number } }
  readonly published: Record<string, unknown>[] = []
  constructor(entities: MemoryEntity[] = []) {
    this.context = { entities: structuredClone(entities), sync: { last_sequence: 1 } }
  }
  async getProject(_projectId: string): Promise<unknown> { return structuredClone(this.context) }
  async publish(event: Record<string, unknown>): Promise<{ accepted: true }> {
    this.published.push(structuredClone(event))
    const memory = event.memory as Record<string, unknown>
    const scope = event.scope as Record<string, unknown>
    if (memory?.entity_type === 'task_outcome') {
      const existing = this.context.entities.find(entity =>
        entity.memory_class === memory.class && entity.task_id === scope.task_id
        && entity.entity_type === memory.entity_type && entity.entity_id === memory.entity_id
      )
      const version = Number(memory.expected_entity_version ?? 0) + 1
      const replacement: MemoryEntity = {
        memory_class: memory.class,
        task_id: scope.task_id,
        entity_type: memory.entity_type,
        entity_id: memory.entity_id,
        version,
        content: structuredClone(event.payload as Record<string, unknown>)
      }
      if (existing) Object.assign(existing, replacement)
      else this.context.entities.push(replacement)
      this.context.sync.last_sequence += 1
    }
    return { accepted: true }
  }
}

function memoryEntity(entityType: string, content: Record<string, unknown>, id = `entity-${entityType}`): MemoryEntity {
  return { memory_class: 'project', entity_type: entityType, entity_id: id, version: 1, content }
}

function intakeRows(h: Harness): Array<{ source_key: string; task_id: string | null; fingerprint: string; source_version: number }> {
  return h.store.db.prepare('SELECT source_key,task_id,fingerprint,source_version FROM autonomous_task_intake')
    .all() as any as Array<{ source_key: string; task_id: string | null; fingerprint: string; source_version: number }>
}

function skillPreflight(step: any): ExecutionSkillPreflight {
  const required = [...(step.requiredSkills ?? [])]
  const optional = [...(step.optionalSkills ?? [])]
  const missingRequiredSkills = required.filter(skill => skill === 'missing')
  const target = (step.executor === 'AUTO' ? 'GPT_WEB' : step.executor) as Exclude<ExecutionExecutorTarget, 'AUTO'>
  return {
    state: required.length || optional.length ? (missingRequiredSkills.length ? 'blocked' : 'ready') : 'not_required',
    executor: target,
    adapterMode: target === 'GPT_WEB' ? 'web-mcp' : target === 'CODEX' || target === 'ZERO3' ? 'native' : 'instruction-adapter',
    requiredSkills: required,
    optionalSkills: optional,
    availableRequiredSkills: required.filter(skill => !missingRequiredSkills.includes(skill)),
    availableOptionalSkills: optional,
    missingRequiredSkills,
    missingOptionalSkills: [],
    checkedAt: new Date().toISOString()
  }
}

type Harness = Awaited<ReturnType<typeof makeHarness>>

async function makeHarness(entities: MemoryEntity[] = [], options: { autoDispatch?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'zero3-auto-loop-'))
  const memory = new FakeMemory(entities)
  const execution = createExecutionDesktopRuntime(path.join(root, 'execution'), {
    reporterClientPath: path.resolve('apps/zero3-desktop/execution-runtime/zero3-exec.mjs'),
    reporterClientKind: 'node',
    skillCapabilityProvider: {
      preflight: async (_task, step) => skillPreflight(step),
      matrix: async () => ({ agents: [] })
    }
  })
  const storeFile = path.join(root, 'agent-lifecycle.sqlite3')
  const store = new Zero3AgentLifecycleStore(storeFile)
  const gpt = {
    created: [] as string[],
    wakeups: [] as Array<{ id: string; message: string }>,
    async create(_projectId?: string | null) {
      const id = `gpt-session-${this.created.length + 1}`
      this.created.push(id)
      return { id, conversationUrl: `https://chatgpt.local/${id}` }
    },
    async sendWakeup(id: string, message: string) {
      this.wakeups.push({ id, message })
      return { sent: true as const }
    }
  }
  const lifecycle = new Zero3AgentLifecycleRuntime(
    store,
    {
      listTasks: async () => await execution.listTasks() as any[],
      getTask: taskId => execution.getTask(taskId),
      refreshSkillPreflight: taskId => execution.refreshSkillPreflight(taskId) as any,
      createTask: input => execution.createTask(input as any),
      createAssignment: (taskId, stepId, executor, executorId) => execution.createAssignment(taskId, stepId, executor, executorId),
      bindSession: (assignmentId, input) => execution.bindSession(assignmentId, input as any),
      recordProgress: (taskId, stepId, progress, activity, identity) => execution.runtime.recordProgress(taskId, stepId, progress, activity, identity),
      recordArtifact: (taskId, stepId, artifact, identity) => execution.runtime.recordArtifact(taskId, stepId, artifact, identity),
      requestCompletion: (taskId, stepId, identity) => execution.runtime.requestCompletion(taskId, stepId, identity),
      updateSessionState: (taskId, bindingId, state) => execution.updateSessionState(taskId, bindingId, state),
      transitionStep: (taskId, stepId, status, reason) => execution.transitionStep(taskId, stepId, status as any, reason)
    },
    {
      register: async input => ({ ...input }),
      list: async () => [],
      get: async () => null
    },
    { memoryForProject: async () => memory }
  )
  const loopPorts = {
    projects: { list: async () => [{ id: PROJECT_ID, rootPath: root }] },
    memoryForProject: async () => memory,
    execution: {
      listTasks: async () => await execution.listTasks() as any[],
      getTask: async (taskId: string) => await execution.getTask(taskId) as any,
      createTask: async (input: Record<string, unknown>) => await execution.createTask(input as any) as any,
      refreshSkillPreflight: (taskId: string) => execution.refreshSkillPreflight(taskId),
      reconcileReadiness: async (taskId: string) => await execution.reconcileReadiness(taskId) as any,
      transitionStep: async (taskId: string, stepId: string, status: string, reason?: string) => await execution.transitionStep(taskId, stepId, status as any, reason) as any,
      transitionTask: async (taskId: string, status: string, reason?: string) => await execution.runtime.transitionTask(taskId, status as any, reason) as any
    },
    lifecycle: {
      sessionStart: (input: Record<string, unknown>) => lifecycle.sessionStart(input) as any,
      taskClaim: (input: Record<string, unknown>) => lifecycle.taskClaim(input) as any
    },
    gpt
  }
  const makeLoop = (targetStore = store, autoDispatch = options.autoDispatch ?? false) => new Zero3AutonomousTaskLoop(
    targetStore,
    loopPorts,
    { enabled: true, autoDispatch, clock: () => new Date('2026-09-11T08:00:00.000Z') }
  )
  const loop = makeLoop()
  return { root, memory, execution, storeFile, store, gpt, lifecycle, loopPorts, loop, makeLoop }
}

async function cleanup(h: Harness, closeStore = true): Promise<void> {
  h.loop.stop()
  if (closeStore) h.store.close()
  await new Promise(resolve => setTimeout(resolve, 25))
  await rm(h.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
}

test('task-worthy memory intake is durable and duplicate/restart replay creates only one task', async () => {
  const h = await makeHarness([
    memoryEntity('problem', { title: '输入框锁死', message: 'GPT 执行时输入框长期锁死', executor: 'GPT_WEB' }),
    memoryEntity('decision', { text: 'This is context, not work.' }),
    memoryEntity('task_outcome', { origin: ZERO3_AUTONOMOUS_TASK_LOOP, state: 'blocked' }, 'loop-outcome')
  ])
  try {
    await h.loop.tick()
    await h.loop.tick()
    assert.equal((await h.execution.listTasks() as any[]).length, 1)
    const task = (await h.execution.listTasks() as any[])[0]
    assert.equal(task.definition.task.metadata.autonomousTaskLoop, ZERO3_AUTONOMOUS_TASK_LOOP)
    assert.equal(task.definition.task.projectId, PROJECT_ID)

    h.loop.stop()
    h.store.close()
    const reopened = new Zero3AgentLifecycleStore(h.storeFile)
    const replayLoop = h.makeLoop(reopened, false)
    await replayLoop.tick()
    replayLoop.stop()
    reopened.close()
    assert.equal((await h.execution.listTasks() as any[]).length, 1)
  } finally {
    await cleanup(h, false)
  }
})

test('unrelated canonical memory is ignored by fail-closed intake', async () => {
  const h = await makeHarness([
    memoryEntity('decision', { text: 'Use typed RPC.' }),
    memoryEntity('discovery', { text: 'A useful fact.' }),
    memoryEntity('project_memory', { text: 'Generic project context.' })
  ])
  try {
    await h.loop.tick()
    assert.equal((await h.execution.listTasks() as any[]).length, 0)
  } finally { await cleanup(h) }
})

test('entity detail updates keep one task and stale versions never regress intake state', async () => {
  const h = await makeHarness([
    memoryEntity('problem', { title: 'GPT 输入框锁死', message: 'v1 观察', executor: 'GPT_WEB' }, 'problem-versioned')
  ])
  try {
    await h.loop.tick()
    const created = await h.execution.listTasks() as any[]
    assert.equal(created.length, 1)
    const taskId = created[0].definition.task.taskId
    assert.equal(intakeRows(h).length, 1)
    assert.equal(intakeRows(h)[0].source_version, 1)
    assert.equal(intakeRows(h)[0].task_id, taskId)

    const entity = h.memory.context.entities[0]
    entity.version = 2
    entity.content = { title: 'GPT 输入框锁死', message: 'v2 更详细的问题描述', executor: 'GPT_WEB' }
    await h.loop.tick()
    const updated = await h.execution.listTasks() as any[]
    assert.equal(updated.length, 1)
    assert.equal(updated[0].definition.task.taskId, taskId)
    assert.equal(intakeRows(h).length, 1)
    assert.equal(intakeRows(h)[0].source_version, 2)
    assert.equal(intakeRows(h)[0].task_id, taskId)

    // An older version arriving later (offline cache / out-of-order sync) must not rewrite newer state.
    entity.version = 1
    entity.content = { title: 'GPT 输入框锁死', message: 'v1 观察', executor: 'GPT_WEB' }
    await h.loop.tick()
    assert.equal((await h.execution.listTasks() as any[]).length, 1)
    assert.equal(intakeRows(h)[0].source_version, 2)
    assert.equal(intakeRows(h)[0].task_id, taskId)
  } finally { await cleanup(h) }
})

test('cross-source semantic dedupe links one task for the same structured problem', async () => {
  const h = await makeHarness([
    memoryEntity('problem', { title: 'GPT 输入框锁死', message: 'Agent A 观察到输入框锁死', executor: 'GPT_WEB', observedBy: 'agent-a', sessionId: 'sess-a' }, 'problem-agent-a'),
    memoryEntity('problem', { problem: 'GPT 输入框锁死', description: 'Agent B 复现同一问题', executor: 'GPT_WEB', observedBy: 'agent-b', sessionId: 'sess-b' }, 'problem-agent-b')
  ])
  try {
    await h.loop.tick()
    await h.loop.tick()
    const tasks = await h.execution.listTasks() as any[]
    assert.equal(tasks.length, 1)
    const rows = intakeRows(h)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].fingerprint, rows[1].fingerprint)
    assert.notEqual(rows[0].source_key, rows[1].source_key)
    assert.equal(rows[0].task_id, tasks[0].definition.task.taskId)
    assert.equal(rows[1].task_id, tasks[0].definition.task.taskId)
  } finally { await cleanup(h) }
})

test('semantic dedupe never merges unrelated problems or ambiguous short statements', async () => {
  const h = await makeHarness([
    memoryEntity('problem', { title: 'GPT 输入框锁死', message: 'GPT 输入框锁死' }, 'problem-input-locked'),
    memoryEntity('problem', { title: 'GitHub push 权限失败', message: 'GitHub push 403' }, 'problem-push-denied'),
    memoryEntity('problem', { title: '超时', message: '超时' }, 'problem-short-a'),
    memoryEntity('problem', { title: '超时', message: '超时' }, 'problem-short-b')
  ])
  try {
    await h.loop.tick()
    await h.loop.tick()
    const tasks = await h.execution.listTasks() as any[]
    assert.equal(tasks.length, 4)
    assert.equal(new Set(tasks.map(task => task.definition.task.taskId)).size, 4)
    const rows = intakeRows(h)
    assert.equal(rows.length, 4)
    // The two ambiguous short statements share a detail fingerprint but must stay two separate
    // tasks: identity dedupe only, never a semantic merge on a low-information statement.
    assert.equal(new Set(rows.map(row => row.task_id)).size, 4)
    assert.equal(new Set(rows.map(row => row.source_key)).size, 4)
  } finally { await cleanup(h) }
})

test('autonomous loop self-generated memory can never re-enter intake', async () => {
  const h = await makeHarness([
    memoryEntity('problem', { title: 'Follow-up discovered by the loop', origin: ZERO3_AUTONOMOUS_TASK_LOOP, executor: 'GPT_WEB' }, 'loop-self-problem'),
    memoryEntity('blocker', { title: 'Another loop artifact', source_origin: ZERO3_AUTONOMOUS_TASK_LOOP, executor: 'GPT_WEB' }, 'loop-self-blocker'),
    memoryEntity('task_outcome', { state: 'waiting_human', origin: ZERO3_AUTONOMOUS_TASK_LOOP }, 'loop-self-outcome'),
    {
      memory_class: 'task', task_id: 'auto-task-00000000000000000000000000000000',
      entity_type: 'problem', entity_id: 'loop-self-source-ref', version: 1,
      content: { title: 'Loop reported problem', executor: 'GPT_WEB' },
      source: { type: 'system', ref: 'auto-task-00000000000000000000000000000000' }
    }
  ])
  try {
    await h.loop.tick()
    await h.loop.tick()
    assert.equal((await h.execution.listTasks() as any[]).length, 0)
    assert.equal(intakeRows(h).length, 0)
    assert.equal(h.gpt.created.length, 0)
  } finally { await cleanup(h) }
})

test('GPT_WEB autonomous dispatch uses lifecycle claim once and never double-assigns on repeated ticks', async () => {
  const h = await makeHarness([
    memoryEntity('problem', { title: 'Recover timeout session', message: 'Rotate a stuck GPT conversation', executor: 'GPT_WEB' })
  ], { autoDispatch: true })
  try {
    await h.loop.tick()
    await h.loop.tick()
    const tasks = await h.execution.listTasks() as any[]
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].runtime.assignments.length, 1)
    assert.equal(tasks[0].runtime.sessionBindings.length, 1)
    assert.equal(tasks[0].runtime.steps[0].status, 'running')
    assert.equal(h.gpt.created.length, 1)
    assert.equal(h.gpt.wakeups.length, 1)
    assert.match(h.gpt.wakeups[0].message, /Do not create a duplicate task/)
  } finally { await cleanup(h) }
})

test('Skill blocking prevents dispatch before lifecycle claim', async () => {
  const h = await makeHarness([
    memoryEntity('problem', { title: 'Needs unavailable skill', requiredSkills: ['missing'] })
  ], { autoDispatch: true })
  try {
    await h.loop.tick()
    const task = (await h.execution.listTasks() as any[])[0]
    assert.equal(task.runtime.assignments.length, 0)
    assert.equal(task.runtime.steps[0].status, 'ready')
    assert.equal(task.runtime.steps[0].skillPreflight.state, 'blocked')
    assert.match(task.runtime.steps[0].blocker, /Missing required Skills/)
    assert.equal(h.gpt.created.length, 0)
  } finally { await cleanup(h) }
})

test('dependency and parallel capacity keep later autonomous steps undispatched', async () => {
  const h = await makeHarness([], { autoDispatch: true })
  try {
    await h.execution.createTask({
      task: {
        taskId: 'auto-manual-dependency-test', projectId: PROJECT_ID, workspace: h.root,
        title: 'Dependency test', goal: 'Only first step may run', workflowId: 'autonomous-task-loop',
        maxParallelSteps: 1, createdBySessionId: null,
        metadata: { autonomousTaskLoop: ZERO3_AUTONOMOUS_TASK_LOOP }
      },
      steps: [
        { stepId: 'first', title: 'First', objective: 'First', executor: 'GPT_WEB', dependsOn: [], inputArtifacts: [], expectedOutputs: [], completionGate: ['human_review'], maxAttempts: 2, metadata: {} },
        { stepId: 'second', title: 'Second', objective: 'Second', executor: 'GPT_WEB', dependsOn: ['first'], inputArtifacts: [], expectedOutputs: [], completionGate: ['human_review'], maxAttempts: 2, metadata: {} }
      ]
    } as any)
    await h.loop.tick()
    await h.loop.tick()
    const task = await h.execution.getTask('auto-manual-dependency-test') as any
    assert.equal(task.runtime.assignments.length, 1)
    assert.equal(task.runtime.steps.find((step: any) => step.stepId === 'first').status, 'running')
    assert.equal(task.runtime.steps.find((step: any) => step.stepId === 'second').status, 'waiting_dependency')
    assert.equal(h.gpt.created.length, 1)
  } finally { await cleanup(h) }
})

test('unsupported executor fails closed, writes one outcome, and outcome memory cannot re-ingest', async () => {
  const h = await makeHarness([
    memoryEntity('blocker', { title: 'Needs native Codex', message: 'Requires a native code executor', executor: 'CODEX' })
  ], { autoDispatch: true })
  try {
    await h.loop.tick()
    await h.loop.tick()
    const tasks = await h.execution.listTasks() as any[]
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].runtime.assignments.length, 0)
    assert.equal(tasks[0].runtime.steps[0].status, 'waiting_human')
    assert.match(tasks[0].runtime.steps[0].blocker, /Post-plugin capability gate/)
    assert.match(h.store.listAutonomousIntakes(PROJECT_ID)[0].humanAttentionReason ?? '', /Post-plugin capability gate/)
    assert.equal(h.gpt.created.length, 0)
    assert.equal(h.memory.published.length, 1)
    const payload = h.memory.published[0].payload as Record<string, unknown>
    const memory = h.memory.published[0].memory as Record<string, unknown>
    assert.equal(payload.origin, ZERO3_AUTONOMOUS_TASK_LOOP)
    assert.equal(memory.entity_type, 'task_outcome')
    assert.equal((await h.execution.listTasks() as any[]).length, 1)
  } finally { await cleanup(h) }
})

test('terminal completion outcome writeback is idempotent across ticks', async () => {
  const h = await makeHarness([
    memoryEntity('work_item', { title: 'Complete one autonomous task', executor: 'GPT_WEB' })
  ], { autoDispatch: true })
  try {
    await h.loop.tick()
    const task = (await h.execution.listTasks() as any[])[0]
    const taskId = task.definition.task.taskId
    await h.execution.runtime.requestCompletion(taskId, 'auto-work')
    await h.execution.runtime.gatePassed(taskId, 'auto-work', { source: 'test-automatic-verification' })
    await h.loop.tick()
    await h.loop.tick()
    const completed = await h.execution.getTask(taskId) as any
    assert.equal(completed.runtime.task.status, 'completed')
    const completedEvents = h.memory.published.filter(event => event.event_type === 'task.completed')
    assert.equal(completedEvents.length, 1)
    assert.equal((completedEvents[0].payload as Record<string, unknown>).origin, ZERO3_AUTONOMOUS_TASK_LOOP)
  } finally { await cleanup(h) }
})


test('v1.3 warning governance defers without creating an Execution Task', async () => {
  const h = await makeHarness([
    memoryEntity('warning', { title: 'Minor layout warning', message: 'Button spacing is slightly off.' }, 'warning-defer')
  ])
  try {
    await h.loop.tick()
    assert.equal((await h.execution.listTasks() as any[]).length, 0)
    const intake = h.store.listAutonomousIntakes(PROJECT_ID)[0]
    assert.equal(intake.disposition, 'DEFER')
    assert.equal(intake.taskId, null)
  } finally { await cleanup(h) }
})

test('v1.3 blocking issue interrupts parent and creates one lineage-linked child task', async () => {
  const h = await makeHarness([])
  try {
    await h.execution.createTask({
      task: { taskId: 'root-task', projectId: PROJECT_ID, workspace: h.root, title: 'Root', goal: 'Finish root', workflowId: null,
        maxParallelSteps: 1, createdBySessionId: null, metadata: {} },
      steps: [{ stepId: 'root-step', title: 'Root step', objective: 'Continue root', executor: 'GPT_WEB', dependsOn: [],
        inputArtifacts: [], expectedOutputs: [], completionGate: ['human_review'], maxAttempts: 3, metadata: {} }]
    } as any)
    h.memory.context.entities.push({ memory_class: 'task', task_id: 'root-task', entity_type: 'blocker', entity_id: 'push-denied', version: 1,
      content: { title: 'Git push denied', message: 'origin/main permission denied', blocking: true, executor: 'GPT_WEB', affectedResources: ['repo:zero3-pilot'] } })
    await h.loop.tick()
    const tasks = await h.execution.listTasks() as any[]
    assert.equal(tasks.length, 2)
    const child = tasks.find(task => task.definition.task.taskId !== 'root-task')
    assert.equal(child.definition.task.metadata.autonomousLineage.rootTaskId, 'root-task')
    assert.equal(child.definition.task.metadata.autonomousLineage.parentTaskId, 'root-task')
    assert.equal(child.definition.task.metadata.autonomousLineage.resumeParentOnComplete, true)
    const parent = await h.execution.getTask('root-task') as any
    assert.equal(parent.runtime.task.status, 'blocked')
    assert.equal(parent.runtime.steps[0].status, 'blocked')
  } finally { await cleanup(h) }
})

test('v1.3 attention budget prevents recursive autonomous spawn', async () => {
  const h = await makeHarness([])
  try {
    await h.execution.createTask({
      task: { taskId: 'budget-parent', projectId: PROJECT_ID, workspace: h.root, title: 'Budget parent', goal: 'Do not recurse forever',
        workflowId: 'autonomous-task-loop', maxParallelSteps: 1, createdBySessionId: null,
        metadata: { autonomousTaskLoop: ZERO3_AUTONOMOUS_TASK_LOOP, autonomousLineage: { rootTaskId: 'budget-root', childDepth: 4 } } },
      steps: [{ stepId: 'parent-step', title: 'Parent', objective: 'Parent', executor: 'GPT_WEB', dependsOn: [], inputArtifacts: [],
        expectedOutputs: [], completionGate: ['human_review'], maxAttempts: 3, metadata: {} }]
    } as any)
    h.memory.context.entities.push({ memory_class: 'task', task_id: 'budget-parent', entity_type: 'problem', entity_id: 'recursive-problem', version: 1,
      content: { title: 'Nested issue', message: 'Would exceed child depth', requires_action: true, executor: 'GPT_WEB' } })
    await h.loop.tick()
    const tasks = await h.execution.listTasks() as any[]
    assert.equal(tasks.length, 1)
    const intake = h.store.listAutonomousIntakes(PROJECT_ID)[0]
    assert.equal(intake.disposition, 'DEFER')
    assert.match(intake.humanAttentionReason ?? '', /maxChildDepth/)
  } finally { await cleanup(h) }
})

test('v1.3 completed repair resumes blocked parent exactly once', async () => {
  const h = await makeHarness([])
  try {
    await h.execution.createTask({
      task: { taskId: 'resume-root', projectId: PROJECT_ID, workspace: h.root, title: 'Resume root', goal: 'Resume me', workflowId: null,
        maxParallelSteps: 1, createdBySessionId: null, metadata: {} },
      steps: [{ stepId: 'resume-step', title: 'Resume step', objective: 'Continue after repair', executor: 'GPT_WEB', dependsOn: [],
        inputArtifacts: [], expectedOutputs: [], completionGate: ['human_review'], maxAttempts: 3, metadata: {} }]
    } as any)
    h.memory.context.entities.push({ memory_class: 'task', task_id: 'resume-root', entity_type: 'blocker', entity_id: 'resume-blocker', version: 1,
      content: { title: 'Repair me', message: 'Blocking repair', blocking: true, executor: 'GPT_WEB' } })
    await h.loop.tick()
    const child = (await h.execution.listTasks() as any[]).find(task => task.definition.task.taskId !== 'resume-root')
    await h.execution.createAssignment(child.definition.task.taskId, 'auto-work', 'GPT_WEB', 'test-worker')
    await h.execution.runtime.requestCompletion(child.definition.task.taskId, 'auto-work')
    await h.execution.runtime.gatePassed(child.definition.task.taskId, 'auto-work', { source: 'test' })
    await h.loop.tick()
    await h.loop.tick()
    const parent = await h.execution.getTask('resume-root') as any
    assert.equal(parent.runtime.task.status, 'ready')
    assert.equal(parent.runtime.steps[0].status, 'ready')
    assert.equal(h.store.getParentResumeReceipt(child.definition.task.taskId)?.state, 'RESUMED')
    const readyEvents = parent.events.filter((event: any) => event.type === 'task.state_changed' && event.payload?.to === 'ready')
    assert.equal(readyEvents.length, 1)
  } finally { await cleanup(h) }
})

test('v1.3 guard event trigger and periodic reconciliation remain idempotent', async () => {
  const h = await makeHarness([])
  try {
    await h.loop.ingestGuardEvent({
      source: 'git', projectId: PROJECT_ID, eventRef: 'git-event-1', kind: 'push_failed',
      message: 'origin/main permission denied', blocking: true, affectedResources: ['repo:zero3-pilot']
    })
    await h.loop.tick()
    await h.loop.reconcileProjectNow(PROJECT_ID)
    const tasks = await h.execution.listTasks() as any[]
    assert.equal(tasks.length, 1)
    assert.equal(h.store.listAutonomousIntakes(PROJECT_ID).length, 1)
  } finally { await cleanup(h) }
})

test('v1.3 user Root Goal becomes one authoritative autonomous Execution Task', async () => {
  const h = await makeHarness([])
  try {
    const created = await h.loop.createGoal({ title: 'Ship autonomous goal', goal: 'Finish the requested objective end to end.', projectId: PROJECT_ID, importance: 'high', requiredCapabilities: ['software.development'] }) as any
    assert.equal(created.definition.task.metadata.autonomousRootGoal, true)
    assert.equal(created.definition.task.metadata.autonomousLineage.rootTaskId, created.definition.task.taskId)
    assert.equal(created.definition.steps[0].executor, 'AUTO')
    assert.deepEqual(created.definition.steps[0].metadata.requiredCapabilities, ['software.development'])
    assert.equal((await h.execution.listTasks() as any[]).length, 1)
  } finally { await cleanup(h) }
})

test('v1.3 autonomy dashboard projects attention, graph, review and plan from authorities', async () => {
  const h = await makeHarness([memoryEntity('warning', { title: 'Non blocking warning', message: 'Defer this.' })])
  try {
    await h.loop.tick()
    const dashboard = await h.loop.dashboard(PROJECT_ID) as any
    assert.equal(dashboard.projectId, PROJECT_ID)
    assert.ok(dashboard.executionGraph)
    assert.ok(dashboard.dailyReview)
    assert.ok(dashboard.plan)
    assert.ok(Array.isArray(dashboard.humanAttention))
  } finally { await cleanup(h) }
})

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Zero3ExecutionRuntime, Zero3ExecutionStore } from '../execution-runtime/index.ts'
import { createDefaultTaskWorkflowRegistry } from '../execution-runtime/workflows/registry.ts'
import type { ExecutionTaskSnapshot } from '../execution-runtime/contracts.ts'
import { Zero3WorkflowWorkerStore } from '../worker-runtime/v2/worker-store.ts'
import { Zero3WorkflowWorkerRuntime } from '../worker-runtime/v2/workflow-worker-runtime.ts'
import type { WorkflowArtifactRef } from '../worker-runtime/v2/contracts.ts'
import { imagePackageNames, rewriteOutputName, visualOutputNames } from './video-generation-prompts.ts'
import {
  BLOCKED_BY_EXTERNAL_CAPABILITY,
  VIDEO_PRODUCTION_INPUTS_SCHEMA,
  Zero3VideoGenerationTaskBridge,
  createLocalArtifactContentReader,
  type VideoGenerationHostCapabilityPort
} from './video-generation-task-bridge.ts'

const PROJECT_ID = 'project-1'
const SCRIPT_NAME = '博弈论'
const PRODUCTION_DATE = '2026-09-13'

type Harness = {
  dir: string
  execution: Zero3ExecutionRuntime
  store: Zero3ExecutionStore
  workerStore: Zero3WorkflowWorkerStore
  worker: Zero3WorkflowWorkerRuntime
  bridge: Zero3VideoGenerationTaskBridge
  hostCapability: VideoGenerationHostCapabilityPort
  hostResults: Array<{ capability: string; manifest: Record<string, unknown> }>
  taskId: string
  scriptPath: string
  close(): Promise<void>
}

async function harness(options: { hostCapability?: VideoGenerationHostCapabilityPort } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-video-bridge-'))
  const store = new Zero3ExecutionStore(dir)
  const execution = new Zero3ExecutionRuntime(store)
  const workerStore = new Zero3WorkflowWorkerStore(':memory:')
  const worker = new Zero3WorkflowWorkerRuntime(workerStore, { ticketSecret: 'zero3-video-bridge-test-secret-0123456789abcdef' })
  const scriptPath = join(dir, 'game-theory.txt')
  await writeFile(scriptPath, '第一集：什么是博弈论……', 'utf8')
  const hostResults: Array<{ capability: string; manifest: Record<string, unknown> }> = []
  const hostCapability: VideoGenerationHostCapabilityPort = options.hostCapability ?? {
    run: async input => {
      hostResults.push({ capability: input.capability, manifest: input.manifest })
      return {
        ok: true,
        manifest: { outputs: [{ name: `${input.capability}-result.zip`, storage: { provider: 'REMOTE_COMPUTE', uri: `remote://${input.capability}/result` } }] }
      }
    }
  }
  const bridge = new Zero3VideoGenerationTaskBridge({
    execution: {
      getTask: taskId => execution.snapshot(taskId),
      createAssignment: (taskId, stepId, executor, executorId) => execution.createAssignment(taskId, stepId, executor, executorId),
      bindSession: (assignmentId, input) => execution.bindSession(assignmentId, input),
      recordProgress: (taskId, stepId, progress, activity) => execution.recordProgress(taskId, stepId, progress, activity),
      recordArtifact: (taskId, stepId, artifact, identity) => execution.recordArtifact(taskId, stepId, artifact, identity),
      requestCompletion: (taskId, stepId) => execution.requestCompletion(taskId, stepId),
      gatePassed: (taskId, stepId, evidence) => execution.gatePassed(taskId, stepId, evidence),
      gateFailed: (taskId, stepId, reason) => execution.gateFailed(taskId, stepId, reason),
      transitionStep: (taskId, stepId, status, reason) => execution.transitionStep(taskId, stepId, status, reason)
    },
    worker: worker as never,
    artifactContent: createLocalArtifactContentReader(),
    hostCapability,
    productionProfiles: { get: async () => null }
  })
  const compiled = createDefaultTaskWorkflowRegistry().compile({
    title: '博弈论视频生产',
    description: '从脚本重构到最终验证的完整视频生产。',
    projectId: PROJECT_ID,
    workspace: null,
    workflowId: 'video-generation-v1'
  })
  const created = await execution.createTask(compiled)
  const taskId = created.definition.task.taskId
  return {
    dir, execution, store, workerStore, worker, bridge, hostCapability, hostResults, taskId, scriptPath,
    async close() { workerStore.close(); await rm(dir, { recursive: true, force: true }) }
  }
}

async function snapshotOf(value: Harness): Promise<ExecutionTaskSnapshot> {
  return value.execution.snapshot(value.taskId)
}

function stepRuntime(snapshot: ExecutionTaskSnapshot, stepId: string) {
  return snapshot.runtime.steps.find(step => step.stepId === stepId)!
}

async function reconcile(value: Harness): Promise<Record<string, unknown>> {
  const before = await snapshotOf(value)
  const result = await value.bridge.reconcileTask(before)
  return result
}

// The intake step is human work on the Task Board: assign, register the production
// inputs artifact, submit for review and pass the gate with review evidence.
async function completeIntake(value: Harness, overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  const taskId = value.taskId
  const assignment = await value.execution.createAssignment(taskId, 'wf-intake', 'HUMAN', 'task-board')
  const inputs = JSON.stringify({
    schema: VIDEO_PRODUCTION_INPUTS_SCHEMA,
    driveFolderId: 'drive-folder-1',
    imageBatchSize: 10,
    sources: [{
      workItemId: 'script-01',
      scriptName: SCRIPT_NAME,
      productionDate: PRODUCTION_DATE,
      storage: { provider: 'LOCAL', path: value.scriptPath, logicalName: `${SCRIPT_NAME}.txt` }
    }],
    ...overrides
  })
  await value.execution.recordArtifact(taskId, 'wf-intake', {
    logicalName: 'video-production-inputs.json', kind: 'json', mimeType: 'application/json', content: inputs
  })
  await value.execution.transitionStep(taskId, 'wf-intake', 'verifying')
  await value.execution.gatePassed(taskId, 'wf-intake', { source: 'human_task_review', note: '生产输入已核对', assignmentId: assignment.assignmentId })
}

type SlotRole = 'script' | 'visual' | 'image'
const SLOT_WORKER_DEFINITIONS: Record<SlotRole, string> = {
  script: 'script-rewriter',
  visual: 'visual-planner',
  image: 'image-producer'
}

// Simulates a real GPT Web worker on one station slot: open a physical session once,
// then loop claim → commit → claim-next through the real Worker v2 protocol until the
// slot runs out of work. artifactsFor maps each claimed stageKey to its artifacts.
async function driveSlot(
  value: Harness,
  role: SlotRole,
  idempotencyKey: string,
  artifactsFor: (stageKey: string, stageRunId: string) => Array<Record<string, unknown>>
): Promise<void> {
  const taskId = value.taskId
  const open = value.worker.openPhysicalSession({ workerSlotId: `${taskId}:${role}`, logicalSessionId: `gpt-${role}` }) as any
  value.worker.bootstrapWorker({ bindingTicket: open.ticket })
  let claim = (value.worker.claimWorkV2({ bindingTicket: open.ticket, idempotencyKey: `${idempotencyKey}-claim` }) as any).claim
  let index = 0
  while (claim && claim.units?.length) {
    const stageRunId = claim.units[0].stageRunId
    const stage = ((value.worker.workflowSnapshot(taskId) as any).stages as any[]).find(item => item.stageRunId === stageRunId)
    const artifacts = artifactsFor(stage.stageKey, stageRunId).map((artifact, artifactIndex) => ({
      artifactId: `${idempotencyKey}-${index}-${artifactIndex}`,
      workflowRunId: taskId,
      workItemId: stage.workItemId,
      stageRunId,
      kind: 'text',
      storage: { provider: 'LOCAL' },
      producer: { workerDefinitionId: SLOT_WORKER_DEFINITIONS[role], workerSlotId: `${taskId}:${role}`, workerSessionId: open.workerSessionId },
      ...artifact
    }))
    const result = value.worker.commitAndClaimNext({
      bindingTicket: open.ticket, claimId: claim.claimId, idempotencyKey: `${idempotencyKey}-done-${index}`, artifacts
    }) as any
    index += 1
    claim = result?.next?.state === 'CLAIMED' ? result.next.claim : null
  }
}

const visualPlan = {
  schema: 'zero3.visual-plan.v1',
  scriptId: 'script-01',
  shots: [
    { shotId: 'S1', type: 'static', requiresImage: true, imagePrompt: 's1' },
    { shotId: 'S2', type: 'static', requiresImage: true, imagePrompt: 's2' },
    { shotId: 'S3', type: 'static', requiresImage: true, imagePrompt: 's3' },
    { shotId: 'V1', type: 'image_to_video', requiresImage: true, imagePrompt: 'v1 frame', videoPrompt: 'v1 motion' },
    { shotId: 'R1', type: 'remotion', requiresImage: false, remotionPrompt: 'r1 remotion' }
  ]
}

test('video-generation-v1 runs the full Task Board → Execution Runtime → Worker v2 → Completion loop', async () => {
  const value = await harness()
  try {
    const rewriteName = rewriteOutputName(SCRIPT_NAME, PRODUCTION_DATE)
    const visualNames = visualOutputNames(SCRIPT_NAME, PRODUCTION_DATE)
    const packageNames = imagePackageNames(SCRIPT_NAME, PRODUCTION_DATE)
    const rewriteMdPath = join(value.dir, rewriteName)
    const visualJsonPath = join(value.dir, visualNames.json)

    // Human intake on the board, then one reconcile installs the Worker v2 run
    // and dispatches the rewrite step with a real assignment + session binding.
    await completeIntake(value)
    const afterIntake = await reconcile(value)
    assert.ok((afterIntake.actions as string[]).includes('dispatch:wf-rewrite'))
    let snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-rewrite').status, 'running')
    assert.ok(stepRuntime(snapshot, 'wf-rewrite').assignmentId)
    assert.equal(snapshot.runtime.sessionBindings.filter(binding => binding.executor === 'ZERO3').length, 1)
    const workerRun = value.worker.workflowSnapshot(value.taskId) as any
    assert.equal(workerRun.run.taskId, value.taskId)
    assert.equal(workerRun.stages.length, 2)

    // Repeated reconciles are idempotent: no duplicate assignments or installs.
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(snapshot.runtime.assignments.length, 2)
    assert.equal((value.worker.workflowSnapshot(value.taskId) as any).stages.length, 2)

    // Fake GPT Web worker runs the rewrite stage through the real claim protocol.
    await writeFile(rewriteMdPath, `# 重构稿\n\n${SCRIPT_NAME} 重构完成。`, 'utf8')
    await driveSlot(value, 'script', 'rewrite', (stageKey, stageRunId) => stageKey === 'script-rewrite'
      ? [{ logicalName: rewriteName, kind: 'markdown', mimeType: 'text/markdown', storage: { provider: 'LOCAL', path: rewriteMdPath }, stageRunId }]
      : [])
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-rewrite').status, 'completed')
    assert.ok(snapshot.events.some(event => event.type === 'artifact.produced' && event.stepId === 'wf-rewrite' && event.payload?.logicalName === 'rewrite-manifest.json'))
    assert.equal(stepRuntime(snapshot, 'wf-visual').status, 'ready')

    // Visual stage produces the machine-readable plan the bridge materializes later.
    await reconcile(value)
    await writeFile(visualJsonPath, JSON.stringify(visualPlan), 'utf8')
    await driveSlot(value, 'visual', 'visual', (stageKey, stageRunId) => stageKey === 'visual-plan'
      ? [
          { logicalName: visualNames.markdown, kind: 'markdown', mimeType: 'text/markdown', storage: { provider: 'LOCAL', path: join(value.dir, visualNames.markdown) }, stageRunId },
          { logicalName: visualNames.json, kind: 'json', mimeType: 'application/json', storage: { provider: 'LOCAL', path: visualJsonPath }, stageRunId },
          { logicalName: visualNames.remotionHandoff, kind: 'archive', mimeType: 'application/zip', storage: { provider: 'LOCAL', path: join(value.dir, visualNames.remotionHandoff) }, stageRunId }
        ]
      : [])
    await writeFile(join(value.dir, visualNames.markdown), '# 视觉方案', 'utf8')
    await writeFile(join(value.dir, visualNames.remotionHandoff), 'remotion handoff', 'utf8')
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-visual').status, 'completed')
    // The next reconcile dispatches plan-production and materializes the batches.
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-plan-production').status, 'completed')
    assert.ok(snapshot.events.some(event => event.type === 'artifact.produced' && event.stepId === 'wf-plan-production' && event.payload?.logicalName === 'production-plan.json'))
    const afterPlan = value.worker.workflowSnapshot(value.taskId) as any
    const batchStage = afterPlan.stages.find((stage: any) => stage.stageKey === 'image-batch')
    const packageStage = afterPlan.stages.find((stage: any) => stage.stageKey === 'image-package')
    assert.ok(batchStage && packageStage)
    assert.equal(batchStage.expectedOutputs.length, 4)

    // Image production: batch first, then the package stage released by dependency.
    // A real worker handles both in one physical session via claim-next.
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-image-production').status, 'running')
    for (const shot of ['S1', 'S2', 'S3', 'V1']) {
      await writeFile(join(value.dir, `${shot}.png`), `png:${shot}`, 'utf8')
    }
    await writeFile(join(value.dir, packageNames.imagesZip), 'images zip', 'utf8')
    await writeFile(join(value.dir, packageNames.manifest), '{}', 'utf8')
    await writeFile(join(value.dir, packageNames.imageToVideoHandoff), 'i2v handoff', 'utf8')
    await driveSlot(value, 'image', 'image', (stageKey, stageRunId) => {
      if (stageKey === 'image-batch') {
        return visualPlan.shots.filter(shot => shot.requiresImage).map(shot => ({
          logicalName: `${shot.shotId}.png`, kind: 'image', mimeType: 'image/png',
          storage: { provider: 'LOCAL', path: join(value.dir, `${shot.shotId}.png`) }, stageRunId
        }))
      }
      if (stageKey === 'image-package') {
        return [
          { logicalName: packageNames.imagesZip, kind: 'archive', mimeType: 'application/zip', storage: { provider: 'LOCAL', path: join(value.dir, packageNames.imagesZip) }, stageRunId },
          { logicalName: packageNames.manifest, kind: 'json', mimeType: 'application/json', storage: { provider: 'LOCAL', path: join(value.dir, packageNames.manifest) }, stageRunId },
          { logicalName: packageNames.imageToVideoHandoff, kind: 'archive', mimeType: 'application/zip', storage: { provider: 'LOCAL', path: join(value.dir, packageNames.imageToVideoHandoff) }, stageRunId }
        ]
      }
      return []
    })
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-image-production').status, 'completed')

    // Host capability steps run through the injected capability port.
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-cloud-production').status, 'completed')
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-jianying').status, 'completed')
    assert.deepEqual(value.hostResults.map(result => result.capability), ['cloud-production', 'jianying'])

    // Final verification aggregates the real manifests and parks at the human gate.
    await reconcile(value)
    snapshot = await snapshotOf(value)
    assert.equal(stepRuntime(snapshot, 'wf-final-verify').status, 'verifying')
    assert.ok(snapshot.events.some(event => event.type === 'artifact.produced' && event.stepId === 'wf-final-verify' && event.payload?.logicalName === 'production-manifest.json'))
    assert.notEqual(snapshot.runtime.task.status, 'completed')

    // Human gate closes the task; the required_outputs gate is enforced on the way.
    const verifyAssignment = stepRuntime(snapshot, 'wf-final-verify').assignmentId!
    await value.execution.gatePassed(value.taskId, 'wf-final-verify', { source: 'human_task_review', note: '全部产物已验收', assignmentId: verifyAssignment })
    snapshot = await snapshotOf(value)
    assert.equal(snapshot.runtime.task.status, 'completed')
    assert.equal(snapshot.runtime.steps.every(step => step.status === 'completed'), true)
  } finally { await value.close() }
})

test('bridge survives an app restart: a fresh bridge instance resumes without duplicate dispatch', async () => {
  const value = await harness()
  try {
    await completeIntake(value)
    await reconcile(value)
    const restarted = new Zero3VideoGenerationTaskBridge({
      execution: {
        getTask: taskId => value.execution.snapshot(taskId),
        createAssignment: (taskId, stepId, executor, executorId) => value.execution.createAssignment(taskId, stepId, executor, executorId),
        bindSession: (assignmentId, input) => value.execution.bindSession(assignmentId, input),
        recordProgress: (taskId, stepId, progress, activity) => value.execution.recordProgress(taskId, stepId, progress, activity),
        recordArtifact: (taskId, stepId, artifact, identity) => value.execution.recordArtifact(taskId, stepId, artifact, identity),
        requestCompletion: (taskId, stepId) => value.execution.requestCompletion(taskId, stepId),
        gatePassed: (taskId, stepId, evidence) => value.execution.gatePassed(taskId, stepId, evidence),
        gateFailed: (taskId, stepId, reason) => value.execution.gateFailed(taskId, stepId, reason),
        transitionStep: (taskId, stepId, status, reason) => value.execution.transitionStep(taskId, stepId, status, reason)
      },
      worker: value.worker as never,
      artifactContent: createLocalArtifactContentReader(),
      hostCapability: { run: async () => ({ ok: true, manifest: {} }) },
      productionProfiles: { get: async () => null }
    })
    await restarted.reconcileTask(await snapshotOf(value))
    const snapshot = await snapshotOf(value)
    assert.equal(snapshot.runtime.assignments.length, 2)
    assert.equal((value.worker.workflowSnapshot(value.taskId) as any).stages.length, 2)
  } finally { await value.close() }
})

test('worker stage failure fails the step closed instead of fabricating progress', async () => {
  const value = await harness()
  try {
    await completeIntake(value)
    await reconcile(value)
    const open = value.worker.openPhysicalSession({ workerSlotId: `${value.taskId}:script`, logicalSessionId: 'gpt-script' }) as any
    value.worker.bootstrapWorker({ bindingTicket: open.ticket })
    const claim = (value.worker.claimWorkV2({ bindingTicket: open.ticket, idempotencyKey: 'blocked-claim' }) as any).claim
    value.worker.reportBlockedV2({ bindingTicket: open.ticket, claimId: claim.claimId, disposition: 'BLOCKED_TERMINAL', reason: '工位无法调用脚本 Skill', idempotencyKey: 'blocked-report' })
    await reconcile(value)
    const snapshot = await snapshotOf(value)
    const rewrite = stepRuntime(snapshot, 'wf-rewrite')
    assert.equal(rewrite.status, 'blocked')
    assert.match(String(rewrite.blocker), /工位阻塞/)
    assert.match(String(rewrite.blocker), /无法调用脚本 Skill/)
    assert.equal(snapshot.runtime.task.status, 'running')
  } finally { await value.close() }
})

test('missing external host capability blocks cloud-production with BLOCKED_BY_EXTERNAL_CAPABILITY', async () => {
  const value = await harness({
    hostCapability: { run: async () => ({ ok: false, externalCapability: true, reason: 'Remote Compute 未连接' }) }
  })
  try {
    await completeIntake(value)
    const rewriteName = rewriteOutputName(SCRIPT_NAME, PRODUCTION_DATE)
    const visualNames = visualOutputNames(SCRIPT_NAME, PRODUCTION_DATE)
    const packageNames = imagePackageNames(SCRIPT_NAME, PRODUCTION_DATE)
    await reconcile(value)
    await writeFile(join(value.dir, rewriteName), '# 重构稿', 'utf8')
    await driveSlot(value, 'script', 'rewrite', (stageKey, stageRunId) => stageKey === 'script-rewrite'
      ? [{ logicalName: rewriteName, kind: 'markdown', mimeType: 'text/markdown', storage: { provider: 'LOCAL', path: join(value.dir, rewriteName) }, stageRunId }]
      : [])
    await reconcile(value)
    const visualJsonPath = join(value.dir, visualNames.json)
    await writeFile(visualJsonPath, JSON.stringify(visualPlan), 'utf8')
    await driveSlot(value, 'visual', 'visual', (stageKey, stageRunId) => stageKey === 'visual-plan'
      ? [
          { logicalName: visualNames.markdown, kind: 'markdown', mimeType: 'text/markdown', storage: { provider: 'LOCAL', path: join(value.dir, visualNames.markdown) }, stageRunId },
          { logicalName: visualNames.json, kind: 'json', mimeType: 'application/json', storage: { provider: 'LOCAL', path: visualJsonPath }, stageRunId },
          { logicalName: visualNames.remotionHandoff, kind: 'archive', mimeType: 'application/zip', storage: { provider: 'LOCAL', path: join(value.dir, visualNames.remotionHandoff) }, stageRunId }
        ]
      : [])
    await writeFile(join(value.dir, visualNames.markdown), '# 视觉方案', 'utf8')
    await writeFile(join(value.dir, visualNames.remotionHandoff), 'handoff', 'utf8')
    await reconcile(value)
    await reconcile(value)
    for (const shot of ['S1', 'S2', 'S3', 'V1']) await writeFile(join(value.dir, `${shot}.png`), 'png', 'utf8')
    await writeFile(join(value.dir, packageNames.imagesZip), 'zip', 'utf8')
    await writeFile(join(value.dir, packageNames.manifest), '{}', 'utf8')
    await writeFile(join(value.dir, packageNames.imageToVideoHandoff), 'handoff', 'utf8')
    await driveSlot(value, 'image', 'image', (stageKey, stageRunId) => {
      if (stageKey === 'image-batch') {
        return visualPlan.shots.filter(shot => shot.requiresImage).map(shot => ({
          logicalName: `${shot.shotId}.png`, kind: 'image', mimeType: 'image/png',
          storage: { provider: 'LOCAL', path: join(value.dir, `${shot.shotId}.png`) }, stageRunId
        }))
      }
      if (stageKey === 'image-package') {
        return [
          { logicalName: packageNames.imagesZip, kind: 'archive', mimeType: 'application/zip', storage: { provider: 'LOCAL', path: join(value.dir, packageNames.imagesZip) }, stageRunId },
          { logicalName: packageNames.manifest, kind: 'json', mimeType: 'application/json', storage: { provider: 'LOCAL', path: join(value.dir, packageNames.manifest) }, stageRunId },
          { logicalName: packageNames.imageToVideoHandoff, kind: 'archive', mimeType: 'application/zip', storage: { provider: 'LOCAL', path: join(value.dir, packageNames.imageToVideoHandoff) }, stageRunId }
        ]
      }
      return []
    })
    await reconcile(value)
    await reconcile(value)
    const snapshot = await snapshotOf(value)
    const cloud = stepRuntime(snapshot, 'wf-cloud-production')
    assert.equal(cloud.status, 'blocked')
    assert.match(String(cloud.blocker), new RegExp(BLOCKED_BY_EXTERNAL_CAPABILITY))
    assert.match(String(cloud.blocker), /Remote Compute 未连接/)
    // The failure is isolated: earlier steps stay completed.
    assert.equal(stepRuntime(snapshot, 'wf-image-production').status, 'completed')
    assert.equal(snapshot.runtime.task.status, 'running')
  } finally { await value.close() }
})

test('unreadable visual plan artifact fails plan-production closed', async () => {
  const value = await harness()
  try {
    await completeIntake(value)
    const rewriteName = rewriteOutputName(SCRIPT_NAME, PRODUCTION_DATE)
    const visualNames = visualOutputNames(SCRIPT_NAME, PRODUCTION_DATE)
    await reconcile(value)
    await writeFile(join(value.dir, rewriteName), '# 重构稿', 'utf8')
    await driveSlot(value, 'script', 'rewrite', (stageKey, stageRunId) => stageKey === 'script-rewrite'
      ? [{ logicalName: rewriteName, kind: 'markdown', mimeType: 'text/markdown', storage: { provider: 'LOCAL', path: join(value.dir, rewriteName) }, stageRunId }]
      : [])
    await reconcile(value)
    // The visual JSON lives on Google Drive only: the bridge cannot read it locally.
    await driveSlot(value, 'visual', 'visual', (stageKey, stageRunId) => stageKey === 'visual-plan'
      ? [
          { logicalName: visualNames.markdown, kind: 'markdown', mimeType: 'text/markdown', storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-visual' }, stageRunId },
          { logicalName: visualNames.json, kind: 'json', mimeType: 'application/json', storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-visual-json' }, stageRunId },
          { logicalName: visualNames.remotionHandoff, kind: 'archive', mimeType: 'application/zip', storage: { provider: 'GOOGLE_DRIVE', fileId: 'drive-remotion' }, stageRunId }
        ]
      : [])
    await reconcile(value)
    // A second reconcile dispatches plan-production, which must then fail closed.
    await reconcile(value)
    const snapshot = await snapshotOf(value)
    const plan = stepRuntime(snapshot, 'wf-plan-production')
    assert.equal(plan.status, 'blocked')
    assert.match(String(plan.blocker), new RegExp(BLOCKED_BY_EXTERNAL_CAPABILITY))
    assert.equal(stepRuntime(snapshot, 'wf-visual').status, 'completed')
  } finally { await value.close() }
})

test('malformed production inputs block the rewrite step with the exact missing piece', async () => {
  const value = await harness()
  try {
    // No driveFolderId anywhere and no project profile: install must fail closed.
    const taskId = value.taskId
    const assignment = await value.execution.createAssignment(taskId, 'wf-intake', 'HUMAN', 'task-board')
    await value.execution.recordArtifact(taskId, 'wf-intake', {
      logicalName: 'video-production-inputs.json', kind: 'json', mimeType: 'application/json',
      content: JSON.stringify({ schema: VIDEO_PRODUCTION_INPUTS_SCHEMA, sources: [] })
    })
    await value.execution.transitionStep(taskId, 'wf-intake', 'verifying')
    await value.execution.gatePassed(taskId, 'wf-intake', { source: 'human_task_review', note: 'inputs', assignmentId: assignment.assignmentId })
    await reconcile(value)
    const snapshot = await snapshotOf(value)
    const rewrite = stepRuntime(snapshot, 'wf-rewrite')
    assert.equal(rewrite.status, 'blocked')
    assert.match(String(rewrite.blocker), /生产运行安装失败/)
    assert.equal(value.bridge.status().bridge, 'zero3.pilot.video-generation-task-bridge.v1')
  } finally { await value.close() }
})

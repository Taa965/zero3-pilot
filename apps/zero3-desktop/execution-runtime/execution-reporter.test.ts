import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  ZERO3_EXECUTION_REPORT_V1,
  Zero3ExecutionReporter,
  Zero3ExecutionReporterHttpServer,
  Zero3ExecutionRuntime,
  Zero3ExecutionStore,
  type ExecutionReportType
} from './index.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

async function withFixture(
  run: (fixture: {
    dir: string
    runtime: Zero3ExecutionRuntime
    reporter: Zero3ExecutionReporter
    assignmentId: string
    bindingId: string
    ticket: string
  }) => Promise<void>,
  options: { clock?: () => Date; ttlSeconds?: number } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-reporter-'))
  try {
    const runtime = new Zero3ExecutionRuntime(new Zero3ExecutionStore(join(dir, 'tasks')))
    await runtime.createTask({
      task: {
        taskId: 'video-001', projectId: 'zero3', title: '资本论视频生产', goal: '完成视觉重构',
        workflowId: 'cognitive-store-video-v1', maxParallelSteps: 2, createdBySessionId: 'origin', metadata: {}
      },
      steps: [{
        stepId: 'visual-plan', title: '视觉规划', objective: '生成导演审片单和逐条完整提示词', executor: 'GPT_WEB', dependsOn: [],
        inputArtifacts: [{ logicalName: '资本论.md', required: true }],
        expectedOutputs: [{ logicalName: '导演审片单.md', required: true }, { logicalName: '逐条完整提示词.md', required: true }],
        completionGate: ['required_outputs'], maxAttempts: 3, metadata: {}
      }]
    })
    const assignment = await runtime.createAssignment('video-001', 'visual-plan', 'GPT_WEB')
    const binding = await runtime.bindSession(assignment.assignmentId, {
      logicalSessionId: 'gpt-web-visual', conversationUrl: 'https://chatgpt.com/c/example'
    })
    const reporter = new Zero3ExecutionReporter(runtime, randomBytes(32), { clock: options.clock })
    const ticket = await reporter.issueTicket(assignment.assignmentId, { ttlSeconds: options.ttlSeconds })
    await run({ dir, runtime, reporter, assignmentId: assignment.assignmentId, bindingId: binding.bindingId, ticket })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

function report(assignmentId: string, ticket: string, reportId: string, type: ExecutionReportType, payload: Record<string, unknown> = {}) {
  return { protocol: ZERO3_EXECUTION_REPORT_V1, assignmentId, ticket, reportId, type, payload }
}

test('DC-style reporter records progress/artifacts and cannot self-complete past the gate', async () => {
  await withFixture(async ({ runtime, reporter, assignmentId, ticket }) => {
    const started = await reporter.report(report(assignmentId, ticket, 'r-start', 'SESSION_STARTED'))
    assert.equal(started.stepStatus, 'running')

    const progress = await reporter.report(report(assignmentId, ticket, 'r-progress', 'PROGRESS_UPDATED', {
      progress: 0.7, currentActivity: '正在生成逐条完整提示词'
    }))
    assert.equal(progress.progress, 0.7)
    assert.equal(progress.currentActivity, '正在生成逐条完整提示词')

    await reporter.report(report(assignmentId, ticket, 'r-artifact', 'ARTIFACT_PRODUCED', {
      logicalName: '导演审片单.md', artifactId: 'artifact-review', pathOrUri: 'artifact://video-001/director-review'
    }))
    await reporter.report(report(assignmentId, ticket, 'r-artifact-2', 'ARTIFACT_PRODUCED', {
      logicalName: '逐条完整提示词.md', artifactId: 'artifact-prompts', pathOrUri: 'artifact://video-001/prompts'
    }))
    const requested = await reporter.report(report(assignmentId, ticket, 'r-complete', 'COMPLETION_REQUESTED'))
    assert.equal(requested.stepStatus, 'verifying')
    assert.equal(requested.nextAction, 'WAIT_FOR_ZERO3_GATE')
    assert.equal((await runtime.snapshot('video-001')).runtime.task.status, 'running')

    const completed = await runtime.gatePassed('video-001', 'visual-plan', { requiredOutputs: true })
    assert.equal(completed.runtime.task.status, 'completed')
  })
})

test('report ids are idempotent and fail closed when reused with different content', async () => {
  await withFixture(async ({ reporter, assignmentId, ticket }) => {
    const first = await reporter.report(report(assignmentId, ticket, 'same-report', 'PROGRESS_UPDATED', { progress: 0.2 }))
    assert.equal(first.duplicate, false)
    const replay = await reporter.report(report(assignmentId, ticket, 'same-report', 'PROGRESS_UPDATED', { progress: 0.2 }))
    assert.equal(replay.duplicate, true)
    await assert.rejects(
      reporter.report(report(assignmentId, ticket, 'same-report', 'PROGRESS_UPDATED', { progress: 0.3 })),
      /reportId was reused/
    )
  })
})

test('the same bound web session can continue after gate feedback without a new assignment', async () => {
  await withFixture(async ({ runtime, reporter, assignmentId, ticket }) => {
    await reporter.report(report(assignmentId, ticket, 'start', 'SESSION_STARTED'))
    await reporter.report(report(assignmentId, ticket, 'complete-1', 'COMPLETION_REQUESTED'))
    await runtime.gateFailed('video-001', 'visual-plan', '缺少逐条完整提示词.md')

    const resumed = await reporter.report(report(assignmentId, ticket, 'resume-progress', 'PROGRESS_UPDATED', {
      progress: 0.8, currentActivity: '补充缺失提示词'
    }))
    assert.equal(resumed.stepStatus, 'running')
    const requestedAgain = await reporter.report(report(assignmentId, ticket, 'complete-2', 'COMPLETION_REQUESTED'))
    assert.equal(requestedAgain.stepStatus, 'verifying')
  })
})


test('blocked and waiting-human reports pause a web assignment until an explicit resume signal', async () => {
  await withFixture(async ({ reporter, assignmentId, ticket }) => {
    await reporter.report(report(assignmentId, ticket, 'start-pauses', 'SESSION_STARTED'))
    const blocked = await reporter.report(report(assignmentId, ticket, 'blocked', 'BLOCKED', { reason: '上游素材不可读' }))
    assert.equal(blocked.stepStatus, 'blocked')
    assert.equal(blocked.nextAction, 'STOP')

    const resumed = await reporter.report(report(assignmentId, ticket, 'resume-after-block', 'SESSION_STARTED'))
    assert.equal(resumed.stepStatus, 'running')
    const human = await reporter.report(report(assignmentId, ticket, 'human', 'WAITING_HUMAN', { reason: '需要人工选择视觉方向' }))
    assert.equal(human.stepStatus, 'waiting_human')
    assert.equal(human.nextAction, 'WAIT_FOR_HUMAN')
    const resumedAgain = await reporter.report(report(assignmentId, ticket, 'resume-after-human', 'SESSION_STARTED'))
    assert.equal(resumedAgain.stepStatus, 'running')
  })
})

test('assignment tickets are scoped, capability-limited, expiring, and invalidated by reassignment', async () => {
  let now = new Date('2026-09-10T00:00:00.000Z')
  await withFixture(async ({ runtime, reporter, assignmentId, ticket }) => {
    const context = await reporter.context(ticket)
    assert.equal(context.assignmentId, assignmentId)
    assert.equal(context.logicalSessionId, 'gpt-web-visual')
    assert.deepEqual(context.expectedOutputs.map(item => (item as { logicalName: string }).logicalName), ['导演审片单.md', '逐条完整提示词.md'])
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`
    await assert.rejects(reporter.context(tampered), /signature is invalid/)
    const restricted = await reporter.issueTicket(assignmentId, { allowedReports: ['PROGRESS_UPDATED'] })
    await assert.rejects(
      reporter.report(report(assignmentId, restricted, 'forbidden-complete', 'COMPLETION_REQUESTED')),
      /does not allow COMPLETION_REQUESTED/
    )

    await reporter.report(report(assignmentId, ticket, 'start', 'SESSION_STARTED'))
    await reporter.report(report(assignmentId, ticket, 'complete', 'COMPLETION_REQUESTED'))
    await runtime.gateFailed('video-001', 'visual-plan', 'needs fix')
    await runtime.createAssignment('video-001', 'visual-plan', 'GPT_WEB')
    await assert.rejects(reporter.report(report(assignmentId, ticket, 'stale', 'PROGRESS_UPDATED', { progress: 0.4 })), /stale assignment/)
  }, { clock: () => now, ttlSeconds: 60 })

  await withFixture(async ({ reporter, assignmentId, ticket }) => {
    now = new Date('2026-09-10T00:02:00.000Z')
    await assert.rejects(reporter.report(report(assignmentId, ticket, 'expired', 'PROGRESS_UPDATED', { progress: 0.1 })), /expired/)
  }, { clock: () => now, ttlSeconds: 60 })
})

test('loopback HTTP bridge and zero3-exec CLI provide a DC-callable reporter path', async () => {
  await withFixture(async ({ dir, reporter, assignmentId, ticket }) => {
    const descriptorPath = join(dir, 'reporter-endpoint.json')
    const server = new Zero3ExecutionReporterHttpServer(reporter, { descriptorPath })
    const endpoint = await server.start()
    try {
      const denied = await fetch(new URL('/v1/context', endpoint.origin), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket })
      })
      assert.equal(denied.status, 403)

      const cli = join(HERE, 'zero3-exec.mjs')
      const contextResult = await execFileAsync(process.execPath, [cli, 'context', '--endpoint-file', descriptorPath, '--ticket', ticket])
      assert.equal(JSON.parse(contextResult.stdout).assignmentId, assignmentId)

      const reportResult = await execFileAsync(process.execPath, [
        cli, 'report', '--endpoint-file', descriptorPath, '--ticket', ticket,
        '--report-id', 'cli-progress', '--type', 'PROGRESS_UPDATED',
        '--payload-json', JSON.stringify({ progress: 0.55, currentActivity: 'DC 正在登记进度' })
      ])
      const parsed = JSON.parse(reportResult.stdout)
      assert.equal(parsed.accepted, true)
      assert.equal(parsed.stepStatus, 'running')
      assert.equal(parsed.progress, 0.55)
    } finally { await server.stop() }
  })
})

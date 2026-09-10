import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Zero3ExecutionDesktopRuntime } from './desktop/desktop-runtime.ts'

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

test('desktop execution runtime persists reporter authority while keeping the loopback bearer out of renderer capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero3-execution-desktop-'))
  const client = join(root, 'zero3-exec.mjs')
  let first: Zero3ExecutionDesktopRuntime | null = null
  let second: Zero3ExecutionDesktopRuntime | null = null
  try {
    first = new Zero3ExecutionDesktopRuntime(root, { reporterClientPath: client, reporterClientKind: 'node', nodeExecutable: 'node' })
    await first.start()
    await first.createTask({
      task: {
        taskId: 'task-1', projectId: null, title: '跨应用任务', goal: '测试 DC 回报', workflowId: null,
        maxParallelSteps: 1, createdBySessionId: null, metadata: {}
      },
      steps: [{
        stepId: 'web', title: '网页工作', objective: '执行并回报', executor: 'GPT_WEB', dependsOn: [],
        inputArtifacts: [], expectedOutputs: [], completionGate: ['required_outputs'], maxAttempts: 2, metadata: {}
      }]
    })
    const assignment = await first.createAssignment('task-1', 'web', 'GPT_WEB') as { assignmentId: string }
    const binding = await first.bindSession(assignment.assignmentId, { logicalSessionId: 'gpt-web-1' }) as { bindingId: string }
    const accessInfo = await first.issueReporterTicket(assignment.assignmentId, { bindingId: binding.bindingId })
    assert.equal(accessInfo.client.command, 'node')
    assert.equal(accessInfo.endpointFile, first.endpointFile)
    assert.equal(await exists(first.endpointFile), true)

    const descriptor = JSON.parse(await readFile(first.endpointFile, 'utf8'))
    const capabilities = await first.runtimeCapabilities() as Record<string, unknown>
    assert.ok(descriptor.bearerToken)
    assert.doesNotMatch(JSON.stringify(capabilities), new RegExp(descriptor.bearerToken))

    await first.stop()
    first = null
    assert.equal(await exists(join(root, 'reporter-endpoint.json')), false)

    second = new Zero3ExecutionDesktopRuntime(root, { reporterClientPath: client, reporterClientKind: 'node', nodeExecutable: 'node' })
    await second.start()
    const context = await second.reporter.context(accessInfo.ticket)
    assert.equal(context.assignmentId, assignment.assignmentId)
    assert.equal(context.logicalSessionId, 'gpt-web-1')
  } finally {
    if (first) await first.stop().catch(() => undefined)
    if (second) await second.stop().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

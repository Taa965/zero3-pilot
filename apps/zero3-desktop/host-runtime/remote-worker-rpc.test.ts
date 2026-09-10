import assert from 'node:assert/strict'
import test from 'node:test'

import { assertZero3WorkerRpcLease, executeZero3WorkerRpc, type Zero3WorkerRuntimePort } from './remote-worker-rpc.ts'

function lease(tool: string, args: Record<string, unknown> = {}) {
  return {
    request_id: 'wrpc-1',
    lease_id: 'wrpc-lease-1',
    fencing_token: 1,
    lease_expires_at: '2026-09-11T05:00:00Z',
    tool,
    arguments: args
  }
}

function fakeRuntime(calls: string[]): Zero3WorkerRuntimePort {
  return {
    registerWorker(input) { calls.push('register_worker'); return { input } },
    claimWork(input) { calls.push('claim_work'); return { input } },
    reportProgress(input) { calls.push('report_progress'); return { input } },
    completeAndClaimNext(input) { calls.push('complete_and_claim_next'); return { input } },
    reportFailure(input) { calls.push('report_failure'); return { input } },
    getTaskContext(input) { calls.push('get_task_context'); return { input } }
  }
}

test('worker RPC executor exposes exactly the six bounded Worker Protocol actions', async () => {
  const expected = ['register_worker','claim_work','report_progress','complete_and_claim_next','report_failure','get_task_context']
  const calls: string[] = []
  const runtime = fakeRuntime(calls)
  for (const tool of expected) await executeZero3WorkerRpc(runtime, lease(tool, { tool }))
  assert.deepEqual(calls, expected)
})
test('worker RPC rejects every non-Worker-Protocol tool before local dispatch', async () => {
  for (const tool of ['dispatch_codex', 'run_gpu', 'shell', 'workflow_admin', 'file_write']) {
    assert.throws(() => assertZero3WorkerRpcLease(lease(tool)), /tool is not allowed/)
  }
})

test('worker RPC forwards the original scoped arguments without inventing authority', async () => {
  const calls: string[] = []
  const runtime = fakeRuntime(calls)
  const input = {
    taskId: 'task-1',
    stepId: 'step-1',
    assignmentId: 'asg-1',
    workerId: 'worker-1',
    sessionId: 'session-1',
    idempotencyKey: 'idem-1'
  }
  const result = await executeZero3WorkerRpc(runtime, lease('claim_work', input)) as { input: Record<string, unknown> }
  assert.deepEqual(result.input, input)
  assert.deepEqual(calls, ['claim_work'])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { assertZero3WorkerRpcLease, executeZero3WorkerRpc, type Zero3WorkerRuntimePort } from './remote-worker-rpc.ts'

function lease(tool: string, args: Record<string, unknown> = {}, capability = 'worker-protocol-v1') {
  return {
    request_id: 'wrpc-1',
    lease_id: 'wrpc-lease-1',
    fencing_token: 1,
    lease_expires_at: '2026-09-11T05:00:00Z',
    capability,
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
    getTaskContext(input) { calls.push('get_task_context'); return { input } },
    sessionStart(input) { calls.push('session_start'); return { input } },
    contextResolve(input) { calls.push('context_resolve'); return { input } },
    taskClaim(input) { calls.push('task_claim'); return { input } },
    eventRecord(input) { calls.push('event_record'); return { input } },
    artifactRegister(input) { calls.push('artifact_register'); return { input } },
    taskComplete(input) { calls.push('task_complete'); return { input } },
    memoryCommit(input) { calls.push('memory_commit'); return { input } },
    handoffCreate(input) { calls.push('handoff_create'); return { input } },
    bootstrapWorker(input) { calls.push('bootstrap_worker'); return { input } },
    claimWorkV2(input) { calls.push('claim_work_v2'); return { input } },
    reportProgressV2(input) { calls.push('report_progress_v2'); return { input } },
    commitAndClaimNextV2(input) { calls.push('commit_and_claim_next'); return { input } },
    reportBlockedV2(input) { calls.push('report_blocked'); return { input } },
    recoverWorker(input) { calls.push('recover_worker'); return { input } },
    taskBootstrap(input) { calls.push('task_bootstrap'); return { input } },
    dispatchCodexTask(input) { calls.push('dispatch_codex_task'); return { input } },
    verifyCommit(input) { calls.push('verify_commit'); return { input } },
    listCapabilities(input) { calls.push('list_capabilities'); return { input } },
    describeCapability(input) { calls.push('describe_capability'); return { input } },
    invokeCapability(input) { calls.push('invoke_capability'); return { input } },
    getOperation(input) { calls.push('get_operation'); return { input } },
    cancelOperation(input) { calls.push('cancel_operation'); return { input } }
  }
}

test('worker RPC executor exposes the bounded Worker Protocol and shared lifecycle actions', async () => {
  const expected = ['register_worker','claim_work','report_progress','complete_and_claim_next','report_failure','get_task_context','session_start','context_resolve','task_claim','event_record','artifact_register','task_complete','memory_commit','handoff_create','bootstrap_worker','commit_and_claim_next','report_blocked','recover_worker','task_bootstrap','dispatch_codex_task','verify_commit']
  const calls: string[] = []
  const runtime = fakeRuntime(calls)
  for (const tool of expected) await executeZero3WorkerRpc(runtime, lease(tool, { tool }))
  assert.deepEqual(calls, expected)
})
test('claim_work and report_progress route binding tickets to Worker Protocol v2', async () => {
  const calls: string[] = []
  const runtime = fakeRuntime(calls)
  await executeZero3WorkerRpc(runtime, lease('claim_work', { bindingTicket: 'ticket', idempotencyKey: 'c1' }))
  await executeZero3WorkerRpc(runtime, lease('report_progress', { bindingTicket: 'ticket', claimId: 'c', progress: 0.5, idempotencyKey: 'p1' }))
  assert.deepEqual(calls, ['claim_work_v2', 'report_progress_v2'])
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


test('remote RPC exposes Zero3 capability protocol without widening Worker Protocol', async () => {
  const expected = ['list_capabilities','describe_capability','invoke_capability','get_operation','cancel_operation']
  const calls: string[] = []
  const runtime = fakeRuntime(calls)
  for (const tool of expected) await executeZero3WorkerRpc(runtime, lease(tool, { tool }, 'zero3-capability-v1'))
  assert.deepEqual(calls, expected)
  assert.throws(() => assertZero3WorkerRpcLease(lease('invoke_capability', {}, 'worker-protocol-v1')), /not allowed/)
  assert.throws(() => assertZero3WorkerRpcLease(lease('claim_work', {}, 'zero3-capability-v1')), /not allowed/)
})

import type { Zero3RemoteWorkerRpcLease, Zero3WorkerRpcTool } from './remote-types'

export type Zero3WorkerRuntimePort = {
  registerWorker(input: Record<string, unknown>): unknown
  claimWork(input: Record<string, unknown>): unknown
  reportProgress(input: Record<string, unknown>): unknown
  completeAndClaimNext(input: Record<string, unknown>): unknown
  reportFailure(input: Record<string, unknown>): unknown
  getTaskContext(input: Record<string, unknown>): unknown
  sessionStart(input: Record<string, unknown>): unknown
  contextResolve(input: Record<string, unknown>): unknown
  taskClaim(input: Record<string, unknown>): unknown
  eventRecord(input: Record<string, unknown>): unknown
  artifactRegister(input: Record<string, unknown>): unknown
  taskComplete(input: Record<string, unknown>): unknown
  memoryCommit(input: Record<string, unknown>): unknown
  handoffCreate(input: Record<string, unknown>): unknown
  bootstrapWorker(input: Record<string, unknown>): unknown
  claimWorkV2(input: Record<string, unknown>): unknown
  reportProgressV2(input: Record<string, unknown>): unknown
  commitAndClaimNextV2(input: Record<string, unknown>): unknown
  reportBlockedV2(input: Record<string, unknown>): unknown
  recoverWorker(input: Record<string, unknown>): unknown
  taskBootstrap(input: Record<string, unknown>): unknown
  dispatchCodexTask(input: Record<string, unknown>): unknown
  verifyCommit(input: Record<string, unknown>): unknown
}

const WORKER_TOOLS = new Set<Zero3WorkerRpcTool>([
  'register_worker',
  'claim_work',
  'report_progress',
  'complete_and_claim_next',
  'report_failure',
  'get_task_context',
  'session_start',
  'context_resolve',
  'task_claim',
  'event_record',
  'artifact_register',
  'task_complete',
  'memory_commit',
  'handoff_create',
  'bootstrap_worker',
  'commit_and_claim_next',
  'report_blocked',
  'recover_worker',
  'task_bootstrap',
  'dispatch_codex_task',
  'verify_commit'
])

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function assertZero3WorkerRpcLease(value: unknown): Zero3RemoteWorkerRpcLease {
  const lease = record(value, 'worker RPC lease')
  const tool = String(lease.tool ?? '') as Zero3WorkerRpcTool
  if (!WORKER_TOOLS.has(tool)) throw new Error('worker RPC tool is not allowed')
  if (!lease.request_id || !lease.lease_id || !Number.isSafeInteger(lease.fencing_token)) throw new Error('worker RPC lease identity is invalid')
  return { ...lease, tool, arguments: record(lease.arguments, 'worker RPC arguments') } as Zero3RemoteWorkerRpcLease
}
export async function executeZero3WorkerRpc(
  runtime: Zero3WorkerRuntimePort,
  leaseValue: unknown
): Promise<unknown> {
  const lease = assertZero3WorkerRpcLease(leaseValue)
  const input = lease.arguments
  switch (lease.tool) {
    case 'register_worker':
      return runtime.registerWorker(input)
    case 'claim_work':
      return ('bindingTicket' in input || 'ticket' in input) ? runtime.claimWorkV2(input) : runtime.claimWork(input)
    case 'report_progress':
      return ('bindingTicket' in input || 'ticket' in input) ? runtime.reportProgressV2(input) : runtime.reportProgress(input)
    case 'complete_and_claim_next':
      return runtime.completeAndClaimNext(input)
    case 'report_failure':
      return runtime.reportFailure(input)
    case 'get_task_context':
      return runtime.getTaskContext(input)
    case 'session_start':
      return runtime.sessionStart(input)
    case 'context_resolve':
      return runtime.contextResolve(input)
    case 'task_claim':
      return runtime.taskClaim(input)
    case 'event_record':
      return runtime.eventRecord(input)
    case 'artifact_register':
      return runtime.artifactRegister(input)
    case 'task_complete':
      return runtime.taskComplete(input)
    case 'memory_commit':
      return runtime.memoryCommit(input)
    case 'handoff_create':
      return runtime.handoffCreate(input)
    case 'bootstrap_worker':
      return runtime.bootstrapWorker(input)
    case 'commit_and_claim_next':
      return runtime.commitAndClaimNextV2(input)
    case 'report_blocked':
      return runtime.reportBlockedV2(input)
    case 'recover_worker':
      return runtime.recoverWorker(input)
    case 'task_bootstrap':
      return runtime.taskBootstrap(input)
    case 'dispatch_codex_task':
      return runtime.dispatchCodexTask(input)
    case 'verify_commit':
      return runtime.verifyCommit(input)
  }
}

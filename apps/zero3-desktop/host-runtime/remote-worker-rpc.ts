import type { Zero3RemoteWorkerRpcLease, Zero3WorkerRpcTool } from './remote-types'

export type Zero3WorkerRuntimePort = {
  registerWorker(input: Record<string, unknown>): unknown
  claimWork(input: Record<string, unknown>): unknown
  reportProgress(input: Record<string, unknown>): unknown
  completeAndClaimNext(input: Record<string, unknown>): unknown
  reportFailure(input: Record<string, unknown>): unknown
  getTaskContext(input: Record<string, unknown>): unknown
}

const WORKER_TOOLS = new Set<Zero3WorkerRpcTool>([
  'register_worker',
  'claim_work',
  'report_progress',
  'complete_and_claim_next',
  'report_failure',
  'get_task_context'
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
      return runtime.claimWork(input)
    case 'report_progress':
      return runtime.reportProgress(input)
    case 'complete_and_claim_next':
      return runtime.completeAndClaimNext(input)
    case 'report_failure':
      return runtime.reportFailure(input)
    case 'get_task_context':
      return runtime.getTaskContext(input)
  }
}

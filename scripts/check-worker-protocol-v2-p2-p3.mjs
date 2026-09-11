import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const store = read('apps/zero3-desktop/worker-runtime/v2/worker-store.ts')
const runtime = read('apps/zero3-desktop/worker-runtime/v2/workflow-worker-runtime.ts')
const rpc = read('apps/zero3-desktop/host-runtime/remote-worker-rpc.ts')
const gateway = read('apps/web/src/worker_gateway.rs')
const overlay = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')

for (const table of [
  'workflow_worker_bindings', 'worker_slots', 'physical_worker_sessions', 'work_items', 'stage_runs',
  'stage_dependencies', 'workflow_claims', 'workflow_claim_units', 'workflow_worker_events', 'worker_binding_generations'
]) requireText(store, table, `Worker Runtime v2 table missing: ${table}`)

for (const method of [
  'bootstrapWorker(', 'claimWorkV2(', 'reportProgressV2(', 'commitAndClaimNext(',
  'reportBlockedV2(', 'recoverWorker(', 'rotatePhysicalSession(', 'expireLeases('
]) requireText(runtime, method, `Worker Runtime v2 method missing: ${method}`)

for (const tool of [
  'bootstrap_worker', 'commit_and_claim_next', 'report_blocked', 'recover_worker',
  'task_bootstrap', 'dispatch_codex_task', 'verify_commit'
]) {
  requireText(rpc, `'${tool}'`, `Worker RPC v2 tool missing: ${tool}`)
  requireText(gateway, `\"${tool}\"`, `Private Gateway v2 tool missing: ${tool}`)
}
requireText(rpc, "'bindingTicket' in input", 'claim_work/report_progress must preserve v1/v2 polymorphic compatibility.')
requireText(gateway, 'const WORKER_TOOLS: [&str; 21]', 'Private Gateway v2 catalog size is stale.')
requireText(runtime, "status='COMPLETED'", 'StageRun commit path must persist completion before downstream release.')
requireText(runtime, 'recalculateStageReadiness', 'Per-item downstream Stage release is missing.')
requireText(runtime, 'verifyWorkerBindingTicket', 'Generation-fenced Binding Ticket verification is missing from Worker Runtime v2.')
requireText(overlay, 'zero3WorkflowWorkerRuntime', 'Desktop must compose Worker Runtime v2.')
requireText(overlay, "zero3:workflow-worker:ensure-run", 'Local Task/Workflow administration surface is missing.')

for (const source of [store, runtime, rpc]) {
  // Fast Path P0 adds the bounded `dispatch_codex_task` tool; the bare
  // `dispatch_codex` capability must stay absent from every layer.
  for (const forbidden of ["'dispatch_codex'", 'run_gpu', 'powershell', 'cmd.exe', 'child_process', 'shell.execute']) {
    forbidText(source, forbidden, `Worker Protocol v2 must not gain executor authority: ${forbidden}`)
  }
}

console.log('Zero3 Worker Protocol v2 P2/P3 guard passed: long-lived Workflow worker store/runtime + generation-fenced claims + per-item downstream release + private MCP v2 compatibility, without executor authority.')

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const gateway = read('apps/web/src/worker_gateway.rs')
const webMain = read('apps/web/src/main.rs')
const remoteTypes = read('apps/zero3-desktop/host-runtime/remote-types.ts')
const remoteConfig = read('apps/zero3-desktop/host-runtime/remote-config.ts')
const remoteClient = read('apps/zero3-desktop/host-runtime/remote-client.ts')
const remoteNode = read('apps/zero3-desktop/host-runtime/remote-node.ts')
const workerRpc = read('apps/zero3-desktop/host-runtime/remote-worker-rpc.ts')
const overlay = read('apps/zero3-desktop/scripts/apply-remote-host-runtime.mjs')
const design = read('docs/WEB_GPT_PRIVATE_GATEWAY_V1.md')

const tools = ['register_worker','claim_work','report_progress','complete_and_claim_next','report_failure','get_task_context','session_start','context_resolve','task_claim','event_record','artifact_register','task_complete','memory_commit','handoff_create','bootstrap_worker','commit_and_claim_next','report_blocked','recover_worker']
for (const tool of tools) {
  requireText(gateway, `"${tool}"`, `AWS Worker Gateway is missing ${tool}.`)
  requireText(workerRpc, `case '${tool}':`, `Local Worker RPC adapter is missing ${tool}.`)
}

requireText(webMain, 'worker_gateway::WorkerGatewayRuntime::from_env()', 'zero3-web must initialize the Worker Gateway explicitly.')
requireText(webMain, '.merge(worker_gateway::router(worker_gateway))', 'zero3-web must mount the private Worker MCP/host router.')
requireText(gateway, 'ZERO3_WORKER_MCP_TOKEN_FILE', 'ChatGPT-facing Worker MCP must use a dedicated secret file.')
requireText(gateway, 'ZERO3_WORKER_GATEWAY_NODE_ID', 'AWS Worker RPC must be pinned to an explicit local node id.')
requireText(gateway, 'MAX_WORKER_GATEWAY_BODY_BYTES: usize = 2 * 1024 * 1024', 'Worker Gateway HTTP payloads must stay explicitly bounded.')
requireText(gateway, 'validate_mcp_origin(&headers)?', 'Streamable HTTP MCP must validate supplied Origin headers.')
requireText(gateway, 'validate_mcp_protocol_header(&headers)?', 'Streamable HTTP MCP must validate supplied protocol-version headers.')
requireText(gateway, 'fencing_token', 'Cloud Worker RPC forwarding must preserve fencing generations.')
requireText(gateway, 'idempotencyKey', 'Cloud Worker RPC forwarding must preserve Worker Protocol idempotency keys.')
requireText(gateway, 'DEFAULT_REQUEST_TTL_SECONDS', 'Cloud Worker RPC forwarding must have a bounded request lifetime.')

requireText(remoteTypes, "| 'complete_and_claim_next'", 'Remote Worker RPC type union must include the atomic batch transition.')
requireText(remoteConfig, 'ZERO3_WORKER_TUNNEL_ENABLED', 'Worker Tunnel must have an independent enable flag.')
requireText(remoteNode, 'this.config.workerTunnelEnabled', 'Remote Node must start Worker Tunnel independently of Codex remote-task enablement.')
requireText(remoteNode, 'this.client.leaseWorkerRpc(25)', 'Local Zero3 must use outbound HTTPS long-polling for Worker RPC.')
requireText(remoteNode, 'await this.client.completeWorkerRpc(lease, result)', 'Local Zero3 must return successful Worker results through the narrow host route.')
requireText(remoteClient, "capabilities: ['worker-protocol-v1']", 'Worker RPC leasing must advertise only the bounded Worker capability.')
requireText(overlay, "'remote-worker-rpc.ts'", 'Prepared desktop must include the Worker RPC adapter.')
const lifecycleOverlay = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
requireText(lifecycleOverlay, '}, () => zero3WorkerRpcRuntime())', 'Prepared desktop must bind Remote Host Worker RPC to the composite V1 + Workflow Worker v2 + lifecycle runtime.')
requireText(design, 'local Worker Runtime (SQLite)', 'Gateway design must keep WorkUnit/Claim authority local.')

for (const forbidden of [
  'std::process::Command', 'tokio::process', 'thread/start', 'turn/start',
  'command/exec', 'ipcRenderer', 'ZERO3_PILOT_NODE_PORT'
]) {
  forbidText(gateway, forbidden, `Public Worker Gateway must not gain execution authority: ${forbidden}`)
}

for (const forbidden of ["runtime[lease.tool]", "runtime[tool]", 'dispatchCodex', 'runGpu', 'execCommand']) {
  forbidText(workerRpc, forbidden, `Worker RPC adapter must remain an exact bounded-tool switch: ${forbidden}`)
}

requireText(
  remoteNode,
  'Publishing the successful result is transport, not execution.',
  'Worker Tunnel must not turn result-publication failure into a false execution failure.'
)

console.log('Zero3 Web-GPT Worker Gateway V1 architecture guard passed: dedicated MCP auth -> durable fenced RPC queue -> outbound Worker-only host tunnel -> bounded Worker/Lifecycle adapter -> authoritative Task + Memory + Artifact runtimes.')

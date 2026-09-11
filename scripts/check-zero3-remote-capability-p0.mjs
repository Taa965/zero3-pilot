import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const gateway = read('apps/web/src/worker_gateway.rs')
const remoteTypes = read('apps/zero3-desktop/host-runtime/remote-types.ts')
const remoteNode = read('apps/zero3-desktop/host-runtime/remote-node.ts')
const remoteRpc = read('apps/zero3-desktop/host-runtime/remote-worker-rpc.ts')
const lifecycle = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
const contracts = read('apps/zero3-desktop/capability-runtime/contracts.ts')
const operationRuntime = read('apps/zero3-desktop/capability-runtime/operation-runtime.ts')
const policy = read('apps/zero3-desktop/capability-runtime/policy-port.ts')
const powershell = read('apps/zero3-desktop/capability-runtime/powershell-capability.ts')

for (const tool of ['list_capabilities','describe_capability','invoke_capability','get_operation','cancel_operation']) {
  requireText(gateway, `"${tool}"`, `Gateway is missing ZRCP tool ${tool}.`)
  requireText(remoteRpc, `case '${tool}':`, `Local remote RPC adapter is missing ${tool}.`)
}
requireText(gateway, 'const REMOTE_CAPABILITY: &str = "zero3-capability-v1"', 'ZRCP must have a separate gateway capability protocol.')
requireText(gateway, 'const CAPABILITY_TOOLS: [&str; 5]', 'ZRCP P0 catalog size changed without architecture review.')
requireText(remoteTypes, "export type Zero3CapabilityRpcTool", 'Remote types must distinguish ZRCP tools from Worker Protocol tools.')
requireText(remoteNode, "['worker-protocol-v1', 'zero3-capability-v1']", 'Local tunnel must explicitly advertise ZRCP separately from Worker Protocol.')
requireText(remoteRpc, "capability === 'zero3-capability-v1'", 'Local adapter must enforce tool/protocol separation.')
requireText(contracts, "ZERO3_REMOTE_CAPABILITY_PROTOCOL = 'zero3.remote-capability.v1'", 'Local capability contracts need an explicit protocol version.')
requireText(operationRuntime, 'class Zero3OperationRuntime', 'Long-running local execution must use Operation Runtime.')
requireText(operationRuntime, 'idempotencyKey was reused with different capability input', 'Capability invocation must fail closed on idempotency conflicts.')
requireText(policy, 'class EnvironmentZero3CapabilityPolicy', 'Capability execution must pass through a local policy port.')
requireText(policy, "ZERO3_CAPABILITY_POLICY_MODE", 'Operator-owned local capability policy mode is missing.')
requireText(powershell, "id: 'shell.powershell.execute'", 'P0 PowerShell capability is missing.')
requireText(powershell, "spawn(resolved.command", 'PowerShell execution must occur in the local Zero3 capability runtime.')
requireText(lifecycle, "createZero3CapabilityRuntime", 'Prepared Electron runtime must compose local Capability Runtime.')
requireText(lifecycle, "listCapabilities: input => zero3CapabilityRuntime.listCapabilities(input)", 'Remote RPC port must be backed by local Capability Runtime.')

for (const forbidden of ['std::process::Command', 'tokio::process', 'child_process', 'powershell.exe', 'cmd.exe']) {
  forbidText(gateway, forbidden, `AWS Gateway must remain transport-only and never gain local executor authority: ${forbidden}`)
}
for (const forbidden of ['powershell.exe', 'pwsh.exe', "spawn('powershell", "spawn('pwsh"]) {
  forbidText(remoteRpc, forbidden, `Remote RPC adapter must not implement PowerShell itself: ${forbidden}`)
}

console.log('Zero3 Remote Capability Protocol P0 guard passed: Web GPT -> transport-only MCP/AWS relay -> fenced outbound tunnel -> authoritative local Capability Registry/Operation Runtime/Policy -> local PowerShell execution.')

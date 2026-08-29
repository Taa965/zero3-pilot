import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8')
}

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message)
}

function forbidText(source, needle, message) {
  if (source.includes(needle)) throw new Error(message)
}

const constitution = read('docs/ARCHITECTURE_CONSTITUTION.md')
const remoteArchitecture = read('docs/REMOTE_HOST_RUNTIME.md')
const remoteProtocol = read('docs/REMOTE_TASK_PROTOCOL.md')
const prepare = read('apps/zero3-desktop/scripts/prepare-upstream.mjs')
const overlay = read('apps/zero3-desktop/scripts/apply-remote-host-runtime.mjs')
const taskRunner = read('apps/zero3-desktop/host-runtime/remote-task-runner.ts')
const remoteNode = read('apps/zero3-desktop/host-runtime/remote-node.ts')
const remoteClient = read('apps/zero3-desktop/host-runtime/remote-client.ts')
const remoteConfig = read('apps/zero3-desktop/host-runtime/remote-config.ts')

requireText(
  constitution,
  'Open-source Codex is the single authoritative Agent Kernel',
  'Remote Host work must preserve Codex as the single authoritative Agent Kernel.'
)
requireText(
  remoteArchitecture,
  'Zero3CodexAppServer',
  'Remote Host architecture must route into the existing Zero3CodexAppServer.'
)
requireText(remoteProtocol, 'zero3.pilot.remote-task.v1', 'Remote Task v1 protocol contract is missing.')
requireText(taskRunner, 'this.codex.startThread(', 'Remote tasks must enter Codex through the narrow Thread operation.')
requireText(taskRunner, 'this.codex.startTurn(', 'Remote tasks must enter Codex through the narrow Turn operation.')
requireText(taskRunner, 'this.codex.readThread(', 'Remote task completion must be observed from authoritative Codex Thread state.')
requireText(taskRunner, "approvalPolicy: 'on-request'", 'Remote tasks must retain on-request approvals.')
requireText(taskRunner, "sandbox: 'read-only'", 'H3 must not silently widen the existing default sandbox.')
requireText(taskRunner, 'zero3RemoteWorkspaceAllowed', 'Remote task workspaces must be locally allow-listed.')
requireText(remoteNode, 'this.client.lease(25)', 'Remote Host must use outbound task lease transport.')
requireText(remoteClient, 'authorization', 'Remote Host control-plane requests must be authenticated.')
requireText(remoteConfig, "parsed.protocol !== 'https:'", 'Remote Host production control plane must require HTTPS.')
requireText(overlay, 'Zero3RemoteNode', 'Desktop overlay must install the Remote Host runtime.')
requireText(overlay, "startThread: params => zero3CodexAppServer.request('thread/start', params)", 'Remote Host must adapt to the existing Codex app-server Thread boundary.')
requireText(overlay, "startTurn: (params, timeoutMs) => zero3CodexAppServer.request('turn/start', params, timeoutMs)", 'Remote Host must adapt to the existing Codex app-server Turn boundary.')
requireText(overlay, "readThread: params => zero3CodexAppServer.request('thread/read', params)", 'Remote Host must observe the existing Codex Thread boundary.')
requireText(prepare, 'applyZero3RemoteHostRuntime()', 'Desktop prepare must apply the Remote Host runtime overlay.')

for (const source of [taskRunner, remoteNode, remoteClient]) {
  for (const forbidden of ['ZERO3_PILOT_NODE_PORT', 'requestGateway(', 'zero3:chat:turn', 'hermes serve']) {
    forbidText(source, forbidden, `Remote Host must not regain legacy/Hermes runtime authority: ${forbidden}`)
  }
}

for (const forbidden of ['child_process.exec(', 'child_process.spawn(', 'execFile(', 'powershell.exe', 'cmd.exe /c']) {
  forbidText(taskRunner, forbidden, `Remote Task Runner must not implement a direct remote shell: ${forbidden}`)
  forbidText(remoteNode, forbidden, `Remote Node must not implement a direct remote shell: ${forbidden}`)
}

for (const forbidden of ["ipcRenderer.invoke('zero3:codex:rpc'", "ipcRenderer.invoke('zero3:codex:proxy'"]) {
  forbidText(overlay, forbidden, 'Remote Host must not expose a generic Renderer-controlled Codex RPC proxy.')
}

forbidText(taskRunner, 'request(method:', 'Remote Task Runner must not receive a generic Codex request method.')
forbidText(taskRunner, 'onEvent(', 'H3 uses authoritative Thread reads rather than patching the shared Codex event broadcaster.')
forbidText(overlay, 'zero3CodexLocalEventListeners', 'Remote Host must not mutate the shared Codex transport event broadcaster.')

console.log('Zero3 Remote Host architecture guard passed: outbound control plane -> typed Remote Task -> narrow existing Zero3CodexAppServer Thread/Turn/read adapter -> pinned Codex runtime.')

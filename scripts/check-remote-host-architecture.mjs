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
requireText(
  remoteProtocol,
  'zero3.pilot.remote-task.v1',
  'Remote Task v1 protocol contract is missing.'
)
requireText(
  taskRunner,
  "this.codex.request('thread/start'",
  'Remote tasks must create/resume work through typed Codex Thread operations.'
)
requireText(
  taskRunner,
  "'turn/start'",
  'Remote tasks must execute through Codex Turn operations.'
)
requireText(taskRunner, "approvalPolicy: 'on-request'", 'Remote tasks must retain on-request approvals.')
requireText(taskRunner, "sandbox: 'read-only'", 'H3 must not silently widen the existing default sandbox.')
requireText(taskRunner, 'zero3RemoteWorkspaceAllowed', 'Remote task workspaces must be locally allow-listed.')
requireText(remoteNode, 'this.client.lease(25)', 'Remote Host must use outbound task lease transport.')
requireText(remoteClient, 'authorization', 'Remote Host control-plane requests must be authenticated.')
requireText(remoteConfig, "parsed.protocol !== 'https:'", 'Remote Host production control plane must require HTTPS.')
requireText(overlay, 'Zero3RemoteNode', 'Desktop overlay must install the Remote Host runtime.')
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

console.log('Zero3 Remote Host architecture guard passed: outbound control plane -> typed Remote Task -> existing Zero3CodexAppServer -> pinned Codex Thread/Turn runtime.')

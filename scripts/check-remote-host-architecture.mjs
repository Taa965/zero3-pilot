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
const remoteProtocol = read('apps/zero3-desktop/host-runtime/remote-types.ts')
const prepare = read('apps/zero3-desktop/scripts/prepare-upstream.mjs')
const overlay = read('apps/zero3-desktop/scripts/apply-remote-host-runtime.mjs')
const taskRunner = read('apps/zero3-desktop/host-runtime/remote-task-runner.ts')
const mappingStore = read('apps/zero3-desktop/host-runtime/remote-mapping-store.ts')
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
requireText(remoteProtocol, 'pendingTurnClientId?: string', 'Durable task mapping must persist an unresolved Codex Turn intent.')
requireText(taskRunner, 'this.codex.startThread(', 'Remote tasks must enter Codex through the narrow Thread operation.')
requireText(taskRunner, 'this.codex.startTurn(', 'Remote tasks must enter Codex through the narrow Turn operation.')
requireText(taskRunner, 'this.codex.readThread(', 'Remote task completion must be observed from authoritative Codex Thread state.')
requireText(taskRunner, "approvalPolicy: 'on-request'", 'Remote tasks must retain on-request approvals.')
requireText(taskRunner, "sandbox: 'read-only'", 'H3 must not silently widen the existing default sandbox.')
requireText(taskRunner, 'zero3RemoteWorkspaceAllowed', 'Remote task workspaces must be locally allow-listed.')
requireText(taskRunner, 'this.mappings.get(task.task_id)', 'Remote task idempotency must consult durable task mapping state.')
requireText(taskRunner, 'await this.mappings.put(mapping)', 'Remote Codex Thread/Turn mappings must be persisted before later retries.')
requireText(taskRunner, 'mapping.pendingTurnClientId = clientUserMessageId', 'Remote Host must durably record Turn intent before turn/start.')
requireText(taskRunner, 'clientUserMessageId,', 'Remote Host must pass its deterministic Turn identity into pinned Codex.')
requireText(taskRunner, 'findTurnByClientId', 'Remote Host must recover uncertain Turn starts from authoritative Codex history.')
requireText(taskRunner, 'remote.turn.recovered', 'Recovered Codex Turns must be explicit evidence, not reported as new Turns.')
requireText(taskRunner, 'refusing to start a duplicate Turn', 'Unresolved persisted Turn intent must fail closed instead of replaying side effects.')
requireText(taskRunner, 'task_id is already bound to a different execution_id', 'task_id collisions must fail closed.')
requireText(taskRunner, 'target.base_ref requires a future Codex-authoritative Git preflight', 'Unsupported base_ref checks must fail closed rather than be guessed.')
requireText(taskRunner, 'execution.require_clean_worktree requires a future Codex-authoritative Git preflight', 'Unsupported clean-worktree checks must fail closed rather than bypass Codex.')
requireText(mappingStore, 'task-mappings.json', 'Durable task mapping state must remain an explicit host-owned artifact.')
requireText(mappingStore, 'fs.rename(temporary, this.file)', 'Task mapping updates must replace durable state atomically after writing a temporary file.')
requireText(remoteNode, 'error instanceof Zero3RemoteTaskBlockedError', 'Fail-closed preflight rejections must report blocked, not execution failure.')
requireText(remoteNode, 'error instanceof Zero3RemoteTaskOutcomeUnknownError', 'Uncertain Codex side effects must report outcome_unknown, never failed or succeeded.')
requireText(remoteNode, "? 'outcome_unknown'", 'Remote Host must publish the explicit outcome_unknown terminal state.')
requireText(remoteNode, 'this.client.lease(25)', 'Remote Host must use outbound task lease transport.')
requireText(remoteNode, 'this.client.renew(taskId, lease)', 'Remote Host must renew the active task lease while Codex runs.')
requireText(remoteNode, 'this.client.close()', 'Remote Host shutdown must cancel outstanding control-plane requests.')
requireText(remoteClient, 'authorization', 'Remote Host control-plane requests must be authenticated.')
requireText(remoteClient, 'AbortController', 'Remote Host requests must be bounded/cancellable.')
requireText(remoteClient, 'MAX_REQUEST_BYTES', 'Remote Host outbound payloads must be bounded.')
requireText(remoteConfig, "parsed.protocol !== 'https:'", 'Remote Host production control plane must require HTTPS.')
requireText(remoteConfig, 'ZERO3_REMOTE_HOST_MAPPING_STATE_FILE', 'Remote Host mapping-state path must be explicit and locally configurable.')
requireText(overlay, 'Zero3RemoteNode', 'Desktop overlay must install the Remote Host runtime.')
requireText(overlay, "'remote-mapping-store.ts'", 'Desktop overlay must ship the durable task mapping store.')
requireText(overlay, "startThread: params => zero3CodexAppServer.request('thread/start', params)", 'Remote Host must adapt to the existing Codex app-server Thread boundary.')
requireText(overlay, "startTurn: (params, timeoutMs) => zero3CodexAppServer.request('turn/start', params, timeoutMs)", 'Remote Host must adapt to the existing Codex app-server Turn boundary.')
requireText(overlay, "readThread: params => zero3CodexAppServer.request('thread/read', params)", 'Remote Host must observe the existing Codex Thread boundary.')
requireText(prepare, 'applyZero3RemoteHostRuntime()', 'Desktop prepare must apply the Remote Host runtime overlay.')

for (const source of [taskRunner, mappingStore, remoteNode, remoteClient]) {
  for (const forbidden of ['ZERO3_PILOT_NODE_PORT', 'requestGateway(', 'zero3:chat:turn', 'hermes serve']) {
    forbidText(source, forbidden, `Remote Host must not regain legacy/Hermes runtime authority: ${forbidden}`)
  }
}

for (const forbidden of ['child_process', 'exec(', 'spawn(', 'execFile(', 'powershell.exe', 'cmd.exe /c', 'simple-git']) {
  forbidText(taskRunner, forbidden, `Remote Task Runner must not implement a direct remote shell/Git bypass: ${forbidden}`)
  forbidText(mappingStore, forbidden, `Remote mapping state must not execute commands: ${forbidden}`)
  forbidText(remoteNode, forbidden, `Remote Node must not implement a direct remote shell/Git bypass: ${forbidden}`)
}

for (const forbidden of ["ipcRenderer.invoke('zero3:codex:rpc'", "ipcRenderer.invoke('zero3:codex:proxy'"]) {
  forbidText(overlay, forbidden, 'Remote Host must not expose a generic Renderer-controlled Codex RPC proxy.')
}

forbidText(taskRunner, 'request(method:', 'Remote Task Runner must not receive a generic Codex request method.')
forbidText(taskRunner, 'onEvent(', 'H3 uses authoritative Thread reads rather than patching the shared Codex event broadcaster.')
forbidText(overlay, 'zero3CodexLocalEventListeners', 'Remote Host must not mutate the shared Codex transport event broadcaster.')

console.log('Zero3 Remote Host architecture guard passed: outbound control plane -> durable task/turn intent -> narrow existing Zero3CodexAppServer Thread/Turn/read adapter -> pinned Codex runtime, with at-most-once Turn recovery, fail-closed Git preconditions and no shell/Git bypass.')

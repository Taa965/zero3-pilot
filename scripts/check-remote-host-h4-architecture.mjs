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

const design = read('docs/H4_REMOTE_OUTBOX_DESIGN.md')
const types = read('apps/zero3-desktop/host-runtime/remote-types.ts')
const config = read('apps/zero3-desktop/host-runtime/remote-config.ts')
const client = read('apps/zero3-desktop/host-runtime/remote-client.ts')
const outbox = read('apps/zero3-desktop/host-runtime/remote-outbox.ts')
const node = read('apps/zero3-desktop/host-runtime/remote-node.ts')
const overlay = read('apps/zero3-desktop/scripts/apply-remote-host-runtime.mjs')

requireText(design, 'Network publication must not happen before durable persistence.', 'H4 must preserve outbox-before-network ordering.')
requireText(types, "kind: 'event'", 'H4 event envelope contract is missing.')
requireText(types, "kind: 'terminal'", 'H4 terminal envelope contract is missing.')
requireText(types, 'deliveryId: string', 'H4 deliveries need stable local identity.')
requireText(types, 'eventSequence: number', 'H4 events need durable sequence identity.')
requireText(types, 'outboxDir: string', 'H4 outbox storage must be explicit host configuration.')
requireText(config, 'ZERO3_REMOTE_HOST_OUTBOX_DIR', 'H4 outbox path must be locally configurable.')
requireText(outbox, 'MAX_OUTBOX_ENTRIES', 'H4 outbox must be bounded.')
requireText(outbox, 'MAX_ENVELOPE_BYTES', 'H4 envelope size must be bounded before persistence.')
requireText(outbox, 'await handle.sync()', 'H4 committed envelopes/cursors must be fsynced before rename.')
requireText(outbox, 'await fs.rename(temporary, file)', 'H4 persistence must use atomic replacement after durable temp write.')
requireText(outbox, "path.join(rootDir, 'pending')", 'H4 must distinguish committed pending envelopes.')
requireText(outbox, "path.join(rootDir, 'cursors')", 'H4 must persist event sequence cursors across restarts.')
requireText(outbox, "path.join(rootDir, 'quarantine')", 'H4 must preserve stale/rejected envelopes for audit.')
requireText(outbox, 'Math.max(persisted, pendingMaximum) + 1', 'H4 event sequence must recover safely from a crash between envelope and cursor persistence.')
requireText(client, 'publishEnvelope(envelope:', 'H4 transport must replay a preserved durable envelope.')
requireText(client, 'delivery_id: envelope.deliveryId', 'H4 replay must preserve delivery identity.')
requireText(client, 'fencing_token: envelope.fencingToken', 'H4 replay must preserve original fencing identity.')
requireText(client, 'created_at: envelope.createdAt', 'H4 replay must preserve original envelope time.')
requireText(client, 'zero3RemoteControlPlaneRejectedStaleEnvelope', 'H4 must distinguish stale fencing rejection from transient delivery failure.')
requireText(node, 'private readonly outbox = new Zero3RemoteOutbox', 'Remote Node must own the durable H4 outbox.')
requireText(node, 'await this.flushOutbox()', 'Remote Node must replay durable envelopes after reconnect and before new leases.')
requireText(node, "await this.durableEvent(lease, 'host.accepted'", 'Task acceptance must enter the durable outbox before Codex side effects.')
requireText(node, 'await this.outbox.enqueueTerminal(lease, result.state, result)', 'Successful/terminal Codex outcomes must be durable before publication.')
requireText(node, 'terminalDurable = true', 'Terminal delivery failure must not be converted into a different local terminal outcome.')
requireText(node, 'this.activeLeaseInvalid = true', 'Known stale fencing must stop further authoritative publication for the active lease.')
requireText(node, "return 'quarantined'", 'Known stale envelopes must be quarantined rather than silently acknowledged.')
requireText(overlay, "'remote-outbox.ts'", 'Prepared Electron runtime must ship the H4 outbox implementation.')

for (const source of [outbox, node]) {
  for (const forbidden of ['child_process', 'exec(', 'spawn(', 'powershell.exe', 'cmd.exe /c', 'simple-git']) {
    forbidText(source, forbidden, `H4 delivery infrastructure must not become a shell/Git execution path: ${forbidden}`)
  }
}

forbidText(outbox, 'authorization', 'Bearer credentials must never be persisted in the H4 outbox.')
forbidText(outbox, 'tokenFile', 'H4 outbox must not persist or read control-plane credentials.')
forbidText(node, "ipcRenderer.invoke('zero3:codex:rpc'", 'H4 must not add a renderer-controlled generic Codex RPC channel.')

console.log('Zero3 Remote Host H4 architecture guard passed: durable bounded outbox -> preserved delivery/fencing identity -> replay/ack/quarantine, with Codex remaining the sole Agent Kernel.')

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-remote-publication-order-'))
const workspace = path.join(root, 'workspace')
const tokenFile = path.join(root, 'host.token')
const mappingFile = path.join(root, 'task-mappings.json')
const outboxDir = path.join(root, 'outbox')

await fs.mkdir(workspace, { recursive: true })
await fs.writeFile(tokenFile, 'test-token\n', { encoding: 'utf8', mode: 0o600 })

process.env.ZERO3_REMOTE_HOST_ENABLED = 'true'
process.env.ZERO3_REMOTE_HOST_BASE_URL = 'http://127.0.0.1:1'
process.env.ZERO3_REMOTE_HOST_ALLOW_HTTP = 'true'
process.env.ZERO3_REMOTE_HOST_TOKEN_FILE = tokenFile
process.env.ZERO3_REMOTE_HOST_NODE_ID = 'ordered-publication-test'
process.env.ZERO3_REMOTE_HOST_WORKSPACES = workspace
process.env.ZERO3_REMOTE_HOST_MAPPING_STATE_FILE = mappingFile
process.env.ZERO3_REMOTE_HOST_OUTBOX_DIR = outboxDir

const { Zero3RemoteNode } = await import('../apps/zero3-desktop/host-runtime/remote-node.ts')

const codex = {
  async startThread() {
    return { thread: { id: 'unused-thread' } }
  },
  async startTurn() {
    return { turn: { id: 'unused-turn' } }
  },
  async readThread() {
    return { thread: { id: 'unused-thread', turns: [] } }
  }
}

const lease = {
  lease_id: 'lease-order-1',
  fencing_token: 11,
  task: {
    protocol: 'zero3.pilot.remote-task.v1',
    task_id: 'task-order-1',
    execution_id: 'exec-order-1',
    objective: 'verify ordered publication',
    target: { workspace }
  }
}

let node
try {
  node = new Zero3RemoteNode(codex)
  const calls = []
  let transientFailuresRemaining = 1

  node.client.publishEnvelope = async envelope => {
    calls.push(
      envelope.kind === 'event'
        ? `event:${envelope.eventSequence}:${envelope.eventType}`
        : `terminal:${envelope.state}`
    )
    if (transientFailuresRemaining > 0) {
      transientFailuresRemaining -= 1
      throw new Error('simulated transient publication failure')
    }
  }

  // Event #1 is durably stored but its first network attempt fails.
  await node.durableEvent(lease, 'evidence.one', { value: 1 }, false)
  assert.equal(await node.outbox.count(), 1)
  assert.deepEqual(calls, ['event:1:evidence.one'])

  // Event #2 must not bypass #1. The second durableEvent call must first
  // replay #1, acknowledge it, and only then publish #2.
  await node.durableEvent(lease, 'evidence.two', { value: 2 }, false)
  assert.equal(await node.outbox.count(), 0)
  assert.deepEqual(calls, [
    'event:1:evidence.one',
    'event:1:evidence.one',
    'event:2:evidence.two'
  ])

  // Repeat the failure immediately before a terminal outcome. The terminal
  // must drain the older evidence first rather than overtaking it.
  transientFailuresRemaining = 1
  await node.durableEvent(lease, 'evidence.three', { value: 3 }, false)
  assert.equal(await node.outbox.count(), 1)

  transientFailuresRemaining = 0
  await node.durableTerminal(lease, 'succeeded', { summary: 'done' })
  assert.equal(await node.outbox.count(), 0)
  assert.deepEqual(calls.slice(-3), [
    'event:3:evidence.three',
    'event:3:evidence.three',
    'terminal:succeeded'
  ])

  console.log('Zero3 Remote Host ordered publication behavior passed.')
} finally {
  node?.stop()
  await fs.rm(root, { recursive: true, force: true })
}

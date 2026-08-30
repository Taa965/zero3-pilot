import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Zero3RemoteOutbox } from '../apps/zero3-desktop/host-runtime/remote-outbox.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-remote-outbox-'))

const lease = {
  lease_id: 'lease-1',
  fencing_token: 7,
  task: {
    protocol: 'zero3.pilot.remote-task.v1',
    task_id: 'task-1',
    execution_id: 'exec-1',
    objective: 'test',
    target: { workspace: 'C:\\workspace' }
  }
}

try {
  const firstProcess = new Zero3RemoteOutbox(root)
  const accepted = await firstProcess.enqueueEvent(lease, 'host.accepted', { node_id: 'node-1' })
  assert.equal(accepted.eventSequence, 1)
  assert.equal(await firstProcess.count(), 1)

  // A new instance simulates an Electron restart. Sequence allocation must
  // continue from durable cursor state rather than reset to one.
  const secondProcess = new Zero3RemoteOutbox(root)
  const running = await secondProcess.enqueueEvent(lease, 'codex.remote.turn.status', { status: 'inProgress' })
  assert.equal(running.eventSequence, 2)
  assert.equal(await secondProcess.count(), 2)

  await secondProcess.ack(accepted.deliveryId)
  assert.equal(await secondProcess.count(), 1)

  const thirdProcess = new Zero3RemoteOutbox(root)
  const completed = await thirdProcess.enqueueEvent(lease, 'codex.remote.turn.status', { status: 'completed' })
  assert.equal(completed.eventSequence, 3, 'acknowledgement must not rewind the durable event cursor')

  const terminal = await thirdProcess.enqueueTerminal(lease, 'succeeded', { terminal: { status: 'completed' } })
  const pending = await thirdProcess.list()
  assert.ok(pending.some(item => item.deliveryId === running.deliveryId))
  assert.ok(pending.some(item => item.deliveryId === completed.deliveryId))
  assert.ok(pending.some(item => item.deliveryId === terminal.deliveryId))

  // ISO timestamps have millisecond precision. If two committed events share
  // the same createdAt, replay must still honor their durable eventSequence.
  const sameTime = '2026-08-30T00:00:00.000Z'
  for (const event of [running, completed]) {
    const file = path.join(root, 'pending', `${event.deliveryId}.json`)
    const stored = JSON.parse(await fs.readFile(file, 'utf8'))
    stored.createdAt = sameTime
    await fs.writeFile(file, `${JSON.stringify(stored)}\n`, 'utf8')
  }
  const sameTimeReplay = (await thirdProcess.list()).filter(
    item => item.kind === 'event' && item.taskId === lease.task.task_id && item.createdAt === sameTime
  )
  assert.deepEqual(
    sameTimeReplay.map(item => item.eventSequence),
    [2, 3],
    'same-millisecond replay must preserve per-task event sequence ordering'
  )

  await thirdProcess.quarantine(running, 'stale fencing token')
  assert.ok(!(await thirdProcess.list()).some(item => item.deliveryId === running.deliveryId))
  const quarantineFiles = await fs.readdir(path.join(root, 'quarantine'))
  assert.ok(quarantineFiles.includes(`${running.deliveryId}.json`))
  assert.ok(quarantineFiles.includes(`${running.deliveryId}.reason.json`))

  await assert.rejects(
    () => thirdProcess.enqueueEvent(lease, 'oversized', { text: 'x'.repeat(2 * 1024 * 1024) }),
    /exceeds the local size limit/
  )

  const afterOversize = await thirdProcess.enqueueEvent(lease, 'after.oversize', {})
  assert.equal(afterOversize.eventSequence, 4, 'failed persistence must not consume a durable sequence')

  // Corrupt committed pending data must stop replay rather than be silently
  // ignored as if the remote mirror were complete.
  const corruptId = '00000000-0000-4000-8000-000000000000'
  await fs.writeFile(path.join(root, 'pending', `${corruptId}.json`), '{not-json', 'utf8')
  await assert.rejects(() => thirdProcess.list(), /invalid Zero3 Remote Host outbox JSON/)

  console.log('Zero3 Remote Host H4 durable outbox behavior passed.')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

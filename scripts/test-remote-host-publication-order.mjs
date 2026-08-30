import assert from 'node:assert/strict'

import { drainZero3RemoteOutboxInOrder } from '../apps/zero3-desktop/host-runtime/remote-outbox-drain.ts'

function event(deliveryId, sequence, eventType) {
  return {
    schemaVersion: 1,
    kind: 'event',
    deliveryId,
    taskId: 'task-order-1',
    executionId: 'exec-order-1',
    leaseId: 'lease-order-1',
    fencingToken: 11,
    createdAt: `2026-08-30T00:00:0${sequence}.000Z`,
    eventSequence: sequence,
    eventType,
    payload: { sequence }
  }
}

function terminal(deliveryId) {
  return {
    schemaVersion: 1,
    kind: 'terminal',
    deliveryId,
    taskId: 'task-order-1',
    executionId: 'exec-order-1',
    leaseId: 'lease-order-1',
    fencingToken: 11,
    createdAt: '2026-08-30T00:00:09.000Z',
    state: 'succeeded',
    result: { summary: 'done' }
  }
}

const first = event('00000000-0000-4000-8000-000000000001', 1, 'evidence.one')
const second = event('00000000-0000-4000-8000-000000000002', 2, 'evidence.two')
const third = event('00000000-0000-4000-8000-000000000003', 3, 'evidence.three')
const done = terminal('00000000-0000-4000-8000-000000000004')

const calls = []
let transientFailuresRemaining = 1
async function publish(envelope) {
  calls.push(
    envelope.kind === 'event'
      ? `event:${envelope.eventSequence}:${envelope.eventType}`
      : `terminal:${envelope.state}`
  )
  if (transientFailuresRemaining > 0) {
    transientFailuresRemaining -= 1
    throw new Error('simulated transient publication failure')
  }
  return 'published'
}

// A transient failure on event #1 must stop the drain immediately. Event #2
// is present in the same durable snapshot but is not allowed to overtake it.
await assert.rejects(
  () => drainZero3RemoteOutboxInOrder([first, second], publish, second.deliveryId),
  /simulated transient publication failure/
)
assert.deepEqual(calls, ['event:1:evidence.one'])

// On retry the same oldest committed envelope is attempted first, followed by
// event #2 only after event #1 succeeds.
const eventResult = await drainZero3RemoteOutboxInOrder([first, second], publish, second.deliveryId)
assert.equal(eventResult, 'published')
assert.deepEqual(calls, [
  'event:1:evidence.one',
  'event:1:evidence.one',
  'event:2:evidence.two'
])

// The same invariant applies to terminal publication: an older evidence
// envelope must succeed before the terminal outcome is allowed onto the wire.
transientFailuresRemaining = 1
await assert.rejects(
  () => drainZero3RemoteOutboxInOrder([third, done], publish, done.deliveryId),
  /simulated transient publication failure/
)
assert.equal(calls.at(-1), 'event:3:evidence.three')

transientFailuresRemaining = 0
const terminalResult = await drainZero3RemoteOutboxInOrder([third, done], publish, done.deliveryId)
assert.equal(terminalResult, 'published')
assert.deepEqual(calls.slice(-3), [
  'event:3:evidence.three',
  'event:3:evidence.three',
  'terminal:succeeded'
])

// If publication is disabled for the oldest envelope (shutdown or known stale
// active lease), the drain stops before any later envelope can bypass it.
const blockedCalls = []
const blocked = await drainZero3RemoteOutboxInOrder(
  [first, second],
  async envelope => {
    blockedCalls.push(envelope.deliveryId)
    return 'published'
  },
  second.deliveryId,
  envelope => envelope.deliveryId !== first.deliveryId
)
assert.equal(blocked, null)
assert.deepEqual(blockedCalls, [])

console.log('Zero3 Remote Host ordered publication behavior passed.')

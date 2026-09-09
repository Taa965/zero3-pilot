import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpSyncSocket } from './http-sync-socket.mjs'

test('HTTP catchup waits for durable ACK and drains every page before ready', async () => {
  const requests = [], frames = []
  let complete
  const done = new Promise(resolve => { complete = resolve })
  const socket = createHttpSyncSocket({ baseUrl: 'http://127.0.0.1:8791', token: 'test', pollMs: 60000, fetchImpl: async url => {
    const after = Number(new URL(url).searchParams.get('after')); requests.push(after)
    return { ok: true, json: async () => ({ events: after < 2 ? [{ sequence: after + 1, event: { event_id: `event-${after + 1}` } }] : [] }) }
  } })
  const deadline = setTimeout(() => { socket.close(); complete(new Error('catchup timed out')) }, 2000)
  socket.onError(error => complete(error))
  socket.onMessage(raw => {
    const frame = JSON.parse(raw); frames.push(frame)
    if (frame.type === 'events') setTimeout(() => socket.send(JSON.stringify({ type: 'ack', sequence: frame.events[0].sequence })), 10)
    if (frame.type === 'ready') complete()
  })
  socket.onOpen(() => socket.send(JSON.stringify({ type: 'hello', projects: ['project-a'], last_sequence: 0 })))
  try {
    const error = await done; if (error) throw error
    assert.deepEqual(requests, [0, 1, 2])
    assert.deepEqual(frames.map(f => f.type), ['events', 'events', 'ready'])
    assert.equal(frames.at(-1).latest_sequence, 2)
  } finally { clearTimeout(deadline); socket.close() }
})

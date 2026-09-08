import assert from 'node:assert/strict'
import test from 'node:test'

import { MemorySyncClient, MemorySyncError } from './memory-sync-client.mjs'

class FakeStore {
  cursor = null
  cached = []
  pending = []
  sending = []
  acked = []
  conflicts = []
  rejected = []
  resets = 0

  async getCursor() { return this.cursor }
  async setCursor(clientId, deviceId, sequence) {
    if (!this.cursor || sequence > this.cursor.last_sequence) this.cursor = { client_id: clientId, device_id: deviceId, last_sequence: sequence }
  }
  async cacheServerEvent(sequence, eventId, event) { this.cached.push({ sequence, eventId, event }) }
  async nextBatch(limit) { return this.pending.slice(0, limit) }
  async markSending(ids) { this.sending.push(...ids); this.pending = this.pending.filter(item => !ids.includes(item.event_id)) }
  async markAcked(id, sequence) { this.acked.push({ id, sequence }) }
  async markConflict(id, error) { this.conflicts.push({ id, error }) }
  async markRejected(id, error) { this.rejected.push({ id, error }) }
  async resetInflight() { this.resets += 1 }
}

class FakeSocket {
  sent = []
  closed = false
  #open = null
  #message = null
  #close = null
  #error = null
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.closed = true }
  onOpen(handler) { this.#open = handler }
  onMessage(handler) { this.#message = handler }
  onClose(handler) { this.#close = handler }
  onError(handler) { this.#error = handler }
  emitOpen() { this.#open?.() }
  emitMessage(value) { this.#message?.(JSON.stringify(value)) }
  emitClose() { this.#close?.() }
  emitError(error) { this.#error?.(error) }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function makeClient(overrides = {}) {
  const store = overrides.store ?? new FakeStore()
  const socket = overrides.socket ?? new FakeSocket()
  const errors = []
  const states = []
  const client = new MemorySyncClient({
    baseUrl: 'https://memory.example.test',
    token: 'abcdefghijklmnopqrstuvwxyz123456',
    clientId: 'pilot-test',
    deviceId: 'desktop-main',
    projects: ['project-a'],
    store,
    socketFactory: overrides.socketFactory ?? (async (url, options) => {
      assert.equal(url, 'wss://memory.example.test/v1/sync')
      assert.equal(options.headers.authorization, 'Bearer abcdefghijklmnopqrstuvwxyz123456')
      return socket
    }),
    fetchImpl: overrides.fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) })),
    setTimeoutImpl: overrides.setTimeoutImpl,
    clearTimeoutImpl: overrides.clearTimeoutImpl,
    backoff: [1, 2],
    onError: error => errors.push(error),
    onState: state => states.push(state)
  })
  return { client, store, socket, errors, states }
}

test('startup catchup advances cursor event-by-event and ACKs', async () => {
  const { client, store, socket } = makeClient()
  await client.start()
  socket.emitOpen()
  await tick()
  assert.deepEqual(socket.sent[0], {
    type: 'hello', protocol: 'zero3.memory.sync.v1', client_id: 'pilot-test', device_id: 'desktop-main', last_sequence: 0, projects: ['project-a']
  })
  socket.emitMessage({ type: 'ready', latest_sequence: 2 })
  socket.emitMessage({ type: 'events', from_sequence: 1, to_sequence: 2, events: [
    { sequence: 1, event: { event_id: 'evt-1', payload: { value: 1 } } },
    { sequence: 2, event: { event_id: 'evt-2', payload: { value: 2 } } }
  ] })
  await tick()
  assert.deepEqual(store.cached.map(item => item.sequence), [1, 2])
  assert.equal(store.cursor.last_sequence, 2)
  assert.deepEqual(socket.sent.filter(item => item.type === 'ack').map(item => item.sequence), [1, 2])
  await client.stop()
})

test('live memory.changed is persisted before ACK', async () => {
  const { client, store, socket } = makeClient()
  await client.start()
  socket.emitOpen()
  socket.emitMessage({ type: 'ready', latest_sequence: 3 })
  socket.emitMessage({ type: 'memory.changed', sequence: 3, event: { event_id: 'evt-3', payload: { ok: true } } })
  await tick()
  assert.equal(store.cached[0].eventId, 'evt-3')
  assert.equal(store.cursor.last_sequence, 3)
  assert.equal(socket.sent.at(-1).type, 'ack')
  assert.equal(socket.sent.at(-1).sequence, 3)
  await client.stop()
})

test('offline batch results become ack/conflict/rejected states', async () => {
  const store = new FakeStore()
  store.pending = [
    { event_id: 'evt-a', payload: { event_id: 'evt-a' } },
    { event_id: 'evt-b', payload: { event_id: 'evt-b' } },
    { event_id: 'evt-c', payload: { event_id: 'evt-c' } }
  ]
  const { client } = makeClient({
    store,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://memory.example.test/v1/memory/events:batch')
      assert.equal(options.headers.authorization, 'Bearer abcdefghijklmnopqrstuvwxyz123456')
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [
          { event_id: 'evt-a', status: 'accepted', sequence: 10 },
          { event_id: 'evt-b', status: 'conflict', error: 'entity_version_conflict' },
          { event_id: 'evt-c', status: 'rejected', error: 'authority_denied' }
        ] })
      }
    }
  })
  await client.start()
  await client.flushPending()
  assert.deepEqual(store.sending, ['evt-a', 'evt-b', 'evt-c'])
  assert.deepEqual(store.acked, [{ id: 'evt-a', sequence: 10 }])
  assert.deepEqual(store.conflicts, [{ id: 'evt-b', error: 'entity_version_conflict' }])
  assert.deepEqual(store.rejected, [{ id: 'evt-c', error: 'authority_denied' }])
  await client.stop()
})

test('network failure resets inflight queue for later retry', async () => {
  const store = new FakeStore()
  store.pending = [{ event_id: 'evt-a', payload: { event_id: 'evt-a' } }]
  const { client } = makeClient({ store, fetchImpl: async () => { throw new Error('offline') } })
  await client.start()
  const resetsAfterStart = store.resets
  await assert.rejects(() => client.flushPending(), error => error instanceof MemorySyncError && error.code === 'batch_network_error')
  assert.equal(store.resets, resetsAfterStart + 1)
  await client.stop()
})

test('socket close schedules bounded reconnect', async () => {
  const callbacks = []
  const socketA = new FakeSocket()
  const socketB = new FakeSocket()
  let calls = 0
  const { client } = makeClient({
    socket: socketA,
    socketFactory: async () => calls++ === 0 ? socketA : socketB,
    setTimeoutImpl: (callback, delay) => { callbacks.push({ callback, delay }); return callbacks.length },
    clearTimeoutImpl: () => {}
  })
  await client.start()
  socketA.emitOpen()
  socketA.emitClose()
  assert.equal(callbacks[0].delay, 1)
  callbacks[0].callback()
  await tick()
  assert.equal(calls, 2)
  await client.stop()
})

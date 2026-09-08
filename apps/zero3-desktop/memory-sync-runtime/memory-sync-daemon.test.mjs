import assert from 'node:assert/strict'
import test from 'node:test'

import { createWsSocketFactory, memorySyncConfig } from './memory-sync-daemon.mjs'

test('memory sync is opt-in and fail-closed', () => {
  assert.equal(memorySyncConfig({}), null)
  assert.throws(() => memorySyncConfig({ ZERO3_MEMORY_AUTHORITY_V2: '1' }), /ZERO3_MEMORY_AUTHORITY_URL/)
  const config = memorySyncConfig({
    ZERO3_MEMORY_AUTHORITY_V2: '1',
    ZERO3_MEMORY_AUTHORITY_URL: 'https://memory.example.test',
    ZERO3_MEMORY_AUTHORITY_TOKEN: 'abcdefghijklmnopqrstuvwxyz123456',
    ZERO3_MEMORY_CLIENT_ID: 'pilot-main',
    ZERO3_MEMORY_DEVICE_ID: 'desktop-main',
    ZERO3_MEMORY_PROJECTS: '["*"]',
    ZERO3_MEMORY_SYNC_DB: './tmp/memory.sqlite'
  })
  assert.equal(config.clientId, 'pilot-main')
  assert.deepEqual(config.projects, ['*'])
  assert.match(config.databasePath, /memory\.sqlite$/)
})

class FakeWs {
  static latest = null
  handlers = new Map()
  sent = []
  constructor(url, protocols, options) {
    this.url = url; this.protocols = protocols; this.options = options
    FakeWs.latest = this
  }
  on(name, handler) { this.handlers.set(name, handler); return this }
  once(name, handler) { this.handlers.set(name, handler); return this }
  send(value) { this.sent.push(value) }
  close() {}
}

test('ws transport keeps bearer token in headers', async () => {
  const factory = createWsSocketFactory(FakeWs)
  const port = await factory('wss://memory.example.test/v1/sync', {
    protocol: 'zero3.memory.sync.v1',
    headers: { authorization: 'Bearer secret-token' }
  })
  assert.equal(FakeWs.latest.url, 'wss://memory.example.test/v1/sync')
  assert.deepEqual(FakeWs.latest.protocols, ['zero3.memory.sync.v1'])
  assert.equal(FakeWs.latest.options.headers.authorization, 'Bearer secret-token')
  let opened = false
  port.onOpen(() => { opened = true })
  FakeWs.latest.handlers.get('open')()
  assert.equal(opened, true)
  port.send('hello')
  assert.deepEqual(FakeWs.latest.sent, ['hello'])
})

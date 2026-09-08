import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemorySyncClient } from './memory-sync-client.mjs'
import { createSqliteMemorySyncStore } from './memory-sync-sqlite-store.mjs'

function required(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}
function projects(value) {
  const text = required(value, 'ZERO3_MEMORY_PROJECTS')
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text.split(',') }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('ZERO3_MEMORY_PROJECTS must contain at least one project')
  return [...new Set(parsed.map(item => required(String(item), 'project id')))]
}

export function memorySyncConfig(env = process.env) {
  if (env.ZERO3_MEMORY_AUTHORITY_V2 !== '1') return null
  const baseUrl = required(env.ZERO3_MEMORY_AUTHORITY_URL, 'ZERO3_MEMORY_AUTHORITY_URL')
  const token = required(env.ZERO3_MEMORY_AUTHORITY_TOKEN ?? (env.ZERO3_MEMORY_AUTHORITY_TOKEN_FILE ? readFileSync(path.resolve(env.ZERO3_MEMORY_AUTHORITY_TOKEN_FILE), 'utf8').trim() : ''), 'ZERO3_MEMORY_AUTHORITY_TOKEN or ZERO3_MEMORY_AUTHORITY_TOKEN_FILE')
  if (token.length < 24) throw new Error('ZERO3_MEMORY_AUTHORITY_TOKEN must be at least 24 characters')
  return {
    baseUrl,
    token,
    clientId: required(env.ZERO3_MEMORY_CLIENT_ID, 'ZERO3_MEMORY_CLIENT_ID'),
    deviceId: required(env.ZERO3_MEMORY_DEVICE_ID, 'ZERO3_MEMORY_DEVICE_ID'),
    projects: projects(env.ZERO3_MEMORY_PROJECTS),
    databasePath: path.resolve(required(env.ZERO3_MEMORY_SYNC_DB, 'ZERO3_MEMORY_SYNC_DB'))
  }
}

export function createWsSocketFactory(WebSocketCtor) {
  if (typeof WebSocketCtor !== 'function') throw new Error('WebSocket constructor is required')
  return async (url, options = {}) => {
    const protocols = options.protocol ? [options.protocol] : undefined
    const socket = new WebSocketCtor(url, protocols, { headers: options.headers ?? {} })
    return {
      send: value => socket.send(value),
      close: () => socket.close(),
      onOpen: handler => socket.once('open', handler),
      onMessage: handler => socket.on('message', data => handler(data.toString())),
      onClose: handler => socket.once('close', handler),
      onError: handler => {
        socket.once('error', handler)
        socket.once('unexpected-response', (_request, response) => {
          const error = Object.assign(new Error(`memory websocket returned HTTP ${response.statusCode}`), { statusCode: response.statusCode })
          handler(error)
        })
      }
    }
  }
}

export function defaultDeviceLabel() {
  return `${os.hostname()}-${process.platform}`
}
async function run() {
  const config = memorySyncConfig()
  if (!config) return
  const { WebSocket } = await import('ws')
  const store = createSqliteMemorySyncStore(config.databasePath)
  const client = new MemorySyncClient({
    ...config,
    store,
    socketFactory: createWsSocketFactory(WebSocket),
    fetchImpl: globalThis.fetch,
    onState: state => console.log('[zero3-memory-sync]', JSON.stringify(state)),
    onError: error => console.error('[zero3-memory-sync]', error?.stack ?? error?.message ?? String(error))
  })
  const stop = async () => {
    await client.stop().catch(() => {})
    store.close()
  }
  process.once('SIGINT', () => { void stop().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)) })
  await client.start()
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  run().catch(error => {
    console.error('[zero3-memory-sync] fatal', error?.stack ?? error?.message ?? String(error))
    process.exitCode = 1
  })
}

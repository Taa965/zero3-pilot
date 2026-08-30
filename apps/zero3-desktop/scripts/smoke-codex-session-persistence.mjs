import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const binary = process.argv[2]
if (!binary) throw new Error('Usage: node smoke-codex-session-persistence.mjs <codex-binary>')
if (!fs.existsSync(binary)) throw new Error(`Codex binary does not exist: ${binary}`)

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-codex-session-persistence-'))

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function threadIdFrom(result) {
  const id = record(record(result).thread).id
  if (typeof id !== 'string' || !id.trim()) throw new Error('thread/start did not return thread.id')
  return id
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createClient() {
  const child = spawn(binary, ['app-server', '--stdio'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let buffer = ''
  let stderr = ''
  let nextId = 1
  const pending = new Map()

  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-16_000)
  })

  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue

      let message
      try {
        message = JSON.parse(line)
      } catch {
        for (const item of pending.values()) item.reject(new Error('Codex app-server emitted invalid JSONL'))
        pending.clear()
        continue
      }

      if ((typeof message.id === 'number' || typeof message.id === 'string') && message.method) {
        child.stdin.write(
          JSON.stringify({ id: message.id, error: { code: -32001, message: 'Zero3 CI is non-interactive.' } }) + '\n'
        )
        continue
      }

      if (typeof message.id !== 'number') continue
      const item = pending.get(message.id)
      if (!item) continue
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error(JSON.stringify(message.error)))
      else item.resolve(message.result)
    }
  })

  child.once('exit', (code, signal) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(
        new Error(
          `Codex app-server exited with pending RPC: code=${String(code)} signal=${String(signal)} stderr=${stderr}`
        )
      )
    }
    pending.clear()
  })

  function send(message) {
    child.stdin.write(JSON.stringify(message) + '\n')
  }

  function request(method, params = {}) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}; stderr=${stderr}`))
      }, 30_000)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      send({ id, method, params })
    })
  }

  async function initialize() {
    const result = record(
      await request('initialize', {
        clientInfo: {
          name: 'zero3_pilot_session_persistence_ci',
          title: 'Zero3 Pilot Session Persistence CI',
          version: '0.1.0'
        },
        capabilities: { experimentalApi: true }
      })
    )
    if (typeof result.codexHome !== 'string' || !result.codexHome) {
      throw new Error('initialize did not return codexHome')
    }
    send({ method: 'initialized' })
  }

  async function listAppServerThreads() {
    const result = record(
      await request('thread/list', { archived: false, limit: 100, sourceKinds: ['appServer'] })
    )
    return new Set((Array.isArray(result.data) ? result.data : []).map(item => record(item).id))
  }

  async function waitForThreads(expectedIds, label) {
    let actual = new Set()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      actual = await listAppServerThreads()
      if (expectedIds.every(id => actual.has(id))) return actual
      await delay(100)
    }
    throw new Error(`${label}: expected=${expectedIds.join(',')} actual=${JSON.stringify([...actual])}`)
  }

  async function close() {
    if (child.exitCode != null || child.killed) return
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
  }

  return { child, initialize, request, waitForThreads, close }
}

async function main() {
  let first
  let second
  let client = createClient()
  try {
    await client.initialize()
    first = threadIdFrom(
      await client.request('thread/start', { approvalPolicy: 'never', sandbox: 'read-only' })
    )
    second = threadIdFrom(
      await client.request('thread/start', { approvalPolicy: 'never', sandbox: 'read-only' })
    )
    if (first === second) throw new Error('two thread/start calls returned the same thread id')

    await client.waitForThreads([first, second], 'live appServer thread/list omitted created threads')

    await client.close()
    client = createClient()
    await client.initialize()

    await client.waitForThreads(
      [first, second],
      'restart appServer thread/list did not restore both durable threads'
    )

    for (const threadId of [first, second]) {
      const read = record(await client.request('thread/read', { threadId, includeTurns: false }))
      if (record(read.thread).id !== threadId) throw new Error(`thread/read failed after restart for ${threadId}`)
    }

    console.log(
      `Zero3 Codex session persistence smoke passed: two appServer threads survived app-server restart (${first}, ${second}).`
    )
  } finally {
    await client.close().catch(() => {})
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

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

function rpcErrorFrom(error) {
  if (!(error instanceof Error)) return null
  try {
    const parsed = JSON.parse(error.message)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function errorLooksLikeInvalidParams(error) {
  const rpcError = rpcErrorFrom(error)
  if (!rpcError) return false
  const message = typeof rpcError.message === 'string' ? rpcError.message : ''
  return rpcError.code === -32602 || /invalid params|unknown field|missing field|deserialize/i.test(message)
}

function createClient() {
  // Mirror the production Zero3 launcher exactly. Pinned Codex app-server
  // otherwise defaults --session-source to vscode, while sourceKinds
  // ['appServer'] intentionally selects CoreSessionSource::Mcp.
  const child = spawn(binary, ['app-server', '--stdio', '--session-source', 'app-server'], {
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
  const notifications = []
  const notificationWaiters = new Set()

  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-16_000)
  })

  function dispatchNotification(message) {
    notifications.push(message)
    if (notifications.length > 500) notifications.splice(0, notifications.length - 500)

    for (const waiter of [...notificationWaiters]) {
      if (waiter.method !== message.method || !waiter.predicate(record(message.params))) continue
      notificationWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(record(message.params))
    }
  }

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

      if (typeof message.method === 'string' && message.id == null) {
        dispatchNotification(message)
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
    const exitError = new Error(
      `Codex app-server exited: code=${String(code)} signal=${String(signal)} stderr=${stderr}`
    )
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(exitError)
    }
    pending.clear()
    for (const waiter of notificationWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(exitError)
    }
    notificationWaiters.clear()
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

  function waitForNotification(method, predicate, timeoutMs = 30_000) {
    const bufferedIndex = notifications.findIndex(
      message => message.method === method && predicate(record(message.params))
    )
    if (bufferedIndex >= 0) {
      const [message] = notifications.splice(bufferedIndex, 1)
      return Promise.resolve(record(message.params))
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        resolve,
        reject,
        timer: null
      }
      waiter.timer = setTimeout(() => {
        notificationWaiters.delete(waiter)
        reject(new Error(`Timed out waiting for ${method}; stderr=${stderr}`))
      }, timeoutMs)
      waiter.timer.unref?.()
      notificationWaiters.add(waiter)
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
    for (let attempt = 0; attempt < 30; attempt += 1) {
      actual = await listAppServerThreads()
      if (expectedIds.every(id => actual.has(id))) return actual
      await delay(100)
    }
    throw new Error(`${label}: expected=${expectedIds.join(',')} actual=${JSON.stringify([...actual])}`)
  }

  async function materializeThreadWithFirstTurn(threadId, marker) {
    // turn/start only acknowledges that Core accepted/routed the Turn. It does
    // not mean the first user input has reached PersistContext::TurnStart yet.
    // Wait for the matching turn/completed lifecycle notification before any
    // thread-store read/list assertion so the smoke does not race an empty
    // rollout file created by the background writer.
    let result
    try {
      result = record(
        await request('turn/start', {
          threadId,
          input: [
            {
              type: 'text',
              text: `Zero3 durable session persistence smoke ${marker}. No tool use is required.`,
              text_elements: []
            }
          ],
          approvalPolicy: 'never'
        })
      )
    } catch (error) {
      if (errorLooksLikeInvalidParams(error)) {
        throw new Error(`turn/start rejected persistence smoke request shape for ${threadId}: ${error.message}`)
      }
      throw new Error(
        `turn/start failed before a durable first-turn lifecycle could be observed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const turnId = record(result.turn).id
    if (typeof turnId !== 'string' || !turnId) {
      throw new Error(`turn/start returned no turn id while materializing ${threadId}`)
    }

    await waitForNotification(
      'turn/completed',
      params => params.threadId === threadId && record(params.turn).id === turnId
    )

    const read = record(await request('thread/read', { threadId, includeTurns: false }))
    if (record(read.thread).id !== threadId) {
      throw new Error(`thread/read failed after first-turn materialization for ${threadId}`)
    }
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

  return { child, initialize, request, waitForThreads, materializeThreadWithFirstTurn, close }
}

async function main() {
  let first
  let second
  let client = createClient()
  try {
    await client.initialize()
    first = threadIdFrom(
      await client.request('thread/start', { approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
    )
    second = threadIdFrom(
      await client.request('thread/start', { approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
    )
    if (first === second) throw new Error('two thread/start calls returned the same thread id')

    await client.materializeThreadWithFirstTurn(first, 'A')
    await client.materializeThreadWithFirstTurn(second, 'B')
    await client.waitForThreads([first, second], 'live appServer thread/list omitted first-turn durable threads')

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
      `Zero3 Codex session persistence smoke passed: two first-turn appServer threads survived app-server restart (${first}, ${second}).`
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const binary = process.argv[2]
if (!binary) throw new Error('Usage: node smoke-codex-app-server.mjs <codex-binary>')
if (!fs.existsSync(binary)) throw new Error(`Codex binary does not exist: ${binary}`)

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-codex-smoke-'))
const child = spawn(binary, ['app-server', '--stdio'], {
  env: {
    ...process.env,
    CODEX_HOME: codexHome
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')

let stdoutBuffer = ''
let stderr = ''
let finished = false
let initialized = false

function cleanup() {
  if (child.exitCode == null && !child.killed) child.kill()
  try {
    fs.rmSync(codexHome, { recursive: true, force: true })
  } catch {}
}

function fail(message) {
  if (finished) return
  finished = true
  cleanup()
  console.error(message)
  if (stderr.trim()) console.error('Codex stderr tail:\n' + stderr.slice(-8000))
  process.exitCode = 1
}

function succeed() {
  if (finished) return
  finished = true
  console.log('Pinned Codex app-server smoke passed: initialize -> initialized -> thread/list.')
  cleanup()
}

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n')
}

const timeout = setTimeout(() => {
  fail('Timed out waiting for pinned Codex app-server smoke response.')
}, 45_000)

timeout.unref?.()

child.stderr.on('data', chunk => {
  stderr = (stderr + String(chunk)).slice(-16_000)
})

child.stdout.on('data', chunk => {
  stdoutBuffer += String(chunk)
  while (true) {
    const newline = stdoutBuffer.indexOf('\n')
    if (newline < 0) break
    const line = stdoutBuffer.slice(0, newline).trim()
    stdoutBuffer = stdoutBuffer.slice(newline + 1)
    if (!line) continue

    let message
    try {
      message = JSON.parse(line)
    } catch {
      fail('Codex app-server emitted invalid JSONL during smoke: ' + line.slice(0, 500))
      return
    }

    if (message.id === 1) {
      if (message.error) {
        fail('Codex initialize failed: ' + JSON.stringify(message.error))
        return
      }
      const result = message.result ?? {}
      if (typeof result.codexHome !== 'string' || result.codexHome.length === 0) {
        fail('Codex initialize response did not include codexHome.')
        return
      }
      initialized = true
      send({ method: 'initialized' })
      send({ id: 2, method: 'thread/list', params: { limit: 1 } })
      continue
    }

    if (message.id === 2) {
      if (!initialized) {
        fail('Codex thread/list responded before initialize completed.')
        return
      }
      if (message.error) {
        fail('Codex thread/list failed after initialization: ' + JSON.stringify(message.error))
        return
      }
      if (!message.result || typeof message.result !== 'object') {
        fail('Codex thread/list returned an invalid result.')
        return
      }
      clearTimeout(timeout)
      succeed()
      return
    }
  }
})

child.once('error', error => {
  clearTimeout(timeout)
  fail('Failed to spawn pinned Codex app-server: ' + error.message)
})

child.once('exit', (code, signal) => {
  if (finished) return
  clearTimeout(timeout)
  fail(`Codex app-server exited before smoke completed: code=${String(code)} signal=${String(signal)}`)
})

send({
  id: 1,
  method: 'initialize',
  params: {
    clientInfo: {
      name: 'zero3_pilot_ci',
      title: 'Zero3 Pilot CI',
      version: '0.1.0'
    },
    capabilities: {
      experimentalApi: true
    }
  }
})

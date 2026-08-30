import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const CHATGPT_ACCOUNT_TYPE = 'chatgpt'
const DEFAULT_TIMEOUT_MS = 15_000

export function resolveNativeSubscriptionCodexHome({
  env = process.env,
  homeDir = os.homedir()
} = {}) {
  const explicit = String(env.ZERO3_NATIVE_CODEX_HOME ?? '').trim()
  if (explicit) return path.resolve(explicit)

  // Do not inherit process.env.CODEX_HOME here. Zero3 Pilot currently replaces
  // CODEX_HOME with its own isolated runtime home before desktop startup. The
  // native subscription path intentionally targets the user's Codex home unless
  // ZERO3_NATIVE_CODEX_HOME explicitly selects another already-existing home.
  return path.join(homeDir, '.codex')
}

export function sanitizeAccountRead(result) {
  const account = result && typeof result === 'object' ? result.account : null
  if (!account || typeof account !== 'object') {
    return {
      authMode: null,
      planType: null,
      requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth),
      subscriptionReusable: false
    }
  }

  const authMode = typeof account.type === 'string' ? account.type : null
  const planType = typeof account.planType === 'string' ? account.planType : null

  return {
    authMode,
    planType,
    requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth),
    subscriptionReusable: authMode === CHATGPT_ACCOUNT_TYPE
  }
}

export function sanitizeRateLimits(result) {
  const rateLimits = result && typeof result === 'object' ? result.rateLimits : null
  if (!rateLimits || typeof rateLimits !== 'object') return null

  const sanitizeWindow = window => {
    if (!window || typeof window !== 'object') return null
    return {
      usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : null,
      windowDurationMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
      resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null
    }
  }

  return {
    primary: sanitizeWindow(rateLimits.primary),
    secondary: sanitizeWindow(rateLimits.secondary),
    rateLimitReachedType:
      typeof rateLimits.rateLimitReachedType === 'string' ? rateLimits.rateLimitReachedType : null,
    spendControlReached:
      typeof result.spendControlReached === 'boolean' ? result.spendControlReached : null
  }
}

export function classifyNativeAvailability({ account, rateLimits }) {
  if (!account?.subscriptionReusable) {
    return {
      available: false,
      reason: account?.authMode ? 'non_chatgpt_auth' : 'not_authenticated'
    }
  }

  if (rateLimits?.spendControlReached === true || rateLimits?.rateLimitReachedType) {
    return {
      available: false,
      reason: rateLimits?.spendControlReached === true ? 'spend_control_reached' : 'rate_limit_reached'
    }
  }

  return { available: true, reason: 'chatgpt_subscription' }
}

function createJsonlRpcClient(child, timeoutMs) {
  let nextId = 1
  let stdoutBuffer = ''
  let stderr = ''
  const pending = new Map()

  const rejectAll = error => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

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
        rejectAll(new Error('Codex app-server emitted invalid JSONL.'))
        continue
      }

      // The probe is read-only and non-interactive. Fail closed if the server
      // asks the client to approve or provide input.
      if (message.method && message.id != null) {
        child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: { code: -32001, message: 'Zero3 Pilot native auth probe is non-interactive.' }
          }) + '\n'
        )
        continue
      }

      if (message.id == null) continue
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) {
        waiter.reject(new Error(`${waiter.method} failed: ${JSON.stringify(message.error)}`))
      } else {
        waiter.resolve(message.result)
      }
    }
  })

  child.once('error', rejectAll)
  child.once('exit', (code, signal) => {
    if (pending.size === 0) return
    rejectAll(
      new Error(
        `Codex app-server exited before probe completed: code=${String(code)} signal=${String(signal)} stderr=${stderr.slice(-2000)}`
      )
    )
  })

  return {
    notify(method, params) {
      child.stdin.write(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) + '\n')
    },
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timed out waiting for ${method}.`))
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer, method })
        child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n')
      })
    },
    stderrTail() {
      return stderr.slice(-4000)
    }
  }
}

export async function probeNativeCodex({
  command,
  commandArgs = ['app-server', '--stdio'],
  codexHome = resolveNativeSubscriptionCodexHome(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!command || typeof command !== 'string') {
    throw new Error('probeNativeCodex requires a pinned Codex command path.')
  }

  const child = spawn(command, commandArgs, {
    env: { ...env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  })
  const rpc = createJsonlRpcClient(child, timeoutMs)

  try {
    const initialized = await rpc.request('initialize', {
      clientInfo: {
        name: 'zero3_pilot_native_probe',
        title: 'Zero3 Pilot Native Codex Probe',
        version: '0.1.0'
      },
      capabilities: { experimentalApi: true }
    })
    rpc.notify('initialized')

    const serverCodexHome =
      typeof initialized?.codexHome === 'string' && initialized.codexHome.length > 0
        ? initialized.codexHome
        : null
    if (!serverCodexHome) throw new Error('Pinned Codex initialize response omitted codexHome.')

    const accountRead = await rpc.request('account/read', { refreshToken: false })
    const account = sanitizeAccountRead(accountRead)

    let rateLimits = null
    let rateLimitProbe = 'not_applicable'
    if (account.subscriptionReusable) {
      try {
        rateLimits = sanitizeRateLimits(await rpc.request('account/rateLimits/read'))
        rateLimitProbe = 'ok'
      } catch {
        // A temporarily unavailable rate-limit endpoint must not expose auth
        // material or crash the auth-state probe. Availability remains unknown
        // until the runtime performs an actual turn.
        rateLimitProbe = 'unavailable'
      }
    }

    let providerCapabilitiesProbe = 'unavailable'
    try {
      await rpc.request('modelProvider/capabilities/read')
      providerCapabilitiesProbe = 'ok'
    } catch {
      providerCapabilitiesProbe = 'unavailable'
    }

    return {
      codexHome: serverCodexHome,
      requestedCodexHome: codexHome,
      account,
      rateLimits,
      rateLimitProbe,
      providerCapabilitiesProbe,
      availability:
        rateLimitProbe === 'unavailable'
          ? { available: false, reason: 'quota_probe_unavailable' }
          : classifyNativeAvailability({ account, rateLimits })
    }
  } finally {
    if (child.exitCode == null && !child.killed) child.kill()
  }
}

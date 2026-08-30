import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  classifyNativeAvailability,
  probeNativeCodex,
  resolveNativeSubscriptionCodexHome,
  sanitizeAccountRead,
  sanitizeRateLimits
} from './codex-native-probe.mjs'

test('native home defaults to the host Codex home and ignores Zero3 runtime CODEX_HOME', () => {
  const actual = resolveNativeSubscriptionCodexHome({
    env: { CODEX_HOME: '/zero3/isolated' },
    homeDir: '/users/alice'
  })
  assert.equal(actual, path.join('/users/alice', '.codex'))
})

test('ZERO3_NATIVE_CODEX_HOME explicitly selects an existing host Codex home', () => {
  const actual = resolveNativeSubscriptionCodexHome({
    env: { ZERO3_NATIVE_CODEX_HOME: './fixtures/native-home', CODEX_HOME: '/zero3/isolated' },
    homeDir: '/users/alice'
  })
  assert.equal(actual, path.resolve('./fixtures/native-home'))
})

test('account sanitization proves ChatGPT subscription without retaining account secrets', () => {
  const raw = {
    account: {
      type: 'chatgpt',
      email: 'user@example.com',
      planType: 'plus',
      accessToken: 'must-not-leak',
      refreshToken: 'must-not-leak'
    },
    requiresOpenaiAuth: true
  }
  assert.deepEqual(sanitizeAccountRead(raw), {
    authMode: 'chatgpt',
    planType: 'plus',
    requiresOpenaiAuth: true,
    subscriptionReusable: true
  })
})

test('API key auth is not treated as reusable ChatGPT subscription auth', () => {
  const account = sanitizeAccountRead({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })
  assert.equal(account.subscriptionReusable, false)
  assert.deepEqual(classifyNativeAvailability({ account, rateLimits: null }), {
    available: false,
    reason: 'non_chatgpt_auth'
  })
})

test('quota probe failure is represented as unavailable instead of optimistic availability', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-native-quota-test-'))
  const fake = path.join(temp, 'fake-app-server.mjs')
  const fakeHome = path.join(temp, 'native-home')
  fs.mkdirSync(fakeHome)
  fs.writeFileSync(
    fake,
    `import readline from 'node:readline'\n` +
      `const rl = readline.createInterface({ input: process.stdin })\n` +
      `for await (const line of rl) {\n` +
      `  const m = JSON.parse(line)\n` +
      `  if (m.id == null) continue\n` +
      `  if (m.method === 'account/rateLimits/read') { process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32000, message: 'quota unavailable' } }) + '\\n'); continue }\n` +
      `  let result = {}\n` +
      `  if (m.method === 'initialize') result = { codexHome: process.env.CODEX_HOME }\n` +
      `  else if (m.method === 'account/read') result = { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true }\n` +
      `  else if (m.method === 'modelProvider/capabilities/read') result = { provider: 'openai' }\n` +
      `  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n')\n` +
      `}\n`
  )

  try {
    const result = await probeNativeCodex({ command: process.execPath, commandArgs: [fake], codexHome: fakeHome, timeoutMs: 2_000 })
    assert.equal(result.rateLimitProbe, 'unavailable')
    assert.deepEqual(result.availability, { available: false, reason: 'quota_probe_unavailable' })
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('typed rate-limit state blocks native availability fail-closed', () => {
  const account = sanitizeAccountRead({ account: { type: 'chatgpt', planType: 'pro' } })
  const rateLimits = sanitizeRateLimits({
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 15, resetsAt: 1234 },
      secondary: null,
      rateLimitReachedType: 'primary'
    },
    spendControlReached: false
  })
  assert.deepEqual(classifyNativeAvailability({ account, rateLimits }), {
    available: false,
    reason: 'rate_limit_reached'
  })
})

test('probe uses app-server account/rate-limit/provider RPCs and never reads auth files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-native-probe-test-'))
  const fake = path.join(temp, 'fake-app-server.mjs')
  const fakeHome = path.join(temp, 'native-home')
  fs.mkdirSync(fakeHome)
  fs.writeFileSync(
    path.join(fakeHome, 'auth.json'),
    JSON.stringify({ access_token: 'TOP-SECRET-ACCESS', refresh_token: 'TOP-SECRET-REFRESH' })
  )

  fs.writeFileSync(
    fake,
    `import readline from 'node:readline'\n` +
      `const rl = readline.createInterface({ input: process.stdin })\n` +
      `for await (const line of rl) {\n` +
      `  const m = JSON.parse(line)\n` +
      `  if (m.id == null) continue\n` +
      `  let result = {}\n` +
      `  if (m.method === 'initialize') result = { codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' }\n` +
      `  else if (m.method === 'account/read') result = { account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus', accessToken: 'SERVER-SECRET' }, requiresOpenaiAuth: true }\n` +
      `  else if (m.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1730947200 }, secondary: null, rateLimitReachedType: null }, spendControlReached: false }\n` +
      `  else if (m.method === 'modelProvider/capabilities/read') result = { provider: 'openai' }\n` +
      `  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n')\n` +
      `}\n`
  )

  try {
    const result = await probeNativeCodex({
      command: process.execPath,
      commandArgs: [fake],
      codexHome: fakeHome,
      timeoutMs: 2_000
    })

    assert.equal(result.codexHome, fakeHome)
    assert.equal(result.account.subscriptionReusable, true)
    assert.equal(result.account.planType, 'plus')
    assert.equal(result.rateLimitProbe, 'ok')
    assert.equal(result.providerCapabilitiesProbe, 'ok')
    assert.deepEqual(result.availability, { available: true, reason: 'chatgpt_subscription' })

    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('TOP-SECRET'), false)
    assert.equal(serialized.includes('SERVER-SECRET'), false)
    assert.equal(serialized.includes('user@example.com'), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

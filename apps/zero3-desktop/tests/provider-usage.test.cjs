const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const root = path.resolve(__dirname, '..')
const desktopRequire = createRequire(path.resolve(root, '../../upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')
function load(relative, overrides = {}, globals = {}) {
  const file = path.join(root, relative), exports = {}
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const localRequire = name => overrides[name] ?? (name.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')), overrides, globals) : require(name))
  vm.runInNewContext(output, { exports, require: localRequire, Error, Buffer, URL, Date, process, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, ...globals })
  return exports
}
const usage = load('provider-usage-runtime/provider-usage.ts')
const codexResult = { rateLimitsByLimitId: { codex: {
  primary: { windowDurationMins: 10080, usedPercent: 20, resetsAt: 1800000000 },
  secondary: { windowDurationMins: 300, usedPercent: 100, resetsAt: 1799999999 }
}, other: { primary: { windowDurationMins: 300, usedPercent: 1 } } } }
test('Codex maps actual window durations, uses its own bucket and never treats missing as 100%', () => {
  const value = usage.codexUsage(codexResult)
  assert.equal(value.fiveHour.remainingPercent, 0)
  assert.equal(value.weekly.remainingPercent, 80)
  assert.equal(value.weekly.resetsAt, new Date(1800000000000).toISOString())
  assert.equal(usage.codexUsage({ rateLimits: { primary: { windowDurationMins: 15, usedPercent: 10 } } }).fiveHour.remainingPercent, null)
  assert.equal(usage.codexUsage({ rateLimitsByLimitId: { other: codexResult.rateLimitsByLimitId.codex } }).status, 'unavailable')
})
test('Claude parses zero, partial, malformed and exhausted quotas', () => {
  const value = usage.claudeUsage({ five_hour: { utilization: 0, resets_at: '2026-09-10T08:50:00+08:00' }, seven_day: null })
  assert.equal(value.fiveHour.remainingPercent, 100)
  assert.equal(value.weekly.remainingPercent, null)
  assert.equal(usage.claudeUsage({ five_hour: { utilization: '0' } }).fiveHour.remainingPercent, null)
  assert.equal(usage.claudeUsage({ five_hour: { utilization: 120 } }).fiveHour.remainingPercent, 0)
})
test('balance endpoints stay on the exact configured provider; zero and negative balances remain real values', () => {
  for (const url of ['https://api.deepseek.com.evil/v1', 'https://proxy.example/v1', 'https://openrouter.ai/custom', 'https://user:secret@api.deepseek.com/v1']) assert.equal(usage.balanceEndpoint(url), null)
  assert.equal(usage.balanceEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/user/balance')
  assert.equal(usage.apiBalance('https://api.deepseek.com', { balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }).balances[0].amount, 0)
  assert.equal(usage.apiBalance('https://openrouter.ai/api/v1', { data: { total_credits: 5, total_usage: 6 } }).balances[0].amount, -1)
  assert.equal(usage.apiBalance('https://openrouter.ai/api/v1', { data: { total_credits: null } }).status, 'unavailable')
})
test('cache deduplicates concurrent calls, throttles manual refresh, expires, and isolates API profile versions', async () => {
  let now = 0, calls = 0, updatedAt = 'v1'
  const service = usage.createProviderUsageService({ now: () => now, codex: async () => { calls++; return codexResult },
    fetchJson: async () => { calls++; return { balance_infos: [{ currency: 'CNY', total_balance: '8' }] } },
    profile: async id => ({ id, updatedAt, baseUrl: 'https://api.deepseek.com', apiKey: 'test-key' }) })
  await Promise.all([service({ provider: 'codex' }), service({ provider: 'codex' })])
  await service({ provider: 'codex', force: true }); assert.equal(calls, 1)
  now = 31000
  await service({ provider: 'codex', force: true }); assert.equal(calls, 2)
  now += 301000
  await service({ provider: 'codex' }); assert.equal(calls, 3)
  await service({ provider: 'zero3', profileId: 'a' })
  await service({ provider: 'zero3', profileId: 'b' })
  updatedAt = 'v2'
  await service({ provider: 'zero3', profileId: 'a' }); assert.equal(calls, 6)
  assert.equal((await service({ provider: 'antigravity' })).status, 'unsupported')
})
test('official Codex query reuses its CLI home, sends only account RPCs and closes its process', async () => {
  const calls = [], writes = []
  let killed = false
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => {}
  child.kill = () => { killed = true }
  child.stdin.write = text => {
    const request = JSON.parse(text); writes.push(request)
    if (request.id) queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: request.id, result: request.id === 1 ? {} : codexResult }) + '\n'))
  }
  const api = load('provider-usage-runtime/provider-usage.ts', {
    'node:child_process': { spawn: (...args) => { calls.push(args); return child } },
    '../executor-runtime/external/windows-command': { resolveWindowsCommand: command => ({ command, args: ['shim-prefix'] }) }
  })
  const value = await api.readCodexUsage({ CODEX_HOME: '/isolated-kernel', ZERO3_CODEX_CLI_BIN: 'official-codex' })
  assert.equal(calls[0][0], 'official-codex')
  assert.deepEqual(Array.from(calls[0][1]), ['shim-prefix', 'app-server'])
  assert.equal(calls[0][2].env.CODEX_HOME, undefined)
  assert.equal(value.rateLimitsByLimitId.codex.primary.usedPercent, 20)
  assert.deepEqual(writes.map(value => value.method), ['initialize', 'initialized', 'account/rateLimits/read'])
  assert.equal(killed, true)
})
test('Claude credentials stay in the official-host request, API identities are not reported as subscription accounts', async () => {
  const api = load('provider-usage-runtime/provider-usage.ts', { 'node:fs/promises': { readFile: async file => file.endsWith('settings.json') ? '{}' : JSON.stringify({ claudeAiOauth: { accessToken: 'private-test-token' } }) } })
  let calls = 0
  const fetch = async (url, headers) => { calls++; assert.equal(url, 'https://api.anthropic.com/api/oauth/usage'); assert.equal(headers.Authorization, 'Bearer private-test-token'); return {} }
  await api.readClaudeUsage(fetch, {})
  await assert.rejects(api.readClaudeUsage(fetch, { ANTHROPIC_BASE_URL: 'https://proxy.example' }), /API 或外部服务/)
  assert.equal(calls, 1)
})
test('usage fetch suppresses provider response bodies and preserves non-auth rate limit errors', async () => {
  for (const [status, expected] of [[401, /授权已失效/], [403, /无权查询/], [429, /暂时限流/], [500, /暂时失败/]]) {
    const api = load('provider-usage-runtime/usage-fetch.ts', { electron: { session: { fromPartition: () => ({ setProxy: async () => {}, fetch: async () => ({ ok: false, status, body: { cancel: async () => {} } }) }) } } })
    await assert.rejects(api.fetchUsageJson('https://api.anthropic.com/api/oauth/usage', { Authorization: 'private' }), expected)
  }
})

test('header shows quota/balance and never leaks a previous provider while switching', async () => {
  const { JSDOM } = desktopRequire('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const before = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const React = desktopRequire('react'), { render, cleanup, act } = desktopRequire('@testing-library/react')
  let resolveClaude
  dom.window.zero3SessionProviders = { usage: async request => request.provider === 'codex' ? usage.codexUsage(codexResult) : request.provider === 'zero3' ? usage.apiBalance('https://api.deepseek.com', { balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }) : new Promise(resolve => { resolveClaude = resolve }) }
  const { ProviderUsageBadge } = load('ui-v2/conversations/ProviderUsageBadge.tsx', { react: React, 'react/jsx-runtime': desktopRequire('react/jsx-runtime'), '@/components/ui/codicon': { Codicon: () => null } }, { window: dom.window, document: dom.window.document })
  try {
    let view
    await act(async () => { view = render(React.createElement(ProviderUsageBadge, { provider: 'codex', profileId: null })) })
    assert.match(view.container.textContent, /本周剩余：80%.*5 小时剩余：0%/)
    await act(async () => view.rerender(React.createElement(ProviderUsageBadge, { provider: 'claude', profileId: null })))
    assert.doesNotMatch(view.container.textContent, /80%/)
    await act(async () => view.rerender(React.createElement(ProviderUsageBadge, { provider: 'zero3', profileId: 'a' })))
    await act(async () => resolveClaude(usage.claudeUsage({ five_hour: { utilization: 5 } })))
    assert.match(view.container.textContent, /API 余额：CNY 0.00/)
    assert.doesNotMatch(view.container.textContent, /95%|本周剩余/)
  } finally { cleanup(); dom.window.close(); Object.assign(globalThis, before) }
})

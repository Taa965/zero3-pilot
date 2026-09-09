import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeCliEnvironment, claudeProxyUrl } from './claude-environment.ts'

test('Windows CLI inherits the browser HTTP proxy without mutating its parent', async () => {
  const env = { KEEP: 'value' }
  const urls: string[] = []
  const result = await claudeCliEnvironment({ env, platform: 'win32', settingsEnv: {}, resolveProxy: async url => { urls.push(url); return 'PROXY 127.0.0.1:7897; DIRECT' } })
  assert.equal(result.HTTPS_PROXY, 'http://127.0.0.1:7897')
  assert.equal(result.HTTP_PROXY, result.HTTPS_PROXY)
  assert.equal(result.NO_PROXY, 'localhost,127.0.0.1,::1')
  assert.equal(result.KEEP, 'value')
  assert.deepEqual(env, { KEEP: 'value' })
  assert.deepEqual(urls, ['https://api.anthropic.com'])
})

test('explicit proxy settings, including lowercase and empty values, win', async () => {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'ALL_PROXY']) {
    for (const value of ['http://custom:1234', '']) {
      const env = { [key]: value }
      const resolveProxy = async () => { throw new Error('must not consult system proxy') }
      assert.deepEqual(await claudeCliEnvironment({ env, platform: 'win32', settingsEnv: {}, resolveProxy }), env)
      assert.deepEqual(await claudeCliEnvironment({ env: {}, platform: 'win32', settingsEnv: env, resolveProxy }), {})
    }
  }
})

test('DIRECT, non-Windows and explicit cloud providers keep their own routing', async () => {
  assert.deepEqual(await claudeCliEnvironment({ env: {}, platform: 'win32', settingsEnv: {}, resolveProxy: async () => 'DIRECT; PROXY fallback:8080' }), {})
  assert.deepEqual(await claudeCliEnvironment({ env: {}, platform: 'linux', resolveProxy: async () => { throw new Error('unexpected') } }), {})
  const env = { CLAUDE_CODE_USE_BEDROCK: '1' }
  assert.deepEqual(await claudeCliEnvironment({ env, platform: 'win32', settingsEnv: {}, resolveProxy: async () => { throw new Error('unexpected') } }), env)
})

test('proxy parsing supports TLS/IPv6 but never silently skips unsupported routes', () => {
  assert.equal(claudeProxyUrl('HTTPS proxy.example:8443'), 'https://proxy.example:8443')
  assert.equal(claudeProxyUrl('PROXY [::1]:7897'), 'http://[::1]:7897')
  assert.throws(() => claudeProxyUrl('SOCKS5 localhost:1080; DIRECT'), /HTTP\/HTTPS/)
  assert.throws(() => claudeProxyUrl('PROXY user:password@proxy.example:8080'), /格式/)
  assert.throws(() => claudeProxyUrl('PROXY proxy.example/path'), /格式/)
})

test('PAC lookup follows custom API base and preserves explicit NO_PROXY', async () => {
  let requested = ''
  const result = await claudeCliEnvironment({ env: { NO_PROXY: '*.internal' }, platform: 'win32', settingsEnv: { ANTHROPIC_BASE_URL: 'https://gateway.example' }, resolveProxy: async url => { requested = url; return 'PROXY proxy.example:8080' } })
  assert.equal(requested, 'https://gateway.example')
  assert.equal(result.NO_PROXY, '*.internal')
})

test('system proxy resolution failures are surfaced instead of silently going direct', async () => {
  await assert.rejects(claudeCliEnvironment({ env: {}, platform: 'win32', settingsEnv: {}, resolveProxy: async () => { throw new Error('proxy lookup failed') } }), /proxy lookup failed/)
})

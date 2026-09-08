import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readBearerToken, rotateBearerToken } from './project-context-http-policy.mjs'
import {
  authorizeProjectContextHttpRequest,
  configuredMcpHosts,
  mcpOriginAllowed,
  webWriteVerified
} from './project-context-http-security.mjs'

async function withStateDir(run) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-mcp-http-security-'))
  try {
    await run(stateDir)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
}

function request(overrides = {}) {
  return {
    url: '/mcp',
    host: '127.0.0.1:8789',
    origin: undefined,
    authorization: undefined,
    ...overrides
  }
}

const gateOptions = stateDir => ({ port: 8789, stateDir, allowedHosts: '', allowedOrigins: '' })

test('HTTP front door fails closed by path host origin and bearer token', async () => {
  await withStateDir(async stateDir => {
    const token = await readBearerToken({ stateDir })
    const bearer = `Bearer ${token}`

    assert.equal(await authorizeProjectContextHttpRequest(request({ url: '/health' }), gateOptions(stateDir)), 404)
    assert.equal(await authorizeProjectContextHttpRequest(request({ host: 'evil.example:8789', authorization: bearer }), gateOptions(stateDir)), 403)
    assert.equal(await authorizeProjectContextHttpRequest(request({ origin: 'http://chatgpt.com', authorization: bearer }), gateOptions(stateDir)), 403)
    assert.equal(await authorizeProjectContextHttpRequest(request({ origin: 'https://evil.example', authorization: bearer }), gateOptions(stateDir)), 403)
    assert.equal(await authorizeProjectContextHttpRequest(request(), gateOptions(stateDir)), 401)
    assert.equal(await authorizeProjectContextHttpRequest(request({ authorization: 'Bearer ' + '0'.repeat(64) }), gateOptions(stateDir)), 401)
    assert.equal(await authorizeProjectContextHttpRequest(request({ authorization: bearer }), gateOptions(stateDir)), 200)
    assert.equal(await authorizeProjectContextHttpRequest(request({ origin: 'https://chatgpt.com', authorization: bearer }), gateOptions(stateDir)), 200)
    assert.equal(await authorizeProjectContextHttpRequest(request({ origin: 'https://foo.chatgpt.com', authorization: bearer }), gateOptions(stateDir)), 200)
    assert.equal(await authorizeProjectContextHttpRequest(request({ origin: 'https://platform.openai.com', authorization: bearer }), gateOptions(stateDir)), 200)
  })
})

test('explicit tunnel host/origin require explicit allowlist entries', async () => {
  await withStateDir(async stateDir => {
    const token = await readBearerToken({ stateDir })
    const options = {
      port: 8789,
      stateDir,
      allowedHosts: 'mcp.example.com,SECOND.EXAMPLE.COM',
      allowedOrigins: 'https://connector.example.com'
    }
    assert.equal(configuredMcpHosts(8789, options.allowedHosts).has('second.example.com'), true)
    assert.equal(mcpOriginAllowed('https://connector.example.com', options.allowedOrigins), true)
    assert.equal(await authorizeProjectContextHttpRequest(request({
      host: 'mcp.example.com',
      origin: 'https://connector.example.com',
      authorization: `Bearer ${token}`
    }), options), 200)
    assert.equal(await authorizeProjectContextHttpRequest(request({
      host: 'unlisted.example.com',
      origin: 'https://connector.example.com',
      authorization: `Bearer ${token}`
    }), options), 403)
  })
})

test('token rotation invalidates the old bearer immediately', async () => {
  await withStateDir(async stateDir => {
    const oldToken = await readBearerToken({ stateDir })
    const newToken = await rotateBearerToken({ stateDir })
    assert.notEqual(newToken, oldToken)
    assert.equal(await authorizeProjectContextHttpRequest(request({ authorization: `Bearer ${oldToken}` }), gateOptions(stateDir)), 401)
    assert.equal(await authorizeProjectContextHttpRequest(request({ authorization: `Bearer ${newToken}` }), gateOptions(stateDir)), 200)
  })
})

test('web MCP write mode remains locked unless the explicit verification flag is one', async () => {
  assert.equal(webWriteVerified({}), false)
  assert.equal(webWriteVerified({ ZERO3_MCP_HTTP_WRITE_VERIFIED: '0' }), false)
  assert.equal(webWriteVerified({ ZERO3_MCP_HTTP_WRITE_VERIFIED: 'true' }), false)
  assert.equal(webWriteVerified({ ZERO3_MCP_HTTP_WRITE_VERIFIED: '1' }), true)

  const source = await fs.readFile(new URL('./project-context-http.mjs', import.meta.url), 'utf8')
  assert.match(source, /const WRITE_VERIFIED = webWriteVerified\(process\.env\)/)
  assert.match(source, /if \(WRITE_VERIFIED\) \{[\s\S]*?registerTool\('project_put_context'/)
})

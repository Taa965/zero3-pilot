import { timingSafeEqual } from 'node:crypto'

import { readBearerToken } from './project-context-http-policy.mjs'

export function webWriteVerified(env = process.env) {
  return env.ZERO3_MCP_HTTP_WRITE_VERIFIED === '1'
}

export function configuredMcpHosts(port, rawAllowedHosts = '') {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port must be a valid TCP port')
  const values = String(rawAllowedHosts)
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...values])
}

export function mcpOriginAllowed(origin, rawAllowedOrigins = '') {
  const value = typeof origin === 'string' ? origin.trim() : ''
  if (!value) return true
  const explicit = new Set(
    String(rawAllowedOrigins)
      .split(',')
      .map(candidate => candidate.trim())
      .filter(Boolean)
  )
  if (explicit.has(value)) return true
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    const hostname = parsed.hostname.toLowerCase()
    return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'openai.com' || hostname.endsWith('.openai.com')
  } catch {
    return false
  }
}

export async function mcpBearerAllowed(authorization, stateDir) {
  const header = typeof authorization === 'string' ? authorization.trim() : ''
  if (!header.startsWith('Bearer ')) return false
  const token = header.slice(7).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) return false
  const supplied = Buffer.from(token, 'utf8')
  const expected = Buffer.from(await readBearerToken({ stateDir }), 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export async function authorizeProjectContextHttpRequest(
  request,
  {
    port,
    stateDir,
    allowedHosts = '',
    allowedOrigins = ''
  }
) {
  const pathname = new URL(request?.url ?? '/', 'http://localhost').pathname
  if (pathname !== '/mcp') return 404

  const host = typeof request?.host === 'string' ? request.host.trim().toLowerCase() : ''
  if (!configuredMcpHosts(port, allowedHosts).has(host)) return 403
  if (!mcpOriginAllowed(request?.origin, allowedOrigins)) return 403
  if (!(await mcpBearerAllowed(request?.authorization, stateDir))) return 401
  return 200
}

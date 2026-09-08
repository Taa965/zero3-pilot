import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import * as z from 'zod/v4'

import { createProjectContextCore } from './project-context-core.mjs'
import { appendHttpAudit, filterWebEgressPayload, isProjectWebAllowed, mergeWebIngressPayload, readBearerToken } from './project-context-http-policy.mjs'

const SERVER_NAME = 'zero3-project-context-http'
const SERVER_VERSION = '0.1.0'
const ID = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const HOST = process.env.ZERO3_MCP_HTTP_HOST?.trim() || '127.0.0.1'
const PORT = (() => {
  const value = Number.parseInt(process.env.ZERO3_MCP_HTTP_PORT?.trim() || '8789', 10)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error('ZERO3_MCP_HTTP_PORT must be a valid TCP port')
  return value
})()
const WRITE_VERIFIED = process.env.ZERO3_MCP_HTTP_WRITE_VERIFIED === '1'
const STATE_DIR = process.env.ZERO3_MCP_HTTP_STATE_DIR
const core = createProjectContextCore({ rootDir: process.env.ZERO3_PROJECT_CONTEXT_DIR })

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}
async function allowedProject(projectId, tool) {
  if (!(await isProjectWebAllowed(projectId, { stateDir: STATE_DIR }))) {
    await appendHttpAudit({ tool, projectId, result: 'denied' }, { stateDir: STATE_DIR })
    throw new Error('project is not available to web MCP')
  }
}
function serverFactory() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  server.registerTool('project_get_context', {
    title: 'Get Zero3 Project Context',
    description: 'Read the web-approved subset of canonical Zero3 project memory.',
    inputSchema: z.object({ projectId: ID }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ projectId }) => {
    await allowedProject(projectId, 'project_get_context')
    try {
      const current = await core.getProject(projectId)
      const outbound = { projectId, version: current.version, updatedAt: current.updatedAt ?? null, payload: filterWebEgressPayload(current.payload) }
      await appendHttpAudit({ tool: 'project_get_context', projectId, result: 'ok' }, { stateDir: STATE_DIR })
      return toolResult(outbound)
    } catch (error) {
      await appendHttpAudit({ tool: 'project_get_context', projectId, result: 'error' }, { stateDir: STATE_DIR })
      throw error
    }
  })
  if (WRITE_VERIFIED) {
    server.registerTool('project_put_context', {
      title: 'Update Zero3 Project Context',
      description: 'Update only the web-approved project-memory fields with optimistic version control.',
      inputSchema: z.object({
        projectId: ID,
        expectedVersion: z.number().int().nonnegative(),
        payload: z.object({ decisions: z.array(z.unknown()).optional(), pitfalls: z.array(z.unknown()).optional(), glossary: z.record(z.string(), z.unknown()).optional() })
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }, async ({ projectId, expectedVersion, payload }) => {
      await allowedProject(projectId, 'project_put_context')
      try {
        const current = await core.getProject(projectId)
        if (current.version !== expectedVersion) throw new Error(`project context version conflict: expected ${expectedVersion}, current ${current.version}`)
        const next = await core.putProject(projectId, expectedVersion, mergeWebIngressPayload(current.payload, payload))
        await appendHttpAudit({ tool: 'project_put_context', projectId, result: 'ok' }, { stateDir: STATE_DIR })
        return toolResult({ projectId, version: next.version, updatedAt: next.updatedAt, payload: filterWebEgressPayload(next.payload) })
      } catch (error) {
        await appendHttpAudit({ tool: 'project_put_context', projectId, result: 'error' }, { stateDir: STATE_DIR })
        throw error
      }
    })
  }
  return server
}
function configuredHosts() {
  const values = (process.env.ZERO3_MCP_HTTP_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  return new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...values])
}
const allowedHosts = configuredHosts()
const extraOrigins = new Set((process.env.ZERO3_MCP_HTTP_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean))
function hostAllowed(request) { return allowedHosts.has(request.headers.host?.trim().toLowerCase() ?? '') }
function originAllowed(request) {
  const origin = request.headers.origin?.trim()
  if (!origin) return true
  if (extraOrigins.has(origin)) return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase()
    return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'openai.com' || hostname.endsWith('.openai.com')
  } catch { return false }
}
async function bearerAllowed(request) {
  const header = request.headers.authorization?.trim() ?? ''
  if (!header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7).trim(), 'utf8')
  const expected = Buffer.from(await readBearerToken({ stateDir: STATE_DIR }), 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
function reject(response, status) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify({ error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'not_found' }))
}
const mcpHandler = createMcpHandler(serverFactory)
const nodeHandler = toNodeHandler(mcpHandler, { onerror(error) { console.error(`[${SERVER_NAME}] adapter error:`, error) } })
const httpServer = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host || 'localhost'}`).pathname
    if (pathname !== '/mcp') return reject(response, 404)
    if (!hostAllowed(request) || !originAllowed(request)) return reject(response, 403)
    if (!(await bearerAllowed(request))) return reject(response, 401)
    response.setHeader('cache-control', 'no-store')
    void nodeHandler(request, response)
  } catch (error) {
    console.error(`[${SERVER_NAME}] request error:`, error)
    if (!response.headersSent) reject(response, 401)
    else response.destroy()
  }
})
await readBearerToken({ stateDir: STATE_DIR })
httpServer.listen(PORT, HOST, () => console.error(`[${SERVER_NAME}] listening on http://${HOST}:${PORT}/mcp (${WRITE_VERIFIED ? 'read/write verified' : 'read-only'})`))
async function shutdown() { httpServer.close(); await mcpHandler.close() }
process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())

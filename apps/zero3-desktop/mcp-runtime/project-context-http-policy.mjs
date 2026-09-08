import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { assertLogicalId } from './project-context-core.mjs'

const POLICY_SCHEMA_VERSION = 1
const TOKEN_BYTES = 32

function stateRoot(value = process.env.ZERO3_MCP_HTTP_STATE_DIR) {
  const configured = typeof value === 'string' ? value.trim() : ''
  if (!configured || !path.isAbsolute(configured)) throw new Error('ZERO3_MCP_HTTP_STATE_DIR must be an absolute directory')
  return path.resolve(configured)
}
function tokenFile(root) { return path.join(root, 'mcp-http-token') }
function policyFile(root) { return path.join(root, 'mcp-http-access.json') }
function auditFile(root) { return path.join(root, 'mcp-http-audit.jsonl') }

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, file)
}

export async function readBearerToken(options = {}) {
  const root = stateRoot(options.stateDir)
  try {
    const token = (await fs.readFile(tokenFile(root), 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('stored MCP HTTP bearer token is invalid')
    return token
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return rotateBearerToken({ stateDir: root })
  }
}
export async function rotateBearerToken(options = {}) {
  const root = stateRoot(options.stateDir)
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  await atomicWrite(tokenFile(root), `${token}\n`)
  return token
}
export async function readAccessPolicy(options = {}) {
  const root = stateRoot(options.stateDir)
  try {
    const parsed = JSON.parse(await fs.readFile(policyFile(root), 'utf8'))
    if (parsed?.schemaVersion !== POLICY_SCHEMA_VERSION || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) throw new Error('invalid MCP HTTP access policy')
    const projects = {}
    for (const [projectId, enabled] of Object.entries(parsed.projects)) {
      assertLogicalId(projectId, 'projectId')
      if (enabled !== true) throw new Error('invalid MCP HTTP project access value')
      projects[projectId] = true
    }
    return { schemaVersion: POLICY_SCHEMA_VERSION, projects }
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: POLICY_SCHEMA_VERSION, projects: {} }
    throw error
  }
}
export async function setProjectWebAccess(projectId, enabled, options = {}) {
  const id = assertLogicalId(projectId, 'projectId')
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const root = stateRoot(options.stateDir)
  const policy = await readAccessPolicy({ stateDir: root })
  if (enabled) policy.projects[id] = true
  else delete policy.projects[id]
  await atomicWrite(policyFile(root), `${JSON.stringify(policy, null, 2)}\n`)
  return { projectId: id, enabled }
}
export async function isProjectWebAllowed(projectId, options = {}) {
  const id = assertLogicalId(projectId, 'projectId')
  const policy = await readAccessPolicy(options)
  return policy.projects[id] === true
}
export async function appendHttpAudit(entry, options = {}) {
  const root = stateRoot(options.stateDir)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const record = {
    at: new Date().toISOString(),
    tool: typeof entry?.tool === 'string' ? entry.tool.slice(0, 128) : 'unknown',
    projectId: typeof entry?.projectId === 'string' ? entry.projectId.slice(0, 256) : null,
    result: typeof entry?.result === 'string' ? entry.result.slice(0, 128) : 'unknown'
  }
  await fs.appendFile(auditFile(root), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}
export function filterWebEgressPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const output = {}
  if (Array.isArray(payload.decisions)) output.decisions = payload.decisions
  if (Array.isArray(payload.pitfalls)) output.pitfalls = payload.pitfalls
  if (payload.glossary && typeof payload.glossary === 'object' && !Array.isArray(payload.glossary)) output.glossary = payload.glossary
  return output
}
export function mergeWebIngressPayload(currentPayload, webPayload) {
  const current = currentPayload && typeof currentPayload === 'object' && !Array.isArray(currentPayload) ? { ...currentPayload } : {}
  if (!webPayload || typeof webPayload !== 'object' || Array.isArray(webPayload)) throw new Error('web project payload must be an object')
  if ('decisions' in webPayload) { if (!Array.isArray(webPayload.decisions)) throw new Error('decisions must be an array'); current.decisions = webPayload.decisions }
  if ('pitfalls' in webPayload) { if (!Array.isArray(webPayload.pitfalls)) throw new Error('pitfalls must be an array'); current.pitfalls = webPayload.pitfalls }
  if ('glossary' in webPayload) {
    if (!webPayload.glossary || typeof webPayload.glossary !== 'object' || Array.isArray(webPayload.glossary)) throw new Error('glossary must be an object')
    current.glossary = webPayload.glossary
  }
  return current
}

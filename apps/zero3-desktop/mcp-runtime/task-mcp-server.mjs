import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

const SERVER = 'zero3-task-gateway'
const VERSION = '0.1.0'
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_TEXT_ARTIFACT_BYTES = 512 * 1024
const ID = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
function taskId() { return requiredEnv('ZERO3_MCP_TASK_ID') }
function projectId() { return requiredEnv('ZERO3_MCP_PROJECT_ID') }
function stateRoot() { const value = requiredEnv('ZERO3_MCP_STATE_DIR'); if (!path.isAbsolute(value)) throw new Error('ZERO3_MCP_STATE_DIR must be absolute'); return path.resolve(value) }
function artifactsRoot() { const value = requiredEnv('ZERO3_MCP_ARTIFACT_DIR'); if (!path.isAbsolute(value)) throw new Error('ZERO3_MCP_ARTIFACT_DIR must be absolute'); return path.resolve(value) }
function reviewsRoot() { const value = requiredEnv('ZERO3_MCP_REVIEW_DIR'); if (!path.isAbsolute(value)) throw new Error('ZERO3_MCP_REVIEW_DIR must be absolute'); return path.resolve(value) }
function contextRoot() { const value = requiredEnv('ZERO3_PROJECT_CONTEXT_DIR'); if (!path.isAbsolute(value)) throw new Error('ZERO3_PROJECT_CONTEXT_DIR must be absolute'); return path.resolve(value) }

function assertTask(value) { if (value !== taskId()) throw new Error('MCP tool is scoped to a different task') }
function assertProject(value) { if (value !== projectId()) throw new Error('MCP tool is scoped to a different project') }
function storageName(logicalId) { return createHash('sha256').update(logicalId, 'utf8').digest('hex') }
async function readJson(file) {
  try {
    const buffer = await fs.readFile(file)
    if (buffer.byteLength > MAX_JSON_BYTES) throw new Error('state file exceeds size limit')
    return JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
async function atomicJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error('state payload exceeds size limit')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, file)
}
function response(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } }

async function taskSnapshot(id) {
  assertTask(id)
  const value = await readJson(path.join(stateRoot(), 'tasks', `${storageName(id)}.json`))
  if (!value) throw new Error('Zero3 task snapshot is unavailable')
  if (value?.task?.taskId !== id && value?.taskId !== id) throw new Error('Zero3 task snapshot identity mismatch')
  return value
}
async function projectContext(id) {
  assertProject(id)
  return (await readJson(path.join(contextRoot(), 'projects', `${storageName(id)}.json`))) ?? { projectId: id, version: 0, payload: null }
}
async function artifactList(id) {
  assertTask(id)
  const value = (await readJson(path.join(artifactsRoot(), 'tasks', `${storageName(id)}.json`))) ?? []
  if (!Array.isArray(value)) throw new Error('artifact index is invalid')
  if (value.some(record => record?.taskId !== id)) throw new Error('artifact index task identity mismatch')
  return value
}
async function artifactGet(id, artifactId) {
  const list = await artifactList(id)
  const record = list.find(value => value?.artifactId === artifactId)
  if (!record) throw new Error('artifact not found for current task')
  const result = { ...record }
  try {
    const stat = await fs.stat(record.storedPath)
    if (stat.isFile() && stat.size <= MAX_TEXT_ARTIFACT_BYTES) {
      const buffer = await fs.readFile(record.storedPath)
      if (!buffer.includes(0)) result.textContent = buffer.toString('utf8')
    }
  } catch {}
  return result
}
async function reviewGet(id) {
  assertTask(id)
  const value = (await readJson(path.join(reviewsRoot(), `${storageName(id)}.json`))) ?? { taskId: id, state: 'DRAFT', cycles: [] }
  if (value?.taskId !== id) throw new Error('review record task identity mismatch')
  return value
}
async function publish(kind, id, payload) {
  assertTask(id)
  const file = path.join(stateRoot(), kind, `${storageName(id)}.json`)
  const current = (await readJson(file)) ?? { taskId: id, version: 0 }
  if (current?.taskId !== id) throw new Error('published task candidate identity mismatch')
  const next = { ...current, taskId: id, version: Number(current.version ?? 0) + 1, updatedAt: new Date().toISOString(), payload }
  await atomicJson(file, next)
  return next
}

function createServer() {
  const server = new McpServer({ name: SERVER, version: VERSION })
  server.registerTool('task_get', {
    title: 'Get current Zero3 task', description: 'Read the task snapshot bound to this Antigravity runtime.',
    inputSchema: z.object({ taskId: ID }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ taskId: id }) => response(await taskSnapshot(id)))
  server.registerTool('project_get_context', {
    title: 'Get Zero3 project context', description: 'Read the canonical project context bound to this task.',
    inputSchema: z.object({ projectId: ID }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ projectId: id }) => response(await projectContext(id)))
  server.registerTool('artifact_list', {
    title: 'List task artifacts', description: 'List content-addressed artifacts produced for the current task.',
    inputSchema: z.object({ taskId: ID }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ taskId: id }) => response(await artifactList(id)))
  server.registerTool('artifact_get', {
    title: 'Get task artifact', description: 'Read metadata and bounded text content for one artifact owned by the current task.',
    inputSchema: z.object({ taskId: ID, artifactId: ID }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ taskId: id, artifactId }) => response(await artifactGet(id, artifactId)))
  server.registerTool('review_get', {
    title: 'Get current review history', description: 'Read immutable review cycles for the current task.',
    inputSchema: z.object({ taskId: ID }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ taskId: id }) => response(await reviewGet(id)))
  server.registerTool('task_publish_progress', {
    title: 'Publish task progress', description: 'Publish task-scoped progress; cannot mutate review decisions.',
    inputSchema: z.object({ taskId: ID, progress: z.record(z.string(), z.unknown()) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ taskId: id, progress }) => response(await publish('progress', id, progress)))
  server.registerTool('task_publish_result', {
    title: 'Publish task result candidate', description: 'Publish a task-scoped structured result candidate. Zero3 CompletionGate remains authoritative.',
    inputSchema: z.object({ taskId: ID, result: z.record(z.string(), z.unknown()) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ taskId: id, result }) => response(await publish('result-candidates', id, result)))
  return server
}

try {
  taskId(); projectId(); stateRoot(); artifactsRoot(); reviewsRoot(); contextRoot()
  await serveStdio(createServer)
} catch (error) {
  console.error(`[${SERVER}] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}

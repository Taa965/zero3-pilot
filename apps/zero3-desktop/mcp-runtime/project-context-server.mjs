import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

const SERVER_NAME = 'zero3-project-context'
const SERVER_VERSION = '0.1.0'
const PROJECT_SCHEMA_VERSION = 1
const HANDOFF_SCHEMA_VERSION = 1
const EXECUTION_RESULT_PROTOCOL = 'zero3.pilot.execution-result.v1'
const MAX_JSON_BYTES = 2 * 1024 * 1024
const ID = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

function rootDir() {
  const configured = process.env.ZERO3_PROJECT_CONTEXT_DIR?.trim()
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error('ZERO3_PROJECT_CONTEXT_DIR must be an absolute directory')
  }
  return path.resolve(configured)
}

function storageName(logicalId) {
  return createHash('sha256').update(logicalId, 'utf8').digest('hex')
}

function fileFor(kind, id) {
  return path.join(rootDir(), kind, `${storageName(id)}.json`)
}

function serialized(value) {
  const text = JSON.stringify(value)
  if (text === undefined) throw new Error('payload must be a JSON value')
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error('payload exceeds the 2 MiB limit')
  return text
}

async function readJson(file) {
  try {
    const buffer = await fs.readFile(file)
    if (buffer.byteLength > MAX_JSON_BYTES) throw new Error('state file exceeds the 2 MiB limit')
    return JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeJson(file, value) {
  const text = `${serialized(value)}\n`
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, file)
}

let mutationTail = Promise.resolve()
function mutate(operation) {
  const task = mutationTail.then(operation, operation)
  mutationTail = task.then(() => undefined, () => undefined)
  return task
}

async function getProject(projectId) {
  const value = await readJson(fileFor('projects', projectId))
  if (!value) return { projectId, version: 0, payload: null }
  if (value.schemaVersion !== PROJECT_SCHEMA_VERSION || value.projectId !== projectId || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new Error('invalid persisted project context')
  }
  return value
}

async function putProject(projectId, expectedVersion, payload) {
  serialized(payload)
  return mutate(async () => {
    const current = await getProject(projectId)
    if (expectedVersion != null && expectedVersion !== current.version) {
      throw new Error(`project context version conflict: expected ${expectedVersion}, current ${current.version}`)
    }
    const next = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      payload
    }
    await writeJson(fileFor('projects', projectId), next)
    return next
  })
}

async function getHandoff(taskId) {
  const value = await readJson(fileFor('handoffs', taskId))
  if (!value) return { taskId, version: 0, result: null }
  if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION || value.taskId !== taskId || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new Error('invalid persisted handoff')
  }
  return value
}

async function putHandoff(taskId, expectedVersion, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('handoff result must be an object')
  if (result.protocol !== EXECUTION_RESULT_PROTOCOL) throw new Error(`handoff result.protocol must be ${EXECUTION_RESULT_PROTOCOL}`)
  if (result.task_id !== taskId) throw new Error('handoff taskId must match result.task_id')
  serialized(result)
  return mutate(async () => {
    const current = await getHandoff(taskId)
    if (expectedVersion != null && expectedVersion !== current.version) {
      throw new Error(`handoff version conflict: expected ${expectedVersion}, current ${current.version}`)
    }
    const next = {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      taskId,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      result
    }
    await writeJson(fileFor('handoffs', taskId), next)
    return next
  })
}

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  }
}

function serverFactory() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  server.registerTool(
    'project_get_context',
    {
      title: 'Get Zero3 Project Context',
      description: 'Read the canonical Zero3 project context snapshot.',
      inputSchema: z.object({ projectId: ID }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ projectId }) => result(await getProject(projectId))
  )
  server.registerTool(
    'project_put_context',
    {
      title: 'Update Zero3 Project Context',
      description: 'Replace canonical project context with optimistic version control.',
      inputSchema: z.object({
        projectId: ID,
        expectedVersion: z.number().int().nonnegative().optional(),
        payload: z.unknown()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ projectId, expectedVersion, payload }) => result(await putProject(projectId, expectedVersion, payload))
  )
  server.registerTool(
    'handoff_get',
    {
      title: 'Get Zero3 Execution Handoff',
      description: 'Read the latest structured execution result for a task.',
      inputSchema: z.object({ taskId: ID }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ taskId }) => result(await getHandoff(taskId))
  )
  server.registerTool(
    'handoff_publish',
    {
      title: 'Publish Zero3 Execution Handoff',
      description: `Persist a ${EXECUTION_RESULT_PROTOCOL} result with optimistic version control.`,
      inputSchema: z.object({
        taskId: ID,
        expectedVersion: z.number().int().nonnegative().optional(),
        result: z.record(z.string(), z.unknown())
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ taskId, expectedVersion, result: executionResult }) => result(await putHandoff(taskId, expectedVersion, executionResult))
  )
  return server
}

try {
  rootDir()
  await serveStdio(serverFactory)
} catch (error) {
  console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}

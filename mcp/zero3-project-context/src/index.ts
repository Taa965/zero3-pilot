import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

const SERVER_NAME = 'zero3-project-context'
const SERVER_VERSION = '0.1.0'
const PROJECT_CONTEXT_SCHEMA_VERSION = 1 as const
const HANDOFF_SCHEMA_VERSION = 1 as const
const EXECUTION_RESULT_PROTOCOL = 'zero3.pilot.execution-result.v1'
const MAX_JSON_BYTES = 2 * 1024 * 1024

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)

const ProjectContextRecordSchema = z.object({
  schemaVersion: z.literal(PROJECT_CONTEXT_SCHEMA_VERSION),
  projectId: IdSchema,
  version: z.number().int().positive(),
  updatedAt: z.string(),
  payload: z.unknown()
})

type ProjectContextRecord = z.infer<typeof ProjectContextRecordSchema>

const HandoffRecordSchema = z.object({
  schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
  taskId: IdSchema,
  version: z.number().int().positive(),
  updatedAt: z.string(),
  result: z.unknown()
})

type HandoffRecord = z.infer<typeof HandoffRecordSchema>

function stateRoot(): string {
  const configured = process.env.ZERO3_PROJECT_CONTEXT_DIR?.trim()
  if (!configured) {
    throw new Error('ZERO3_PROJECT_CONTEXT_DIR must be set to an absolute local state directory')
  }
  if (!path.isAbsolute(configured)) {
    throw new Error('ZERO3_PROJECT_CONTEXT_DIR must be absolute')
  }
  return path.resolve(configured)
}

function projectFile(projectId: string): string {
  return path.join(stateRoot(), 'projects', `${projectId}.json`)
}

function handoffFile(taskId: string): string {
  return path.join(stateRoot(), 'handoffs', `${taskId}.json`)
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    const buffer = await fs.readFile(file)
    if (buffer.byteLength > MAX_JSON_BYTES) throw new Error(`state file exceeds ${MAX_JSON_BYTES} bytes`)
    return JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
    throw new Error(`state payload exceeds ${MAX_JSON_BYTES} bytes`)
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, file)
}

class SerialMutations {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }
}

const mutations = new SerialMutations()

async function getProjectContext(projectId: string): Promise<ProjectContextRecord | null> {
  const value = await readJson(projectFile(projectId))
  if (value == null) return null
  return ProjectContextRecordSchema.parse(value)
}

async function putProjectContext(input: {
  projectId: string
  expectedVersion?: number
  payload: unknown
}): Promise<ProjectContextRecord> {
  if (jsonBytes(input.payload) > MAX_JSON_BYTES) throw new Error('project context payload is too large')
  return mutations.run(async () => {
    const current = await getProjectContext(input.projectId)
    const currentVersion = current?.version ?? 0
    if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
      throw new Error(`project context version conflict: expected ${input.expectedVersion}, current ${currentVersion}`)
    }
    const next: ProjectContextRecord = {
      schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
      projectId: input.projectId,
      version: currentVersion + 1,
      updatedAt: new Date().toISOString(),
      payload: input.payload
    }
    await atomicWrite(projectFile(input.projectId), next)
    return next
  })
}

async function getHandoff(taskId: string): Promise<HandoffRecord | null> {
  const value = await readJson(handoffFile(taskId))
  if (value == null) return null
  return HandoffRecordSchema.parse(value)
}

function assertExecutionResult(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('handoff result must be an object')
  }
  const protocol = (value as Record<string, unknown>).protocol
  if (protocol !== EXECUTION_RESULT_PROTOCOL) {
    throw new Error(`handoff result.protocol must be ${EXECUTION_RESULT_PROTOCOL}`)
  }
}

async function publishHandoff(input: {
  taskId: string
  expectedVersion?: number
  result: unknown
}): Promise<HandoffRecord> {
  assertExecutionResult(input.result)
  if (jsonBytes(input.result) > MAX_JSON_BYTES) throw new Error('handoff result is too large')
  return mutations.run(async () => {
    const current = await getHandoff(input.taskId)
    const currentVersion = current?.version ?? 0
    if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
      throw new Error(`handoff version conflict: expected ${input.expectedVersion}, current ${currentVersion}`)
    }
    const next: HandoffRecord = {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      taskId: input.taskId,
      version: currentVersion + 1,
      updatedAt: new Date().toISOString(),
      result: input.result
    }
    await atomicWrite(handoffFile(input.taskId), next)
    return next
  })
}

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value
  }
}

function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  server.registerTool(
    'project_get_context',
    {
      title: 'Get Zero3 Project Context',
      description: 'Read the canonical Zero3 project-level context snapshot shared across supervising and local agent sessions.',
      inputSchema: z.object({ projectId: IdSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ projectId }) => toolResult((await getProjectContext(projectId)) ?? { projectId, version: 0, payload: null })
  )

  server.registerTool(
    'project_put_context',
    {
      title: 'Update Zero3 Project Context',
      description: 'Replace the canonical project context using optimistic version control. Supply expectedVersion to prevent stale writers.',
      inputSchema: z.object({
        projectId: IdSchema,
        expectedVersion: z.number().int().nonnegative().optional(),
        payload: z.unknown()
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ projectId, expectedVersion, payload }) => toolResult(await putProjectContext({ projectId, expectedVersion, payload }))
  )

  server.registerTool(
    'handoff_get',
    {
      title: 'Get Zero3 Execution Handoff',
      description: 'Read the latest structured zero3.pilot.execution-result.v1 handoff for a task.',
      inputSchema: z.object({ taskId: IdSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ taskId }) => toolResult((await getHandoff(taskId)) ?? { taskId, version: 0, result: null })
  )

  server.registerTool(
    'handoff_publish',
    {
      title: 'Publish Zero3 Execution Handoff',
      description: `Persist a structured ${EXECUTION_RESULT_PROTOCOL} handoff using optimistic version control.`,
      inputSchema: z.object({
        taskId: IdSchema,
        expectedVersion: z.number().int().nonnegative().optional(),
        result: z.unknown()
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ taskId, expectedVersion, result }) => toolResult(await publishHandoff({ taskId, expectedVersion, result }))
  )

  return server
}

try {
  stateRoot()
  await serveStdio(() => createServer())
} catch (error) {
  console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}

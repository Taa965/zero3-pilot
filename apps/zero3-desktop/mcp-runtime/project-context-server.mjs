import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import fs from 'node:fs/promises'
import * as z from 'zod/v4'

import { createProjectContextCore, EXECUTION_RESULT_PROTOCOL, ID_PATTERN, resolveContextRoot } from './project-context-core.mjs'

const SERVER_NAME = 'zero3-project-context'
const SERVER_VERSION = '0.2.0'
const ID = z.string().min(1).max(256).regex(ID_PATTERN)

function activeProjectId() {
  const configured = process.env.ZERO3_ACTIVE_PROJECT_ID?.trim()
  if (!configured) return null
  if (!ID_PATTERN.test(configured) || configured.length > 256) throw new Error('ZERO3_ACTIVE_PROJECT_ID is invalid')
  return configured
}
function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}
function serverFactory(core, shared, projectId) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, shared ? {
    instructions: `Shared memory is active for project ${projectId}. Read project_get_context before relying on prior project decisions. Use memory_get_scope to discover this session's project. Publish only relevant durable facts or task handoffs; never credentials or whole chats. Use the entity version from the latest read. Only acked means shared; pending is offline and conflicts require re-reading. Other projects have separate scopes.`
  } : {})
  server.registerTool('project_get_context', {
    title: 'Get Zero3 Project Context', description: 'Read the canonical Zero3 project context snapshot.',
    inputSchema: z.object({ projectId: ID }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ projectId }) => result(await (shared ?? core).getProject(projectId)))
  if (!shared) server.registerTool('project_put_context', {
    title: 'Update Zero3 Project Context', description: 'Replace canonical project context with optimistic version control. Call project_get_context first and pass the version it returns (0 when the project has no context yet). Re-read and merge after a version conflict; never overwrite it blindly.',
    inputSchema: z.object({ projectId: ID, expectedVersion: z.number().int().nonnegative(), payload: z.unknown() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ projectId, expectedVersion, payload }) => {
    if (shared) throw new Error('Shared authority is event-based. Use memory_publish_event; local snapshot replacement is disabled while shared memory is configured.')
    return result(await core.putProject(projectId, expectedVersion, payload))
  })
  if (shared) {
    server.registerTool('memory_get_scope', {
      title: 'Current shared memory project', description: 'Discover the project ID automatically selected for this Codex session. All new projects and sessions can use shared memory; each workspace keeps its own scope.',
      inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async () => result({ projectId }))
    server.registerTool('memory_publish_event', {
      title: 'Publish shared memory event',
      description: 'Publish a zero3.memory.event.v1 project/task event. Supply a stable UUID and expected_entity_version. Authority must be <=60. pending means queued offline, acked means committed, conflict requires re-reading and a new merged event. Never claim pending is shared.',
      inputSchema: z.object({ event: z.record(z.string(), z.unknown()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async ({ event }) => result(await shared.publish(event)))
    server.registerTool('memory_sync_status', {
      title: 'Shared memory synchronization status',
      description: 'Inspect the durable queue, replay cursor, and status of a published event.',
      inputSchema: z.object({ eventId: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ eventId }) => result(shared.status(eventId)))
  }
  server.registerTool('handoff_get', {
    title: 'Get Zero3 Execution Handoff', description: 'Read the latest structured execution result for a task.',
    inputSchema: z.object({ taskId: ID }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ taskId }) => result(await (shared ?? core).getHandoff(taskId)))
  server.registerTool('handoff_publish', {
    title: 'Publish Zero3 Execution Handoff', description: `Persist a ${EXECUTION_RESULT_PROTOCOL} result with optimistic version control.`,
    inputSchema: z.object({ taskId: ID, expectedVersion: z.number().int().nonnegative(), result: z.record(z.string(), z.unknown()) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ taskId, expectedVersion, result: executionResult }) => result(await (shared ?? core).putHandoff(taskId, expectedVersion, executionResult)))
  return server
}

try {
  const root = resolveContextRoot()
  const configPath = process.env.ZERO3_SHARED_MEMORY_CONFIG?.trim()
  const config = configPath ? JSON.parse(await fs.readFile(configPath, 'utf8')) : null
  const projectId = process.env.ZERO3_MEMORY_AUTO_PROJECT === '1' && config
    ? (await import('../memory-sync-runtime/workspace-scope.mjs')).resolveWorkspaceScope({ config }).projectId : activeProjectId()
  const core = createProjectContextCore({ rootDir: root, activeProjectId: projectId })
  const sharedForProject = config?.projects?.includes(projectId) || config?.projects?.includes('*')
  const shared = sharedForProject ? await (await import('../memory-sync-runtime/shared-memory-runtime.mjs')).openSharedMemory({ configPath, projectId }) : null
  process.stdin.once('end', () => { void shared?.close() })
  await serveStdio(() => serverFactory(core, shared, projectId))
} catch (error) {
  console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}

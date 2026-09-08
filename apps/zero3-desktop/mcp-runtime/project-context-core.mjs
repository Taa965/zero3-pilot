import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const PROJECT_SCHEMA_VERSION = 1
export const HANDOFF_SCHEMA_VERSION = 1
export const EXECUTION_RESULT_PROTOCOL = 'zero3.pilot.execution-result.v1'
export const MAX_JSON_BYTES = 2 * 1024 * 1024
export const ID_PATTERN = /^[A-Za-z0-9._:-]+$/

export function assertLogicalId(value, label = 'id') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 256 || !ID_PATTERN.test(text)) throw new Error(`${label} is invalid`)
  return text
}

export function resolveContextRoot(value = process.env.ZERO3_PROJECT_CONTEXT_DIR) {
  const configured = typeof value === 'string' ? value.trim() : ''
  if (!configured || !path.isAbsolute(configured)) throw new Error('ZERO3_PROJECT_CONTEXT_DIR must be an absolute directory')
  return path.resolve(configured)
}

function storageName(logicalId) {
  return createHash('sha256').update(logicalId, 'utf8').digest('hex')
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

export function createProjectContextCore(options = {}) {
  const root = resolveContextRoot(options.rootDir)
  const activeProjectId = options.activeProjectId == null ? null : assertLogicalId(options.activeProjectId, 'active project id')
  let mutationTail = Promise.resolve()

  function assertProjectScope(projectId) {
    if (activeProjectId && activeProjectId !== projectId) throw new Error('project context access denied for inactive project')
  }

  function fileFor(kind, id) {
    return path.join(root, kind, `${storageName(id)}.json`)
  }

  function mutate(operation) {
    const task = mutationTail.then(operation, operation)
    mutationTail = task.then(() => undefined, () => undefined)
    return task
  }

  async function getProject(rawProjectId) {
    const projectId = assertLogicalId(rawProjectId, 'projectId')
    assertProjectScope(projectId)
    const value = await readJson(fileFor('projects', projectId))
    if (!value) return { projectId, version: 0, payload: null }
    if (value.schemaVersion !== PROJECT_SCHEMA_VERSION || value.projectId !== projectId || !Number.isSafeInteger(value.version) || value.version < 1) {
      throw new Error('invalid persisted project context')
    }
    return value
  }

  async function putProject(rawProjectId, expectedVersion, payload) {
    const projectId = assertLogicalId(rawProjectId, 'projectId')
    assertProjectScope(projectId)
    serialized(payload)
    return mutate(async () => {
      const current = await getProject(projectId)
      // Required, not optional: a caller that omits it would silently bypass the
      // concurrency check and overwrite whatever another writer just stored.
      // Read the project first -- an absent one reports version 0.
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new Error('expectedVersion is required; read the project context first')
      }
      if (expectedVersion !== current.version) {
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

  async function getHandoff(rawTaskId) {
    const taskId = assertLogicalId(rawTaskId, 'taskId')
    const value = await readJson(fileFor('handoffs', taskId))
    if (!value) return { taskId, version: 0, result: null }
    if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION || value.taskId !== taskId || !Number.isSafeInteger(value.version) || value.version < 1) {
      throw new Error('invalid persisted handoff')
    }
    return value
  }

  async function putHandoff(rawTaskId, expectedVersion, result) {
    const taskId = assertLogicalId(rawTaskId, 'taskId')
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('handoff result must be an object')
    if (result.protocol !== EXECUTION_RESULT_PROTOCOL) throw new Error(`handoff result.protocol must be ${EXECUTION_RESULT_PROTOCOL}`)
    if (result.task_id !== taskId) throw new Error('handoff taskId must match result.task_id')
    serialized(result)
    return mutate(async () => {
      const current = await getHandoff(taskId)
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new Error('expectedVersion is required; read the handoff first')
      }
      if (expectedVersion !== current.version) {
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

  return { getProject, putProject, getHandoff, putHandoff }
}

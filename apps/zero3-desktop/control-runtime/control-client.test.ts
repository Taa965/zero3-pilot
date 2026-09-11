import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Zero3ControlClient } from './control-client.ts'

const TASK_EXTENSION_SCHEMA = 'zero3.pilot.task-extension.v1'
const EXTENSION_FIELDS = ['project_context', 'handoff', 'provider', 'review'] as const

type Json = Record<string, any>

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Json)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}

function sameSidecar(stored: Json, body: Json): boolean {
  return stored.schema === body.schema && stored.execution_id === body.execution_id
    && EXTENSION_FIELDS.every(field => canonical(stored[field] ?? null) === canonical(body[field] ?? null))
}

const jsonReply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body ?? null)
}) as unknown as Response

/**
 * Minimal in-memory stand-in for the deployed control plane. `strictReplay`
 * models the plane before the sidecar replay fix: the version check rejects a
 * resend of an identical payload, which is exactly the retry the Fast Path has
 * to survive. Without it the plane returns the stored sidecar, like the fixed
 * Rust store does.
 */
function controlPlaneStub({ strictReplay }: { strictReplay: boolean }) {
  const extensions = new Map<string, Json>()
  const tasks = new Map<string, Json>()
  const requests: string[] = []
  let failNextExtension = 0

  const reply = jsonReply

  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    requests.push(`${method} ${url.pathname}`)
    const body: Json = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : {}

    const extensionMatch = /^\/api\/control\/v1\/tasks\/([^/]+)\/extensions$/u.exec(url.pathname)
    if (extensionMatch) {
      const taskId = decodeURIComponent(extensionMatch[1])
      const stored = extensions.get(taskId)
      if (method === 'GET') {
        return reply(200, stored ?? { schema: TASK_EXTENSION_SCHEMA, task_id: taskId, version: 0 })
      }
      if (failNextExtension > 0) {
        failNextExtension -= 1
        return reply(503, { error: 'task extension store unavailable' })
      }
      if (stored) {
        if (stored.execution_id !== body.execution_id) {
          return reply(409, { error: 'task_id is already bound to a different execution_id' })
        }
        const current = Number(stored.version ?? 0)
        if (body.expected_version != null && body.expected_version !== current) {
          if (strictReplay || !sameSidecar(stored, body)) {
            return reply(409, { error: `task extension version conflict: expected ${body.expected_version}, current ${current}` })
          }
          return reply(200, stored)
        }
      }
      const record: Json = {
        schema: TASK_EXTENSION_SCHEMA,
        task_id: taskId,
        execution_id: body.execution_id,
        version: Number(stored?.version ?? 0) + 1,
        created_at: '2026-09-12T00:00:00Z',
        updated_at: '2026-09-12T00:00:00Z'
      }
      for (const field of EXTENSION_FIELDS) if (body[field] != null) record[field] = body[field]
      extensions.set(taskId, record)
      return reply(stored ? 200 : 201, record)
    }

    if (url.pathname === '/api/control/v1/tasks' && method === 'POST') {
      const stored = tasks.get(body.task_id)
      if (stored) {
        if (stored.execution_id !== body.execution_id || canonical(stored) !== canonical(body)) {
          return reply(409, { error: 'task_id is already bound to a different execution or task payload' })
        }
        return reply(200, { task: stored, state: 'queued' })
      }
      tasks.set(body.task_id, body)
      return reply(201, { task: body, state: 'queued' })
    }

    return reply(404, { error: 'not found' })
  }) as unknown as typeof fetch

  return {
    requests,
    extensions,
    tasks,
    fetchImpl,
    failNextExtensionRequest: () => { failNextExtension += 1 }
  }
}

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-control-replay-'))
}

function client(root: string, fetchImpl: typeof fetch): Zero3ControlClient {
  const tokenFile = path.join(root, 'control.token')
  fs.writeFileSync(tokenFile, 'control-token\n')
  globalThis.fetch = fetchImpl
  return new Zero3ControlClient({ baseUrl: 'https://control.invalid', tokenFile, developmentAllowHttp: false })
}

function dispatch(taskId: string, contextVersion: number) {
  return {
    task: {
      protocol: 'zero3.pilot.remote-task.v1',
      task_id: taskId,
      execution_id: `${taskId}-exec`,
      objective: 'Implement the approved scoped change',
      target: { workspace: 'C:\\workspace' },
      permission_profile: 'standard',
      execution: { max_turns: 2, timeout_seconds: 3600 }
    },
    extension: { project_context: { project_id: 'zero3-pilot', context_version: contextVersion } }
  }
}

test('dispatchCodex writes the sidecar before the core task with a first-writer version', async () => {
  const root = workspace()
  const original = globalThis.fetch
  try {
    const plane = controlPlaneStub({ strictReplay: false })
    const control = client(root, plane.fetchImpl)
    const result: any = await control.dispatchCodex(dispatch('task-1', 7))
    assert.equal(result.state, 'queued')
    assert.deepEqual(plane.requests, [
      'POST /api/control/v1/tasks/task-1/extensions',
      'POST /api/control/v1/tasks'
    ])
    assert.equal(plane.extensions.get('task-1').execution_id, 'task-1-exec')
    assert.equal(plane.extensions.get('task-1').version, 1)
  } finally {
    globalThis.fetch = original
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an identical dispatch replays idempotently against a strict version-checking plane', async () => {
  const root = workspace()
  const original = globalThis.fetch
  try {
    const plane = controlPlaneStub({ strictReplay: true })
    const control = client(root, plane.fetchImpl)
    const first: any = await control.dispatchCodex(dispatch('task-1', 7))
    const replay: any = await control.dispatchCodex(dispatch('task-1', 7))
    assert.equal(replay.state, 'queued')
    assert.equal(plane.extensions.get('task-1').version, 1)
    assert.equal(plane.requests.filter(entry => entry === 'POST /api/control/v1/tasks').length, 2)
    assert.deepEqual(plane.requests.slice(2), [
      'POST /api/control/v1/tasks/task-1/extensions',
      'GET /api/control/v1/tasks/task-1/extensions',
      'POST /api/control/v1/tasks'
    ])
    assert.equal(canonical(first.task), canonical(replay.task))
  } finally {
    globalThis.fetch = original
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a conflicting sidecar replay fails closed without dispatching the task', async () => {
  const root = workspace()
  const original = globalThis.fetch
  try {
    const plane = controlPlaneStub({ strictReplay: true })
    const control = client(root, plane.fetchImpl)
    await control.dispatchCodex(dispatch('task-1', 7))
    const before = plane.requests.length
    await assert.rejects(() => control.dispatchCodex(dispatch('task-1', 8)), /version conflict/)
    assert.deepEqual(plane.requests.slice(before), [
      'POST /api/control/v1/tasks/task-1/extensions',
      'GET /api/control/v1/tasks/task-1/extensions'
    ])
    assert.equal(plane.extensions.get('task-1').version, 1)
    assert.equal(plane.extensions.get('task-1').project_context.context_version, 7)
  } finally {
    globalThis.fetch = original
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a different execution for the same task fails closed', async () => {
  const root = workspace()
  const original = globalThis.fetch
  try {
    const plane = controlPlaneStub({ strictReplay: true })
    const control = client(root, plane.fetchImpl)
    await control.dispatchCodex(dispatch('task-1', 7))
    const conflicting = dispatch('task-1', 7)
    conflicting.task.execution_id = 'other-exec'
    await assert.rejects(() => control.dispatchCodex(conflicting), /different execution_id/)
    assert.equal(plane.extensions.get('task-1').execution_id, 'task-1-exec')
  } finally {
    globalThis.fetch = original
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a conflict without a stored sidecar is not treated as a replay', async () => {
  const root = workspace()
  const original = globalThis.fetch
  try {
    const requests: string[] = []
    const stub = (async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input))
      requests.push(`${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`)
      if (url.pathname.endsWith('/extensions') && (init.method ?? 'GET').toUpperCase() === 'POST') {
        return jsonReply(409, { error: 'task extension version conflict: expected 0, current 1' })
      }
      return jsonReply(200, { schema: TASK_EXTENSION_SCHEMA, task_id: 'task-1', version: 0 })
    }) as unknown as typeof fetch
    const control = client(root, stub)
    await assert.rejects(() => control.dispatchCodex(dispatch('task-1', 7)), /version conflict/)
    assert.equal(requests.filter(entry => entry === 'POST /api/control/v1/tasks').length, 0)
  } finally {
    globalThis.fetch = original
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('control-plane failures other than a conflict are surfaced unchanged', async () => {
  const root = workspace()
  const original = globalThis.fetch
  try {
    const plane = controlPlaneStub({ strictReplay: true })
    plane.failNextExtensionRequest()
    const control = client(root, plane.fetchImpl)
    await assert.rejects(() => control.dispatchCodex(dispatch('task-1', 7)), /HTTP 503/)
  } finally {
    globalThis.fetch = original
    fs.rmSync(root, { recursive: true, force: true })
  }
})

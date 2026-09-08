import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  filterWebEgressPayload,
  isProjectWebAllowed,
  mergeWebIngressPayload,
  readAccessPolicy,
  readBearerToken,
  rotateBearerToken,
  setProjectWebAccess
} from './project-context-http-policy.mjs'

async function withStateDir(run) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-mcp-http-policy-'))
  try {
    await run(stateDir)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
}

test('web MCP project access is fail-closed and explicitly enabled per project', async () => {
  await withStateDir(async stateDir => {
    assert.deepEqual(await readAccessPolicy({ stateDir }), { schemaVersion: 1, projects: {} })
    assert.equal(await isProjectWebAllowed('project-a', { stateDir }), false)

    assert.deepEqual(await setProjectWebAccess('project-a', true, { stateDir }), {
      projectId: 'project-a',
      enabled: true
    })
    assert.equal(await isProjectWebAllowed('project-a', { stateDir }), true)
    assert.equal(await isProjectWebAllowed('project-b', { stateDir }), false)

    await setProjectWebAccess('project-a', false, { stateDir })
    assert.equal(await isProjectWebAllowed('project-a', { stateDir }), false)
  })
})

test('bearer token is stable until rotation and rotation invalidates the stored token', async () => {
  await withStateDir(async stateDir => {
    const first = await readBearerToken({ stateDir })
    assert.match(first, /^[a-f0-9]{64}$/)
    assert.equal(await readBearerToken({ stateDir }), first)

    const rotated = await rotateBearerToken({ stateDir })
    assert.match(rotated, /^[a-f0-9]{64}$/)
    assert.notEqual(rotated, first)
    assert.equal(await readBearerToken({ stateDir }), rotated)
  })
})

test('web egress and ingress are restricted to approved memory fields', () => {
  const outbound = filterWebEgressPayload({
    decisions: ['d1'],
    pitfalls: ['p1'],
    glossary: { term: 'meaning' },
    credentials: { token: 'must-not-leave' },
    privateNotes: ['local-only']
  })
  assert.deepEqual(outbound, {
    decisions: ['d1'],
    pitfalls: ['p1'],
    glossary: { term: 'meaning' }
  })

  const merged = mergeWebIngressPayload(
    {
      decisions: ['old'],
      pitfalls: ['old'],
      glossary: { old: true },
      credentials: { token: 'preserve-local-only' },
      privateNotes: ['preserve-local-only']
    },
    {
      decisions: ['new'],
      glossary: { new: true },
      credentials: { token: 'ignored' }
    }
  )

  assert.deepEqual(merged, {
    decisions: ['new'],
    pitfalls: ['old'],
    glossary: { new: true },
    credentials: { token: 'preserve-local-only' },
    privateNotes: ['preserve-local-only']
  })

  assert.throws(
    () => mergeWebIngressPayload({}, { decisions: 'not-an-array' }),
    /decisions must be an array/
  )
})

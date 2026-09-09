import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createProjectContextCore } from './project-context-core.mjs'
import './project-context-http-policy.test.mjs'

async function withContextRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zero3-project-context-'))
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('project context persists with optimistic version control', async () => {
  await withContextRoot(async root => {
    const core = createProjectContextCore({ rootDir: root, activeProjectId: 'project-a' })

    assert.deepEqual(await core.getProject('project-a'), {
      projectId: 'project-a',
      version: 0,
      payload: null
    })

    const written = await core.putProject('project-a', 0, {
      decisions: ['keep project memory local-first'],
      glossary: { authority: 'projectId' }
    })
    assert.equal(written.version, 1)
    assert.equal(written.projectId, 'project-a')

    await assert.rejects(
      () => core.putProject('project-a', 0, { decisions: ['stale overwrite'] }),
      /project context version conflict: expected 0, current 1/
    )

    const reopened = createProjectContextCore({ rootDir: root, activeProjectId: 'project-a' })
    const restored = await reopened.getProject('project-a')
    assert.equal(restored.version, 1)
    assert.deepEqual(restored.payload, written.payload)
  })
})

test('active project scope rejects cross-project reads and writes', async () => {
  await withContextRoot(async root => {
    const projectA = createProjectContextCore({ rootDir: root, activeProjectId: 'project-a' })
    const projectB = createProjectContextCore({ rootDir: root, activeProjectId: 'project-b' })

    await projectA.putProject('project-a', 0, { owner: 'A' })
    await projectB.putProject('project-b', 0, { owner: 'B' })

    await assert.rejects(
      () => projectA.getProject('project-b'),
      /project context access denied for inactive project/
    )
    await assert.rejects(
      () => projectA.putProject('project-b', 1, { owner: 'A-overwrite' }),
      /project context access denied for inactive project/
    )
    await assert.rejects(
      () => projectB.getProject('project-a'),
      /project context access denied for inactive project/
    )

    const a = await projectA.getProject('project-a')
    const b = await projectB.getProject('project-b')
    assert.equal(a.version, 1)
    assert.equal(b.version, 1)
    assert.deepEqual(a.payload, { owner: 'A' })
    assert.deepEqual(b.payload, { owner: 'B' })
  })
})

test('failed atomic replacement cleans temporary files and preserves the previous context', async t => {
  await withContextRoot(async root => {
    const core = createProjectContextCore({ rootDir: root, activeProjectId: 'project-a' })
    await core.putProject('project-a', 0, { value: 'original' })
    const projects = path.join(root, 'projects')
    const originalFiles = await fs.readdir(projects)
    const rename = t.mock.method(fs, 'rename', async () => {
      throw Object.assign(new Error('simulated replacement failure'), { code: 'EPERM' })
    })
    try {
      await assert.rejects(core.putProject('project-a', 1, { value: 'replacement' }), /simulated replacement failure/)
      assert.deepEqual(await fs.readdir(projects), originalFiles)
      const unchanged = await core.getProject('project-a')
      assert.equal(unchanged.version, 1)
      assert.deepEqual(unchanged.payload, { value: 'original' })
    } finally {
      rename.mock.restore()
    }
    const retried = await core.putProject('project-a', 1, { value: 'retried' })
    assert.equal(retried.version, 2)
    assert.deepEqual(retried.payload, { value: 'retried' })
    assert.deepEqual(await fs.readdir(projects), originalFiles)
  })
})

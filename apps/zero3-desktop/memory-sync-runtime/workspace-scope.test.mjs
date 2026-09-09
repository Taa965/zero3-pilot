import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveWorkspaceScope } from './workspace-scope.mjs'
import { validateSharedMemoryConfig } from './shared-memory-runtime.mjs'

test('global opt-in still requires a concrete project and preserves restricted configs', () => {
  const config = { baseUrl: 'http://localhost:8792', token: 'fixture', clientId: 'fixture', deviceId: 'fixture', cacheDir: os.tmpdir(), projects: ['*'] }
  assert.equal(validateSharedMemoryConfig(config, 'project-new'), config)
  for (const id of ['*', '', null]) assert.throws(() => validateSharedMemoryConfig(config, id), /not configured/)
  assert.throws(() => validateSharedMemoryConfig({ ...config, projects: ['project-one'] }, 'project-two'), /not configured/)
})

test('global scope reuses registered projects and worktrees, separates new workspaces, and survives origin changes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scope-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', windowsHide: true })
  const repo = path.join(dir, 'repo'), other = path.join(dir, 'other'), worktree = path.join(dir, 'worktree')
  for (const root of [repo, other]) { fs.mkdirSync(root); git(root, 'init') }
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture')
  git(repo, 'worktree', 'add', '--detach', worktree)
  const config = { cacheDir: path.join(dir, 'cache'), projectMappings: { [repo]: 'project-existing' } }
  const resolve = cwd => resolveWorkspaceScope({ cwd, config }).projectId
  assert.equal(resolve(repo), 'project-existing')
  assert.equal(resolve(worktree), 'project-existing')
  const newId = resolve(other)
  assert.notEqual(newId, 'project-existing')
  git(other, 'remote', 'add', 'origin', 'https://github.com/example/repo.git')
  assert.equal(resolve(other), newId)
  const plain = path.join(dir, 'plain')
  fs.mkdirSync(plain)
  assert.notEqual(resolve(plain), newId)
  assert.equal(resolve(plain), resolve(plain))
})

test('new clones with equivalent HTTPS and SSH origins share an identity', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-clone-scope-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ids = ['https://github.com/Example/Repo.git', 'git@github.com:example/repo.git'].map((remote, i) => {
    const cwd = path.join(dir, String(i)); fs.mkdirSync(cwd)
    execFileSync('git', ['init', cwd], { stdio: 'pipe', windowsHide: true })
    execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', remote], { windowsHide: true })
    return resolveWorkspaceScope({ cwd, config: { cacheDir: path.join(dir, `cache-${i}`) } }).projectId
  })
  assert.equal(ids[0], ids[1])
})

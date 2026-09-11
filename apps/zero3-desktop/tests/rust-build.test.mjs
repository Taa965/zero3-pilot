import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ensureZero3WeixinBinary, resolveCargo, runCargo, zero3WeixinBinary } from '../scripts/rust-build.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3 rust build '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { PATH: '', CARGO_HOME: path.join(root, 'rust') }
  const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture') }
  return { root, env, write }
}

test('desktop reload reuses an existing robot with Cargo absent', t => {
  const { root, env, write } = fixture(t)
  const binary = zero3WeixinBinary(root)
  write(binary)
  assert.throws(() => resolveCargo(env), /未找到 Cargo/)
  assert.equal(ensureZero3WeixinBinary({ repoRoot: root, env, desktopReload: true, log() {},
    build() { assert.fail('Reload must not invoke Cargo') } }), binary)
})

test('a missing robot on reload still requires a successful build', t => {
  const { root, env, write } = fixture(t)
  const binary = zero3WeixinBinary(root)
  let builds = 0
  assert.equal(ensureZero3WeixinBinary({ repoRoot: root, env, desktopReload: true,
    build(args, options) {
      builds++
      assert.deepEqual(args, ['build', '-p', 'zero3-weixin'])
      assert.equal(options.cwd, root)
      assert.equal(options.env, env)
      write(binary)
    } }), binary)
  assert.equal(builds, 1)
})

for (const profile of ['debug', 'release']) {
  test(`${profile} builds do not skip compilation when a binary exists`, t => {
    const { root, env, write } = fixture(t)
    const binary = zero3WeixinBinary(root, profile)
    write(binary)
    let builds = 0
    ensureZero3WeixinBinary({ repoRoot: root, env, profile, desktopReload: profile === 'release',
      build(args) {
        builds++
        assert.deepEqual(args, ['build', '-p', 'zero3-weixin', ...(profile === 'release' ? ['--release'] : [])])
      } })
    assert.equal(builds, 1)
    assert.throws(() => ensureZero3WeixinBinary({ repoRoot: root, env, profile,
      build() { throw new Error('compiler failed') } }), /compiler failed/)
  })
}

test('missing compiler and missing build output report actionable failures', t => {
  const { root, env } = fixture(t)
  assert.throws(() => ensureZero3WeixinBinary({ repoRoot: root, env, desktopReload: true }), /未找到 Cargo.*CARGO_HOME/)
  assert.throws(() => ensureZero3WeixinBinary({ repoRoot: root, env, build() {} }), /binary was not produced/)
})

test('Cargo resolution honours PATH before custom CARGO_HOME, including spaces', t => {
  const { root, env, write } = fixture(t)
  const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const custom = path.join(env.CARGO_HOME, 'bin', executable)
  write(custom)
  assert.equal(resolveCargo(env), custom)
  const onPath = path.join(root, 'path bin', executable)
  write(onPath)
  assert.equal(resolveCargo({ Path: `"${path.dirname(onPath)}"`, CARGO_HOME: env.CARGO_HOME }), onPath)
})

test('Cargo resolution finds the default user installation with a stale PATH', t => {
  const { root, write } = fixture(t)
  const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const cargo = path.join(root, '.cargo', 'bin', executable)
  write(cargo)
  assert.equal(resolveCargo({ PATH: '', USERPROFILE: root }), cargo)
})

test('Cargo runs without a shell, preserves cwd/env and propagates failures', t => {
  const { root, env, write } = fixture(t)
  const cargo = path.join(env.CARGO_HOME, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  write(cargo)
  const args = ['build', '--release']
  runCargo(args, { cwd: root, env, spawn(file, actualArgs, options) {
    assert.equal(file, cargo)
    assert.equal(actualArgs, args)
    assert.deepEqual(options, { cwd: root, env, stdio: 'inherit', shell: false })
    return { status: 0 }
  } })
  assert.throws(() => runCargo(args, { cwd: root, env, spawn: () => ({ status: 101 }) }), /status 101/)
  assert.throws(() => runCargo(args, { cwd: root, env, spawn: () => ({ error: new Error('spawn failed') }) }), /spawn failed/)
})

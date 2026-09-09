const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const path = require('node:path')
const os = require('node:os')
test('Windows launchers and direct Electron launches use the same fixed root despite inherited overrides', async () => {
  const { fixedDirectorySetup } = await import('../scripts/apply-data-directory.mjs')
  const { resolveZero3DataRoot, resolveCodexHome, resolveHermesHome } = await import('../scripts/config.mjs')
  const env = { HERMES_DESKTOP_USER_DATA_DIR: 'C:/isolated', ZERO3_CODEX_HOME: 'C:/other' }
  vm.runInNewContext(fixedDirectorySetup, { process: { platform: 'win32', env }, path, os })
  const root = path.join(os.homedir(), 'Documents', 'Zero3 Pilot')
  assert.equal(env.HERMES_DESKTOP_USER_DATA_DIR, root)
  assert.equal(env.CODEX_HOME, path.join(root, 'codex'))
  assert.equal(env.HERMES_HOME, path.join(root, 'hermes'))
  if (process.platform === 'win32') {
    assert.equal(resolveZero3DataRoot(), root)
    assert.equal(resolveCodexHome(), env.CODEX_HOME)
    assert.equal(resolveHermesHome(), env.HERMES_HOME)
  }
})
test('non-Windows custom paths remain untouched', async () => {
  const { fixedDirectorySetup } = await import('../scripts/apply-data-directory.mjs')
  const env = { HERMES_DESKTOP_USER_DATA_DIR: '/custom' }
  vm.runInNewContext(fixedDirectorySetup, { process: { platform: 'linux', env }, path, os })
  assert.deepEqual(env, { HERMES_DESKTOP_USER_DATA_DIR: '/custom' })
})

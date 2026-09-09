const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const repoRoot = path.resolve(root, '../..')

async function preflight() {
  return import(require('node:url').pathToFileURL(path.join(root, 'scripts', 'launch-preflight.mjs')).href)
}

const cleanEnv = {
  APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
  PATH: 'C:\\Windows;C:\\Users\\Test\\AppData\\Roaming\\npm'
}

const seeEverything = () => true
const seeNothing = () => false

test('a normal console reports that the install directories are visible', async () => {
  const { describeLaunchEnvironment, formatLaunchReport } = await preflight()

  const description = describeLaunchEnvironment({ env: cleanEnv, exists: seeEverything })

  assert.deepEqual(description.markers, [])
  assert.equal(description.restricted, false)
  assert.equal(description.degraded, false)
  assert.deepEqual(formatLaunchReport(description), ['[Zero3] 启动环境正常：本机 CLI 安装目录可见。'])
  // PATH membership is reported but never used to decide: the resolver checks
  // the installer locations directly, so a CLI missing from PATH still works.
  assert.deepEqual(description.locations.map(item => item.onPath), [true, false])
})

test('a sandboxed console names each restriction and how to escape it', async () => {
  const { describeLaunchEnvironment, formatLaunchReport } = await preflight()

  const description = describeLaunchEnvironment({
    env: { ...cleanEnv, CODEX_PERMISSION_PROFILE: ':workspace', CODEX_SANDBOX_NETWORK_DISABLED: '1' },
    // The sandbox hides the directories, but the markers alone are conclusive.
    exists: seeNothing
  })

  assert.equal(description.restricted, true)
  assert.deepEqual(description.markers.map(marker => marker.name), [
    'CODEX_SANDBOX_NETWORK_DISABLED',
    'CODEX_PERMISSION_PROFILE'
  ])
  const report = formatLaunchReport(description).join('\n')
  assert.match(report, /本机 CLI 检测会失败/)
  assert.match(report, /CODEX_SANDBOX_NETWORK_DISABLED/)
  assert.match(report, /Start-Zero3\.cmd/)
  // A restricted launch must not also emit the per-directory noise; the cause
  // is the sandbox, and listing its symptoms buries the one actionable line.
  assert.doesNotMatch(report, /提示：未找到/)
})

test('an empty marker variable is not treated as a restriction', async () => {
  const { describeLaunchEnvironment } = await preflight()

  const description = describeLaunchEnvironment({
    env: { ...cleanEnv, CODEX_SESSION_ID: '', CODEX_PERMISSION_PROFILE: '   ' },
    exists: seeEverything
  })

  assert.deepEqual(description.markers, [])
  assert.equal(description.restricted, false)
})

test('an unrestricted console with hidden directories warns without blaming a sandbox', async () => {
  const { describeLaunchEnvironment, formatLaunchReport } = await preflight()

  const description = describeLaunchEnvironment({ env: cleanEnv, exists: seeNothing })

  assert.equal(description.restricted, false)
  assert.equal(description.degraded, true)
  const report = formatLaunchReport(description).join('\n')
  assert.match(report, /未找到 npm 全局目录/)
  assert.match(report, /未找到 WinGet Links/)
  assert.doesNotMatch(report, /受限环境/)
})

test('the launcher escapes a restricted parent instead of inheriting its sandbox', () => {
  const launcher = fs.readFileSync(path.join(repoRoot, 'Start-Zero3.cmd'), 'utf8')

  // Every marker the preflight knows about has to be one the launcher acts on,
  // or Zero3 starts inside a sandbox that the console then merely complains at.
  for (const marker of ['CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_PERMISSION_PROFILE', 'CODEX_SESSION_ID']) {
    assert.match(launcher, new RegExp(`if defined ${marker} goto :restricted`))
  }
  // Explorer is the escape: it starts the script under the desktop shell rather
  // than inside the restricted process tree.
  assert.match(launcher, /explorer\.exe "%~f0"/)
  // And the escape must not be able to loop.
  assert.match(launcher, /if exist "%ZERO3_RELAUNCH_FLAG%" goto :escape_failed/)
  assert.match(launcher, /:clean\r?\ndel "%ZERO3_RELAUNCH_FLAG%"/)
})

test('the launcher stays ASCII so cmd.exe cannot mis-parse its own branches', () => {
  // cmd.exe re-reads a batch file line by line while running it, so multi-byte
  // text after `chcp 65001` corrupts the parse: a Chinese message inside the
  // sandbox branch made control flow jump to the wrong label entirely.
  const launcher = fs.readFileSync(path.join(repoRoot, 'Start-Zero3.cmd'), 'latin1')
  const offending = [...launcher].map((character, index) => ({ character, index }))
    .filter(item => item.character.charCodeAt(0) > 0x7f)

  assert.deepEqual(
    offending.map(item => item.index),
    [],
    `Start-Zero3.cmd must stay ASCII; put localised text in the Node console instead (first byte at ${offending[0]?.index})`
  )
})

test('the console reports the launch environment before it starts building', () => {
  const console_ = fs.readFileSync(path.join(root, 'scripts', 'dev-console.mjs'), 'utf8')

  assert.match(console_, /import \{ reportLaunchEnvironment \} from '\.\/launch-preflight\.mjs'/)
  const reportAt = console_.indexOf('reportLaunchEnvironment()')
  const startAt = console_.indexOf('controller.reload()')
  assert.ok(reportAt > 0 && startAt > reportAt, 'the report must run before the first reload')
})

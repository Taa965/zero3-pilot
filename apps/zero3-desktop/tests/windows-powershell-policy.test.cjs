const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const repoRoot = path.resolve(root, '..', '..')
const desktopRequire = createRequire(path.resolve(repoRoot, 'upstream/hermes-agent/apps/desktop/package.json'))
const ts = desktopRequire('typescript')

const generatorFile = path.join(root, 'scripts/apply-codex-transport.mjs')
const overlayPatchFile = path.join(root, 'scripts/overlay-patch.mjs')
const LAUNCH_ENVIRONMENT_MARKER = 'function zero3CodexLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {'

const loadTransportGenerator = () => import(pathToFileURL(generatorFile).href)
const loadOverlayEngine = () => import(pathToFileURL(overlayPatchFile).href)

// The overlay generator injects a self-contained TypeScript block into the
// Electron main process. Transpile and run that exact block so the Windows
// policy is asserted as behaviour instead of as source spelling.
function runInjectedLaunchEnvironment(source, platform, env = {}) {
  const module = { exports: {} }
  const process = { env: { ...env }, platform }
  // The injected block is one region of the transport overlay; this is the
  // sibling constant it reads, declared just above it in electron/main.ts.
  const runnable = "const ZERO3_CODEX_LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1'\n" + source
  const output = ts.transpileModule(
    runnable + '\nmodule.exports = { zero3CodexLaunchEnvironment, zero3CodexWindowsShellEnvironment }\n',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText
  vm.runInNewContext(output, { module, exports: module.exports, process, console })
  return { exports: module.exports, processEnv: process.env }
}

test('the Codex kernel child inherits the Windows PowerShell process policy', async () => {
  const { zero3CodexLaunchEnvironmentSource } = await loadTransportGenerator()
  const { exports, processEnv } = runInjectedLaunchEnvironment(zero3CodexLaunchEnvironmentSource, 'win32')

  // Electron main is the parent of the kernel, the embedded PowerShell terminal
  // and every capability shell, so the preference is applied to this process too.
  assert.equal(processEnv.PSExecutionPolicyPreference, 'Bypass')

  const launched = exports.zero3CodexLaunchEnvironment({ PATH: 'C:\\Windows' })
  assert.equal(launched.PSExecutionPolicyPreference, 'Bypass')
  assert.equal(launched.NO_PROXY, 'localhost,127.0.0.1,::1')
  assert.equal(launched.no_proxy, 'localhost,127.0.0.1,::1')
  assert.equal(launched.PATH, 'C:\\Windows')

  // The loopback proxy correction keeps its original contract: an explicit
  // NO_PROXY stays the user's own choice.
  const explicitNoProxy = exports.zero3CodexLaunchEnvironment({ NO_PROXY: 'example.test' })
  assert.deepEqual({ ...explicitNoProxy }, { NO_PROXY: 'example.test', PSExecutionPolicyPreference: 'Bypass' })
})

test('a non-Windows host and an explicit operator opt-out keep the environment untouched', async () => {
  const { zero3CodexLaunchEnvironmentSource } = await loadTransportGenerator()

  const posix = runInjectedLaunchEnvironment(zero3CodexLaunchEnvironmentSource, 'darwin')
  assert.equal(posix.processEnv.PSExecutionPolicyPreference, undefined)
  assert.equal(posix.exports.zero3CodexLaunchEnvironment({}).PSExecutionPolicyPreference, undefined)

  const optedOut = runInjectedLaunchEnvironment(zero3CodexLaunchEnvironmentSource, 'win32', {
    ZERO3_KEEP_WINDOWS_POWERSHELL_POLICY: '1'
  })
  assert.equal(optedOut.processEnv.PSExecutionPolicyPreference, undefined)
  // The opt-out is read from the environment the kernel is launched with, which
  // is the operator's own process environment.
  assert.equal(
    optedOut.exports.zero3CodexLaunchEnvironment(optedOut.processEnv).PSExecutionPolicyPreference,
    undefined
  )
})

test('an Electron tree prepared before this fix is repaired in place', async () => {
  const generator = await loadTransportGenerator()
  const { patchOverlaySource } = await loadOverlayEngine()

  const legacyMain = [
    'type Zero3CodexRpcId = number | string',
    '',
    "const ZERO3_CODEX_LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1'",
    '',
    generator.zero3CodexLegacyLaunchEnvironmentSource.trim(),
    '',
    "ipcMain.handle('hermes:api', async (_event, request) => {"
  ].join('\n')

  const patched = patchOverlaySource({
    relativePath: 'electron/main.ts',
    source: legacyMain,
    replacements: [generator.zero3CodexLaunchEnvironmentReplacement()],
    invariants: [{ label: 'Codex kernel launch environment', text: LAUNCH_ENVIRONMENT_MARKER, count: 1 }]
  })

  assert.ok(patched.includes('PSExecutionPolicyPreference'))
  assert.equal(patched.split(LAUNCH_ENVIRONMENT_MARKER).length - 1, 1)
  // The transport itself is already in place, so the migration must not inject
  // a second Codex app-server transport next to the existing one.
  assert.equal(patched.split('class Zero3CodexAppServer').length - 1, 0)

  const replayed = patchOverlaySource({
    relativePath: 'electron/main.ts',
    source: patched,
    replacements: [generator.zero3CodexLaunchEnvironmentReplacement()],
    invariants: [{ label: 'Codex kernel launch environment', text: LAUNCH_ENVIRONMENT_MARKER, count: 1 }]
  })
  assert.equal(replayed, patched)
})

test('the transport generator keeps one shared launch-environment block', async () => {
  const source = fs.readFileSync(generatorFile, 'utf8')
  assert.match(source, /\$\{zero3CodexLaunchEnvironmentSource\}/)
  assert.match(source, /zero3CodexLaunchEnvironmentReplacement\(\)/)
})

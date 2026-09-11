import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { patchOverlaySource } from '../scripts/overlay-patch.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')
const read = relative => fs.readFileSync(path.join(desktopDir, relative), 'utf8')

// The generated tree the Worker Tunnel first shipped against: the Remote Host
// node existed, but without the Worker RPC composite runtime provider.
const LEGACY = [
  'const zero3RemoteNode = new Zero3RemoteNode({',
  "  startThread: params => zero3CodexAppServer.request('thread/start', params),",
  "  startTurn: (params, timeoutMs) => zero3CodexAppServer.request('turn/start', params, timeoutMs),",
  "  readThread: params => zero3CodexAppServer.request('thread/read', params),",
  "  execCommand: (params, timeoutMs) => zero3CodexAppServer.request('command/exec', params, timeoutMs)",
  '})',
  ''
].join('\n')

const UPGRADED_CONSTRUCTOR = [
  'const zero3RemoteNode = new Zero3RemoteNode({',
  "  listSkills: params => zero3CodexAppServer.request('skills/list', params),",
  '}, () => zero3WorkerAdmin())',
  ''
].join('\n')

const UPGRADED =
  UPGRADED_CONSTRUCTOR +
  "app.on('before-quit', () => zero3RemoteNode.stop())\n\napp.whenReady().then(() => {\n  zero3RemoteNode.start()"

const LEGACY_CONSTRUCTOR = LEGACY

const replacements = [
  {
    label: 'Remote Host Runtime composition',
    alreadyAny: [UPGRADED_CONSTRUCTOR, '}, () => zero3WorkerRpcRuntime())'],
    fromAny: [{ from: LEGACY_CONSTRUCTOR, to: UPGRADED_CONSTRUCTOR }, 'app.whenReady().then(() => {'],
    to: UPGRADED
  }
]

const invariants = [
  { label: 'Remote Host Runtime composition point', text: 'const zero3RemoteNode = new Zero3RemoteNode(', count: 1 },
  {
    label: 'Worker RPC runtime provider argument',
    texts: ['}, () => zero3WorkerAdmin())', '}, () => zero3WorkerRpcRuntime())'],
    count: 1
  },
  { label: 'Remote Host ready-boundary start', text: 'zero3RemoteNode.start()', count: 1 },
  { label: 'Remote Host before-quit teardown', text: "app.on('before-quit', () => zero3RemoteNode.stop())", count: 1 }
]

const patch = source => patchOverlaySource({ relativePath: 'electron/main.ts', source, replacements, invariants })

const legacyGeneratedTree = () =>
  `${LEGACY}\napp.on('before-quit', () => zero3RemoteNode.stop())\n\napp.whenReady().then(() => {\n  zero3RemoteNode.start()\n  createWindow()\n})\n`

test('a fresh tree gets the runtime composed before the ready boundary', () => {
  const source = 'app.whenReady().then(() => {\n  createWindow()\n})\n'
  const patched = patch(source)
  assert.equal(patched.split('const zero3RemoteNode = new Zero3RemoteNode(').length - 1, 1)
  assert.ok(patched.includes('}, () => zero3WorkerAdmin())'))
  assert.ok(patched.indexOf('new Zero3RemoteNode(') < patched.indexOf('app.whenReady().then(() => {'))
  assert.ok(patched.includes('  zero3RemoteNode.start()\n  createWindow()'))
})

test('a provider-less generated tree is repaired instead of duplicated', () => {
  const source = legacyGeneratedTree()
  const patched = patch(source)
  assert.ok(!patched.includes('const zero3RemoteNode = new Zero3RemoteNode({\n  startThread:'))
  assert.equal(patched.split('const zero3RemoteNode = new Zero3RemoteNode(').length - 1, 1)
  assert.equal(patched.split('}, () => zero3WorkerAdmin())').length - 1, 1)
  assert.equal(patched.split('zero3RemoteNode.start()').length - 1, 1)
  assert.equal(patched.split("app.on('before-quit', () => zero3RemoteNode.stop())").length - 1, 1)
  assert.ok(patched.includes('  zero3RemoteNode.start()\n  createWindow()'))
})

test('replaying the overlay over its own output changes nothing', () => {
  const once = patch(legacyGeneratedTree())
  assert.equal(patch(once), once)
  const upgraded = once.replace('}, () => zero3WorkerAdmin())', '}, () => zero3WorkerRpcRuntime())')
  assert.equal(patch(upgraded), upgraded)
})

test('the lifecycle overlay upgrades the admin provider to the composite runtime', () => {
  const lifecycleReplacements = [
    {
      label: 'Remote Worker RPC composite runtime provider',
      appliedMarker: '}, () => zero3WorkerRpcRuntime())',
      fromAny: ['}, () => zero3WorkerAdmin())', /}, \(\) => zero3Worker[A-Za-z0-9_$]*\(\)\)/],
      to: '}, () => zero3WorkerRpcRuntime())'
    }
  ]
  const source = patch(legacyGeneratedTree())
  const upgraded = patchOverlaySource({ relativePath: 'electron/main.ts', source, replacements: lifecycleReplacements })
  assert.equal(upgraded.split('}, () => zero3WorkerRpcRuntime())').length - 1, 1)
  assert.equal(
    patchOverlaySource({ relativePath: 'electron/main.ts', source: upgraded, replacements: lifecycleReplacements }),
    upgraded
  )
})

test('a duplicate composition point is refused instead of written out', () => {
  // The constructor is present with a provider this overlay does not know
  // how to upgrade, so the fresh-tree anchor would add a second declaration.
  const source = `${UPGRADED.replace('}, () => zero3WorkerAdmin())', '}, () => zero3WorkerRpcRuntimeV2())')}\n  createWindow()\n})\n`
  assert.throws(() => patch(source), /left 2 copies of Remote Host Runtime composition point/)
})

test('a moved anchor fails closed with an actionable message', () => {
  assert.throws(
    () =>
      patchOverlaySource({
        relativePath: 'electron/main.ts',
        source: 'const main = app.whenReady\n',
        replacements: [{ label: 'Remote Host Runtime composition', from: 'app.whenReady().then(() => {', to: UPGRADED, hint: 'Run the Codex transport overlay first.' }],
        invariants
      }),
    /missing Remote Host Runtime composition\. Run the Codex transport overlay first\./
  )
})

test('an insert-after candidate keeps the renamed composition point intact', () => {
  const source = 'const disposeZero3ExecutionIpc = registerExecutionDesktopIpc(zero3ExecutionRuntime)\nconst next = 1\n'
  const patched = patchOverlaySource({
    relativePath: 'electron/main.ts',
    source,
    replacements: [
      {
        label: 'Agent Lifecycle composition',
        appliedMarker: 'const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(',
        fromAny: [/const [A-Za-z0-9_$]+ = registerExecutionDesktopIpc\(zero3ExecutionRuntime[^\n]*\)\n/],
        to: match => `${match}const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(store)\n`
      }
    ],
    invariants: [{ label: 'Agent Lifecycle composition point', text: 'const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(', count: 1 }]
  })
  assert.ok(patched.startsWith('const disposeZero3ExecutionIpc = registerExecutionDesktopIpc(zero3ExecutionRuntime)\nconst zero3AgentLifecycleRuntime'))
  assert.ok(patched.includes('const zero3AgentLifecycleRuntime = new Zero3AgentLifecycleRuntime(store)\nconst next = 1'))
})

test('the shipped overlays keep the repair candidates and post-condition invariants', () => {
  const remoteHost = read('scripts/apply-remote-host-runtime.mjs')
  assert.ok(remoteHost.includes('patchOverlaySource'), 'Remote Host overlay must use the shared patch engine.')
  assert.ok(remoteHost.includes('LEGACY_REMOTE_NODE_CONSTRUCTOR'), 'Remote Host overlay must repair the provider-less constructor.')
  assert.ok(remoteHost.includes('}, () => zero3WorkerRpcRuntime())'), 'Remote Host overlay must treat the composite runtime as wired.')
  assert.ok(remoteHost.includes('Remote Host Runtime composition point'), 'Remote Host overlay must assert a single composition point.')

  const lifecycle = read('scripts/apply-agent-lifecycle-runtime.mjs')
  assert.ok(lifecycle.includes('patchOverlaySource'), 'Agent Lifecycle overlay must use the shared patch engine.')
  assert.ok(lifecycle.includes('EXECUTION_RUNTIME_COMPOSITION'), 'Agent Lifecycle overlay must match the Execution Runtime composition statement.')
  assert.ok(lifecycle.includes('}, () => zero3WorkerRpcRuntime())'), 'Agent Lifecycle overlay must wire the composite runtime provider.')
  assert.ok(lifecycle.includes('Worker RPC composite runtime definition'), 'Agent Lifecycle overlay must assert a single runtime definition.')
})

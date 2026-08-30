import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pins = JSON.parse(await readFile(new URL('./compatibility-pins.json', import.meta.url), 'utf8'))
const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function assertExactVersion(label, version) {
  assert.equal(typeof version, 'string', `${label} version must be a string`)
  assert.match(version, exactVersion, `${label} must use an exact version without semver ranges or tags`)
  assert.equal(version.includes('latest'), false, `${label} must not use latest`)
}

test('pre-freeze evidence remains audit-only until Session 0 freezes R4A', () => {
  assert.equal(pins.schemaVersion, 'zero3.pilot.acp.compatibility.audit.v1')
  assert.equal(pins.status, 'audit-only')
  assert.equal(pins.auditBranch, 'feat/r4b-acp-executors')
  assert.equal(pins.contractSha, null)
  assert.equal(pins.contractFeedback.freezeRequiredBeforeImplementation, true)
})

test('all ACP runtime and adapter candidates are exact pins', () => {
  assertExactVersion('ACP SDK', pins.protocol.sdk.version)
  assertExactVersion('acpx runtime', pins.runtime.version)
  assertExactVersion('Claude ACP adapter', pins.adapters.claude.version)
  assertExactVersion('Codex ACP adapter', pins.adapters.codexExternal.version)
})

test('external adapters are restricted to exact locally installed executables', () => {
  assert.equal(pins.adapters.claude.launchPolicy, 'exact-local-installed-bin-only')
  assert.equal(pins.adapters.codexExternal.launchPolicy, 'exact-local-installed-bin-only')
})

test('external codex compatibility adapter cannot claim native kernel authority', () => {
  assert.equal(pins.adapters.codexExternal.nativeAgentKernelAuthority, false)
  assert.equal(pins.adapters.codexExternal.role, 'optional-compatibility-external-executor-only')
})

test('current R4A candidate records both previously required producer contract fixes', () => {
  assert.match(pins.contractFeedback.permissionResponseChannel, /^resolved-in-candidate-/)
  assert.match(pins.contractFeedback.unsupportedFailureCode, /^resolved-in-candidate-/)
})

test('required R4B safety constraints remain explicit', () => {
  const required = [
    'no-runtime-latest',
    'no-runtime-semver-range-launch',
    'no-acp-or-acpx-type-leakage',
    'persistent-resume-must-not-fallback-to-new-session',
    'context-loss-must-escalate-to-handoff-gate',
    'permissions-fail-closed',
    'router-policy-outside-r4b',
    'native-codex-authority-unchanged'
  ]
  for (const constraint of required) assert.ok(pins.constraints.includes(constraint), `missing constraint: ${constraint}`)
})

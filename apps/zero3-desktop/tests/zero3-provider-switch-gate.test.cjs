const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')
const { createHash } = require('node:crypto')

const source = fs.readFileSync(path.resolve(__dirname, '../scripts/apply-session-provider-runtime.mjs'), 'utf8')
function slice(from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `missing source markers: ${from}`)
  return source.slice(start, end)
}
const helpers = `
function zero3SessionRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
function zero3SessionText(value, label, max=4096) { const text=typeof value==='string'?value.trim():''; if(!text||text.length>max) throw new Error(label+' is required'); return text }
function zero3SessionOptionalText(value, max=4096) { if(value==null||value==='') return null; if(typeof value!=='string') throw new Error('value must be string'); const text=value.trim(); if(!text||text.length>max) throw new Error('value is too long'); return text }
`
const gateSource = helpers +
  slice('type Zero3SessionSwitchPhase', 'function zero3ProviderHandoff(value: unknown)') +
  slice('function zero3ProviderHandoff(value: unknown)', 'function zero3ProviderHandoffInstructions') +
  '\n;({ zero3AcquireSessionWriter, zero3BeginSessionSwitch, zero3VerifySessionSwitch, zero3FailSessionSwitch, zero3SessionWriterSnapshot })'
let nextId = 0
const api = vm.runInNewContext(stripTypeScriptTypes(gateSource), {
  crypto: { randomUUID: () => `token-${++nextId}`, createHash }, Buffer, Date, JSON, Array, Object, String, Number, Boolean, Error, Map
})

function handoff(source, target) {
  return {
    protocol: 'zero3.session-provider-handoff.v1', logical_session_id: 'session-a', project_id: 'project-a',
    from: { profileId: 'profile-a' }, to: { profileId: 'profile-b' },
    handoff: { generated_at: new Date().toISOString(), source_runtime_generation: source, target_runtime_generation: target }
  }
}
let verifiedHandoff

test('writer gate blocks overlap and waits for the old Turn before verifying handoff', () => {
  const releaseOld = api.zero3AcquireSessionWriter('session-a', 1, 'profile-a', 'project-a', null)
  const begun = api.zero3BeginSessionSwitch({ logicalSessionId: 'session-a', sourceGeneration: 1, sourceProfileId: 'profile-a', targetProfileId: 'profile-b', projectId: 'project-a' })
  assert.equal(begun.phase, 'HANDOFF_PENDING')
  assert.equal(begun.activeWriter, true)
  assert.throws(() => api.zero3VerifySessionSwitch({ logicalSessionId: 'session-a', switchToken: begun.switchToken, handoff: handoff(1, 2) }), /current Turn/)
  assert.throws(() => api.zero3AcquireSessionWriter('session-a', 1, 'profile-a', 'project-a', null), /禁止双写/)
  releaseOld(false)
  assert.equal(api.zero3SessionWriterSnapshot('session-a').activeWriter, false)
  verifiedHandoff = handoff(1, 2)
  const verified = api.zero3VerifySessionSwitch({ logicalSessionId: 'session-a', switchToken: begun.switchToken, handoff: verifiedHandoff })
  assert.equal(verified.phase, 'SWITCHING')
})

test('only the verified target generation/profile can acquire writer authority', () => {
  const h = verifiedHandoff
  assert.ok(h)
  assert.throws(() => api.zero3AcquireSessionWriter('session-a', 1, 'profile-a', 'project-a', null), /尚未取得写权限|generation/)
  assert.throws(() => api.zero3AcquireSessionWriter('session-a', 2, 'profile-c', 'project-a', h), /尚未取得写权限/)
  const tampered = { ...h, runtime_state: { changed: true } }
  assert.throws(() => api.zero3AcquireSessionWriter('session-a', 2, 'profile-b', 'project-a', tampered), /changed after verification/)
  const releaseTarget = api.zero3AcquireSessionWriter('session-a', 2, 'profile-b', 'project-a', h)
  const active = api.zero3SessionWriterSnapshot('session-a')
  assert.equal(active.generation, 2)
  assert.equal(active.profileId, 'profile-b')
  assert.equal(active.phase, 'ACTIVE')
  releaseTarget(false)
  assert.throws(() => api.zero3AcquireSessionWriter('session-a', 1, 'profile-a', 'project-a', null), /generation/)
})

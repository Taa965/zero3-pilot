import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const load = name => JSON.parse(fs.readFileSync(path.join(root, 'schemas', name), 'utf8'))

const event = load('zero3.memory.event.v1.schema.json')
const sync = load('zero3.memory.sync.v1.schema.json')
const manifest = load('zero3.memory.context-manifest.v1.schema.json')

assert.equal(event.properties.schema.const, 'zero3.memory.event.v1')
assert.ok(event.required.includes('event_id'))
assert.ok(event.required.includes('supersedes'))
assert.deepEqual(event.properties.memory.properties.authority.minimum, 0)
assert.deepEqual(event.properties.memory.properties.authority.maximum, 100)
assert.ok(event.properties.event_type.enum.includes('decision.recorded'))
assert.ok(event.properties.event_type.enum.includes('handoff.published'))
assert.ok(event.properties.event_type.enum.includes('memory.revoked'))

assert.equal(sync.oneOf.length, 8)
const hello = sync.$defs.hello
assert.equal(hello.properties.protocol.const, 'zero3.memory.sync.v1')
assert.ok(hello.required.includes('last_sequence'))
assert.ok(sync.$defs.changed.required.includes('sequence'))
assert.ok(sync.$defs.ack.required.includes('sequence'))

assert.equal(manifest.properties.schema.const, 'zero3.memory.context-manifest.v1')
assert.ok(manifest.required.includes('project_sequence'))
assert.ok(manifest.required.includes('native_context_stale_items'))

for (const schema of [event, sync, manifest]) {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
}

console.log('Zero3 Memory Authority V2.1 protocol checks passed')

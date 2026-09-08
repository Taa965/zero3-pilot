import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryAuthorityState, MemoryConflictError } from './authority-core.mjs'

function event(overrides = {}) {
  const id = overrides.event_id ?? crypto.randomUUID()
  return {
    schema: 'zero3.memory.event.v1',
    event_id: id,
    created_at: new Date().toISOString(),
    scope: { project_id: 'project-a', task_id: null, session_id: null, thread_id: null },
    actor: { agent_id: 'codex-1', agent_type: 'codex', device_id: 'desktop' },
    event_type: 'decision.recorded',
    memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-1', authority: 60, confidence: 0.9, expected_entity_version: null },
    source: { type: 'task', ref: 'task-1', hash: null },
    supersedes: [],
    payload: { text: 'use event sourcing' },
    ...overrides
  }
}

test('duplicate event id is idempotent', () => {
  const state = new MemoryAuthorityState()
  const item = event()
  const first = state.append(item)
  const second = state.append(structuredClone(item))
  assert.equal(first.status, 'accepted')
  assert.equal(second.status, 'duplicate')
  assert.equal(first.sequence, second.sequence)
  assert.equal(state.latestSequence, 1)
})

test('entity version conflict is explicit', () => {
  const state = new MemoryAuthorityState()
  state.append(event({ memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-1', authority: 60, expected_entity_version: 0 } }))
  assert.throws(
    () => state.append(event({ memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-1', authority: 60, expected_entity_version: 0 } })),
    error => error instanceof MemoryConflictError && error.code === 'entity_version_conflict'
  )
})

test('lower authority cannot replace current entity', () => {
  const state = new MemoryAuthorityState()
  state.append(event({ memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-1', authority: 85 } }))
  assert.throws(
    () => state.append(event({ memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-1', authority: 60 } })),
    error => error instanceof MemoryConflictError && error.code === 'authority_conflict'
  )
})

test('agent cannot self-assert user authority', () => {
  const state = new MemoryAuthorityState()
  assert.throws(
    () => state.append(event({ memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-user', authority: 100 } })),
    error => error instanceof MemoryConflictError && error.code === 'user_authority_boundary'
  )
})

test('events replay in monotonic sequence order', () => {
  const state = new MemoryAuthorityState()
  const a = event({ memory: { class: 'project', entity_type: 'decision', entity_id: 'a', authority: 60 } })
  const b = event({ memory: { class: 'project', entity_type: 'decision', entity_id: 'b', authority: 60 } })
  state.append(a)
  state.append(b)
  const events = state.listEventsAfter(0)
  assert.deepEqual(events.map(item => item.sequence), [1, 2])
  assert.deepEqual(state.listEventsAfter(1).map(item => item.event.event_id), [b.event_id])
})

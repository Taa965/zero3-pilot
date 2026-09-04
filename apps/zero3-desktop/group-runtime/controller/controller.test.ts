import assert from 'node:assert/strict'
import test from 'node:test'

import { observeDevelopmentGroup, proposeControllerAction, reduceGroupEvents } from './index.ts'
import type { DevelopmentGroupDefinition, DevelopmentGroupRuntimeState, DevelopmentSessionDefinition, DevelopmentSessionRuntime } from '../contracts/index.ts'

const definition = { groupId: 'G1', policy: { maxSessionAttempts: 2 } } as DevelopmentGroupDefinition
const session = { groupId: 'G1', sessionId: 'S1', executionId: 'E1', dependencies: [] } as unknown as DevelopmentSessionDefinition
const state: DevelopmentGroupRuntimeState = { groupId: 'G1', status: 'running', lastEventSequence: 0, unresolvedBlockers: [], outcomeUnknownCount: 0, repairWaveCount: 0, updatedAt: '2026-09-03T00:00:00.000Z' }

function runtime(status: DevelopmentSessionRuntime['status']): DevelopmentSessionRuntime {
  return { groupId: 'G1', sessionId: 'S1', executionId: 'E1', status, attempt: 1, writerGeneration: 1, lastEventSequence: 0, updatedAt: state.updatedAt }
}

test('monitor makes OutcomeUnknown and ledger lag blocking rather than retryable', () => {
  const signals = observeDevelopmentGroup({ definition, state, sessions: [session], observations: [{ runtime: runtime('outcome_unknown') }], events: [{ eventId: '1', sequence: 1, at: state.updatedAt, groupId: 'G1', type: 'group.created' }] })
  assert.ok(signals.some(signal => signal.kind === 'outcome_unknown'))
  assert.ok(signals.some(signal => signal.kind === 'ledger_replay_required'))
  assert.equal(proposeControllerAction(signals).action, 'wait_human')
})

test('Session waiting_input is projected to a human gate without changing frozen Session states', () => {
  const signals = observeDevelopmentGroup({ definition, state, sessions: [session], observations: [{ runtime: runtime('waiting_input') }], events: [] })
  assert.ok(signals.some(signal => signal.kind === 'waiting_human'))
  assert.equal(proposeControllerAction(signals).action, 'wait_human')
})

test('group event reducer replays only missing monotonic events', () => {
  const reduced = reduceGroupEvents(state, [
    { eventId: '1', sequence: 1, at: '2026-09-03T00:00:01.000Z', groupId: 'G1', type: 'integration.started' },
    { eventId: '2', sequence: 2, at: '2026-09-03T00:00:02.000Z', groupId: 'G1', type: 'integration.merged' }
  ])
  assert.equal(reduced.status, 'verifying')
  assert.equal(reduced.lastEventSequence, 2)
})

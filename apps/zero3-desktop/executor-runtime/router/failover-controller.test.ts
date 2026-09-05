import assert from 'node:assert/strict'
import test from 'node:test'
import { createExecutorFailure } from '../failure-normalizer.ts'
import { Zero3FailoverController, type FailoverConfig } from './failover-controller.ts'

const base: FailoverConfig = {
  candidates: ['native', 'claude', 'api'], automaticFailover: true, maxRetries: 2,
  providerCooldownMs: 1000, circuitFailureThreshold: 3, circuitOpenMs: 5000,
  switchOnAuthRequired: false, returnToPrimaryAfterStage: true
}
const controller = (config: Partial<FailoverConfig> = {}) => new Zero3FailoverController({ ...base, ...config }, 'native', 1)

test('quota exhaustion immediately plans next executor without mutating generation before verified handoff', () => {
  const c = controller()
  const action = c.onFailure('e1', createExecutorFailure('quota_exhausted', 'quota', 'native'), 0)
  assert.deepEqual(action, { type: 'switch', fromExecutorId: 'native', toExecutorId: 'claude', targetGeneration: 2, reason: 'quota_exhausted' })
  assert.deepEqual(c.current(), { executorId: 'native', generation: 1 })
  c.commitVerifiedSwitch('e1', 2)
  assert.deepEqual(c.current(), { executorId: 'claude', generation: 2 })
})

test('rate limit uses bounded retry then switch', () => {
  const c = controller()
  assert.equal(c.onFailure('r1', createExecutorFailure('rate_limited', 'rate', 'native'), 0).type, 'retry')
  assert.equal(c.onFailure('r2', createExecutorFailure('rate_limited', 'rate', 'native'), 1).type, 'retry')
  assert.equal(c.onFailure('r3', createExecutorFailure('rate_limited', 'rate', 'native'), 2).type, 'switch')
})

test('duplicate failure event is idempotent and cannot consume retry budget twice', () => {
  const c = controller()
  const first = c.onFailure('same', createExecutorFailure('provider_error', 'x', 'native'), 0)
  const second = c.onFailure('same', createExecutorFailure('provider_error', 'x', 'native'), 99)
  assert.deepEqual(second, first)
  assert.deepEqual(c.onFailure('next', createExecutorFailure('provider_error', 'x', 'native'), 100), { type: 'retry', executorId: 'native', attempt: 2, maxAttempts: 2 })
})

test('permission policy budget bad-request and user stop never switch', () => {
  for (const code of ['permission_denied', 'policy_denied', 'budget_exhausted', 'bad_request', 'user_stopped'] as const) {
    const action = controller().onFailure(`e-${code}`, createExecutorFailure(code, code, 'native'), 0)
    assert.equal(action.type, 'none')
  }
})

test('transport loss and process crash recover first then require handoff if recovery fails', () => {
  for (const code of ['transport_lost', 'process_crash'] as const) {
    const c = controller()
    assert.equal(c.onFailure(`e-${code}`, createExecutorFailure(code, code, 'native'), 0).type, 'recover')
    const handoff = c.onRecoveryFailed(`e-${code}`, code)
    assert.deepEqual(handoff, { type: 'handoff', fromExecutorId: 'native', targetGeneration: 2, reason: code })
  }
})

test('context loss and context exhaustion require handoff rather than blind provider switch', () => {
  for (const code of ['context_lost', 'context_exhausted'] as const) {
    assert.equal(controller().onFailure(code, createExecutorFailure(code, code, 'native'), 0).type, 'handoff')
  }
})

test('auth required requests login unless explicit Zero3-owned policy allows switch', () => {
  assert.equal(controller().onFailure('auth', createExecutorFailure('auth_required', 'auth', 'native'), 0).type, 'request_auth')
  assert.equal(controller({ switchOnAuthRequired: true }).onFailure('auth2', createExecutorFailure('auth_required', 'auth', 'native'), 0).type, 'switch')
})

test('automatic failover can be disabled without disabling manual override', () => {
  const c = controller({ automaticFailover: false })
  assert.equal(c.onFailure('q', createExecutorFailure('quota_exhausted', 'q', 'native'), 0).type, 'none')
  assert.equal(c.manualSwitch('manual', 'api').type, 'switch')
})

test('pending switch prevents recursive failover loop until commit or abort', () => {
  const c = controller()
  assert.equal(c.onFailure('q1', createExecutorFailure('quota_exhausted', 'q', 'native'), 0).type, 'switch')
  assert.deepEqual(c.onFailure('q2', createExecutorFailure('quota_exhausted', 'q', 'native'), 1), { type: 'none', reason: 'switch already pending handoff verification' })
  c.abortSwitch('q1')
  assert.equal(c.onFailure('q3', createExecutorFailure('quota_exhausted', 'q', 'native'), 2).type, 'switch')
})

test('verified switch generation must exactly match pending target', () => {
  const c = controller()
  c.onFailure('q', createExecutorFailure('quota_exhausted', 'q', 'native'), 0)
  assert.throws(() => c.commitVerifiedSwitch('q', 3), /generation/)
  assert.deepEqual(c.current(), { executorId: 'native', generation: 1 })
})

test('return-to-primary occurs only on a stage boundary and is handoff-gated', () => {
  const c = controller()
  c.manualSwitch('m1', 'claude')
  c.commitVerifiedSwitch('m1', 2)
  const action = c.stageBoundary('stage', 100)
  assert.deepEqual(action, { type: 'switch', fromExecutorId: 'claude', toExecutorId: 'native', targetGeneration: 3, reason: 'return_to_primary' })
})

test('snapshot restore preserves current generation retry state idempotency and pending switch', () => {
  const c = controller()
  c.onFailure('r1', createExecutorFailure('rate_limited', 'rate', 'native'), 0)
  c.onFailure('q1', createExecutorFailure('quota_exhausted', 'q', 'native'), 1)
  const restored = Zero3FailoverController.restore(base, c.snapshot())
  assert.deepEqual(restored.current(), c.current())
  assert.equal(restored.onFailure('q1', createExecutorFailure('quota_exhausted', 'q', 'native'), 2).type, 'switch')
  assert.deepEqual(restored.manualSwitch('m', 'api'), { type: 'none', reason: 'switch already pending handoff verification' })
})

test('provider failure source mismatch cannot drive switching', () => {
  const c = controller()
  assert.equal(c.onFailure('spoof', createExecutorFailure('quota_exhausted', 'q', 'claude'), 0).type, 'none')
})

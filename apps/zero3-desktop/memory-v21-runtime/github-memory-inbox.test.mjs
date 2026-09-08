import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import {
  GithubMemoryInboxError,
  InMemoryGithubReceiptStore,
  assertSecretFree,
  ingestGithubDelivery,
  parseInboxPath,
  validateGithubIngress,
  verifyGithubSignature
} from './github-memory-inbox.mjs'

const eventId = '11111111-1111-4111-8111-111111111111'
function event(overrides = {}) {
  return {
    schema: 'zero3.memory.event.v1', event_id: eventId, created_at: '2026-09-08T03:00:00Z',
    scope: { project_id: 'project-a', task_id: 'task-a', session_id: null, thread_id: null },
    actor: { agent_id: 'gpt-web', agent_type: 'gpt_web', device_id: null }, event_type: 'decision.recorded',
    memory: { class: 'project', entity_type: 'decision', entity_id: 'decision-1', authority: 60, confidence: 0.9 },
    source: { type: 'github_inbox', ref: 'chatgpt-web', hash: null }, supersedes: [], payload: { text: 'AWS is authority' },
    ...overrides
  }
}

function input(overrides = {}) {
  return {
    deliveryId: 'delivery-1', repo: 'Taa965/zero3-memory-inbox', branch: 'main',
    path: `events/project-a/2026/09/${eventId}.json`, event: event(),
    allowedRepo: 'Taa965/zero3-memory-inbox', commitSha: 'abc123', ...overrides
  }
}

test('path parser binds project and event id', () => {
  assert.deepEqual(parseInboxPath(`events/project-a/2026/09/${eventId}.json`), { project_id: 'project-a', year: '2026', month: '09', event_id: eventId })
  assert.throws(() => parseInboxPath('../secret.json'), error => error instanceof GithubMemoryInboxError && error.code === 'invalid_inbox_path')
})

test('webhook signature uses constant-time digest comparison', () => {
  const body = Buffer.from('{"hello":"world"}')
  const secret = 'test-secret'
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  assert.equal(verifyGithubSignature(body, signature, secret), true)
  assert.equal(verifyGithubSignature(body, 'sha256=deadbeef', secret), false)
})

test('ingress rejects repo, project, personal and authority escalation', () => {
  assert.throws(() => validateGithubIngress(input({ repo: 'other/repo' })), error => error.code === 'repo_denied')
  assert.throws(() => validateGithubIngress(input({ event: event({ scope: { project_id: 'project-b' } }) })), error => error.code === 'project_mismatch')
  assert.throws(() => validateGithubIngress(input({ event: event({ memory: { class: 'personal', entity_type: 'preference', entity_id: 'p', authority: 20 } }) })), error => error.code === 'personal_denied')
  assert.throws(() => validateGithubIngress(input({ event: event({ memory: { class: 'project', entity_type: 'decision', entity_id: 'd', authority: 100 } }) })), error => error.code === 'authority_denied')
})

test('secret scanner blocks credentials before GitHub/shared ingress', () => {
  assert.throws(() => assertSecretFree({ api_key: 'not-even-needed' }), error => error.code === 'secret_detected')
  assert.throws(() => assertSecretFree({ note: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }), error => error.code === 'secret_detected')
  assert.doesNotThrow(() => assertSecretFree({ note: 'ordinary project decision' }))
})

test('GitHub webhook redelivery is idempotent before authority append', async () => {
  const receipts = new InMemoryGithubReceiptStore()
  let appends = 0
  const appendEvent = async () => ({ sequence: ++appends })
  const first = await ingestGithubDelivery(input(), { receipts, appendEvent })
  const second = await ingestGithubDelivery(input(), { receipts, appendEvent })
  assert.equal(first.status, 'ingested')
  assert.equal(second.status, 'duplicate_delivery')
  assert.equal(appends, 1)
  assert.equal(second.sequence, 1)
})

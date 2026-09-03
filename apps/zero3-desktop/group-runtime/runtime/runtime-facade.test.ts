import assert from 'node:assert/strict'
import test from 'node:test'

import type { DevelopmentSessionRuntime, VerificationRun } from '../contracts/index.ts'
import type { DevelopmentGroupStore } from '../store/index.ts'
import { markSessionVerified } from './session-lifecycle.ts'

class MemorySessionStore {
  constructor(public runtime: DevelopmentSessionRuntime) {}
  async loadSession() { return { ...this.runtime } }
  async writeSession(runtime: DevelopmentSessionRuntime) { this.runtime = { ...runtime } }
}

test('final Group verification may promote an earlier integrated Session to the final integration SHA', async () => {
  const store = new MemorySessionStore({
    groupId: 'G1', sessionId: 'S1', executionId: 'E1', status: 'integrated', attempt: 1,
    writerGeneration: 1, lastEventSequence: 1, headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    updatedAt: '2026-09-03T00:00:00.000Z'
  } as DevelopmentSessionRuntime)
  const run = {
    verificationRunId: 'V1', groupId: 'G1', integrationSha: 'cccccccccccccccccccccccccccccccccccccccc',
    policyRevision: 'v1', commands: [], results: [], environment: {}, startedAt: '2026-09-03T00:00:00.000Z', status: 'passed'
  } as VerificationRun
  const result = await markSessionVerified(store as unknown as DevelopmentGroupStore, 'G1', 'S1', run)
  assert.equal(result.status, 'verified')
  assert.equal(result.headSha, run.integrationSha)
})

test('non-passed Verification Run cannot promote an integrated Session', async () => {
  const store = new MemorySessionStore({
    groupId: 'G1', sessionId: 'S1', executionId: 'E1', status: 'integrated', attempt: 1,
    writerGeneration: 1, lastEventSequence: 1, updatedAt: '2026-09-03T00:00:00.000Z'
  } as DevelopmentSessionRuntime)
  const run = {
    verificationRunId: 'V2', groupId: 'G1', integrationSha: 'cccccccccccccccccccccccccccccccccccccccc',
    policyRevision: 'v1', commands: [], results: [], environment: {}, startedAt: '2026-09-03T00:00:00.000Z', status: 'failed'
  } as VerificationRun
  await assert.rejects(markSessionVerified(store as unknown as DevelopmentGroupStore, 'G1', 'S1', run), /non-passed/)
})

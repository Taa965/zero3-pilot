import assert from 'node:assert/strict'
import test from 'node:test'

import type { DevelopmentDelivery, DevelopmentSessionDefinition, DevelopmentWave, IntegrationMilestone } from '../contracts/index.ts'
import { IntegrationController, IntegrationQueue, type DeliveryVerifierPort, type IntegrationGitPort } from './index.ts'

const delivery = { groupId: 'G1', sessionId: 'S1', executionId: 'E1', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', deliveryHash: 'D1' } as DevelopmentDelivery
const session = { groupId: 'G1', sessionId: 'S1', executionId: 'E1', waveId: 'W1', branch: 'parallel/s1', dependencies: [] } as DevelopmentSessionDefinition
const waves: DevelopmentWave[] = [{ groupId: 'G1', waveId: 'W1', ordinal: 1, sessionIds: ['S1'], requiredSessionIds: ['S1'], dependsOnWaveIds: [] }]

class FakeGit implements IntegrationGitPort {
  branch = 'integration/development-group-v1'
  head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  clean = true
  conflict = false
  resets: string[] = []
  async currentBranch() { return this.branch }
  async currentHead() { return this.head }
  async branchHead() { return delivery.headSha }
  async statusClean() { return this.clean }
  async merge() { if (this.conflict) return { status: 'conflict' as const, headSha: this.head, detail: 'conflict' }; this.head = 'cccccccccccccccccccccccccccccccccccccccc'; return { status: 'merged' as const, headSha: this.head } }
  async resetTo(sha: string) { this.resets.push(sha); this.head = sha }
}
class MemoryStore { records: IntegrationMilestone[] = []; async writeIntegration(record: IntegrationMilestone) { this.records.push(record) } }
const accept: DeliveryVerifierPort = { async verify() { return { decision: 'DELIVERY_ACCEPT', reasons: [], observed: { changedPaths: [], dirty: false } } } }

test('integration revalidates and records a merged Delivery without worker self-merge', async () => {
  const queue = new IntegrationQueue(); queue.enqueue(session, delivery, waves)
  const store = new MemoryStore(); const git = new FakeGit()
  const controller = new IntegrationController(queue, git, accept, store, { integrationRef: git.branch })
  const result = await controller.integrateNext()
  assert.equal(result?.status, 'merged')
  assert.deepEqual(result?.mergedSessionIds, ['S1'])
  assert.equal(queue.snapshot().length, 0)
})

test('merge conflict abort path records conflict and never marks session integrated', async () => {
  const queue = new IntegrationQueue(); queue.enqueue(session, delivery, waves)
  const store = new MemoryStore(); const git = new FakeGit(); git.conflict = true
  const controller = new IntegrationController(queue, git, accept, store, { integrationRef: git.branch })
  const result = await controller.integrateNext()
  assert.equal(result?.status, 'conflict')
  assert.equal(controller.integratedSessionIds.size, 0)
  assert.equal(queue.snapshot().length, 1)
})

test('failed post-merge check rolls integration workspace back to exact prior SHA', async () => {
  const queue = new IntegrationQueue(); queue.enqueue(session, delivery, waves)
  const store = new MemoryStore(); const git = new FakeGit(); const before = git.head
  const controller = new IntegrationController(queue, git, accept, store, { integrationRef: git.branch, postMergeCheck: async () => ({ ok: false, detail: 'static guard' }) })
  const result = await controller.integrateNext()
  assert.equal(result?.status, 'failed')
  assert.deepEqual(git.resets, [before])
  assert.equal(git.head, before)
})

test('Delivery rejection fails before Git merge', async () => {
  const queue = new IntegrationQueue(); queue.enqueue(session, delivery, waves)
  const git = new FakeGit(); const before = git.head
  const controller = new IntegrationController(queue, git, { async verify() { return { decision: 'DELIVERY_REJECT', reasons: ['ownership'], observed: { changedPaths: [], dirty: false } } } }, new MemoryStore(), { integrationRef: git.branch })
  const result = await controller.integrateNext()
  assert.equal(result?.status, 'failed')
  assert.equal(git.head, before)
})

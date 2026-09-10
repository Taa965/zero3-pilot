import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Zero3WorkerProtocol } from './worker-protocol.mjs'

function seed(protocol, count = 100) {
  protocol.ensureStage({ taskId: 'task-1', stepId: 'images', assignmentId: 'asg-1', requiredCapability: 'image_generation' })
  protocol.addWorkUnits({
    taskId: 'task-1', stepId: 'images',
    units: Array.from({ length: count }, (_, index) => ({
      unitId: `U${String(index + 1).padStart(3, '0')}`, ordinal: index + 1,
      title: `Image ${index + 1}`, payload: { prompt: `prompt-${index + 1}` }
    }))
  })
}
function register(protocol, index = 1, maxBatchSize = 10) {
  return protocol.registerWorker({
    taskId: 'task-1', stepId: 'images', assignmentId: 'asg-1', workerType: 'chatgpt_web',
    capabilities: ['image_generation'], maxBatchSize, logicalSessionId: `gpt-${index}`, idempotencyKey: `register-${index}`
  })
}
function claim(protocol, worker, key, extras = {}) {
  return protocol.claimWork({ ...worker, idempotencyKey: key, ...extras })
}

test('100 image units run as ten atomic batches of ten', () => {
  const protocol = new Zero3WorkerProtocol(':memory:')
  try {
    seed(protocol, 100)
    const worker = register(protocol)
    let result = claim(protocol, worker, 'claim-1')
    let batches = 0
    while (result.state === 'CLAIMED') {
      const current = result.claim ?? result.nextClaim
      batches += 1
      const completion = {
        ...worker, claimId: current.claimId,
        completedUnits: current.units.map(unit => ({ unitId: unit.unitId, artifactRefs: [`chatgpt://asset/${unit.unitId}`] })),
        failedUnits: [], idempotencyKey: `complete-${batches}`
      }
      result = protocol.completeAndClaimNext(completion)
      if (result.state === 'CLAIMED') result = { state: 'CLAIMED', claim: result.nextClaim }
    }
    assert.equal(batches, 10)
    assert.equal(result.state, 'STAGE_WORK_COMPLETE')
    const snapshot = protocol.stageSnapshot('task-1', 'images')
    assert.equal(snapshot.progress.completed, 100)
    assert.equal(snapshot.progress.total, 100)
    assert.equal(snapshot.claims.length, 10)
    assert.equal(snapshot.stage.status, 'WORK_COMPLETE')
    assert.equal(snapshot.units.find(unit => unit.unitId === 'U001').artifactRefs[0], 'chatgpt://asset/U001')
  } finally { protocol.close() }
})

test('five web GPT workers claim disjoint work without duplicate units', () => {
  const protocol = new Zero3WorkerProtocol(':memory:')
  try {
    seed(protocol, 100)
    const workers = Array.from({ length: 5 }, (_, index) => register(protocol, index + 1))
    const claims = workers.map((worker, index) => claim(protocol, worker, `claim-${index + 1}`).claim)
    const firstWave = claims.flatMap(value => value.units.map(unit => unit.unitId))
    assert.equal(firstWave.length, 50)
    assert.equal(new Set(firstWave).size, 50)
    assert.deepEqual(firstWave, Array.from({ length: 50 }, (_, index) => `U${String(index + 1).padStart(3, '0')}`))
  } finally { protocol.close() }
})

test('expired lease releases units so another GPT session can recover them', () => {
  const protocol = new Zero3WorkerProtocol(':memory:', { defaultLeaseSeconds: 10 })
  try {
    seed(protocol, 20)
    const first = register(protocol, 1)
    const original = claim(protocol, first, 'claim-first').claim
    assert.deepEqual(original.units.map(unit => unit.unitId), Array.from({ length: 10 }, (_, i) => `U${String(i + 1).padStart(3, '0')}`))
    const expired = protocol.expireLeases({ taskId: 'task-1', stepId: 'images', at: '2999-01-01T00:00:00.000Z' })
    assert.deepEqual(expired.expiredClaimIds, [original.claimId])
    const second = register(protocol, 2)
    const recovered = claim(protocol, second, 'claim-second').claim
    assert.deepEqual(recovered.units.map(unit => unit.unitId), original.units.map(unit => unit.unitId))
    assert.equal(protocol.stageSnapshot('task-1', 'images').claims[0].status, 'EXPIRED')
  } finally { protocol.close() }
})

test('partial failure requeues retryable units and complete-and-claim-next stays idempotent', () => {
  const protocol = new Zero3WorkerProtocol(':memory:')
  try {
    seed(protocol, 20)
    const worker = register(protocol)
    const first = claim(protocol, worker, 'claim-first').claim
    const input = {
      ...worker, claimId: first.claimId,
      completedUnits: first.units.slice(0, 8).map(unit => unit.unitId),
      failedUnits: first.units.slice(8).map(unit => ({ unitId: unit.unitId, reason: 'generation_failed', retryable: true })),
      idempotencyKey: 'finish-first'
    }
    const result = protocol.completeAndClaimNext(input)
    const replay = protocol.completeAndClaimNext(input)
    assert.deepEqual(replay, result)
    assert.equal(result.state, 'CLAIMED')
    assert.equal(result.previousClaim.status, 'PARTIAL')
    assert.deepEqual(result.nextClaim.units.slice(0, 2).map(unit => unit.unitId), ['U009', 'U010'])
    assert.throws(() => protocol.completeAndClaimNext({ ...input, failedUnits: [], idempotencyKey: 'finish-first' }), /idempotency key was reused/)
  } finally { protocol.close() }
})

test('worker state survives database reopen with the active claim intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-worker-'))
  const db = join(dir, 'worker.sqlite3')
  try {
    let protocol = new Zero3WorkerProtocol(db)
    seed(protocol, 12)
    const worker = register(protocol)
    const first = claim(protocol, worker, 'claim-first').claim
    protocol.close()
    protocol = new Zero3WorkerProtocol(db)
    const context = protocol.getTaskContext(worker)
    assert.equal(context.activeClaim.claimId, first.claimId)
    assert.deepEqual(context.activeClaim.units.map(unit => unit.unitId), first.units.map(unit => unit.unitId))
    protocol.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

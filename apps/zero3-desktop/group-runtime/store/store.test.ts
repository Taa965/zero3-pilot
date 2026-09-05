import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ZERO3_DEVELOPMENT_GROUP_CONTRACT, type DevelopmentGroupDefinition, type DevelopmentGroupRuntimeState } from '../contracts/index.ts'
import { DevelopmentGroupStore, DurableStoreCorruptionError, readDurableJson, writeDurableJson } from './index.ts'

async function withTemp(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'zero3-dg-store-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const definition: DevelopmentGroupDefinition = {
  contract: ZERO3_DEVELOPMENT_GROUP_CONTRACT,
  groupId: 'G1',
  repository: 'owner/repo',
  masterGoal: 'goal',
  masterPrompt: 'prompt',
  developmentPlan: 'plan',
  planHash: 'hash',
  baselineSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  integrationRef: 'integration/development-group-v1',
  requirementIds: [],
  waveIds: [],
  sessionIds: [],
  policy: {
    maxParallelSessions: 4,
    maxSessionAttempts: 3,
    maxRepairSessions: 3,
    maxRepairWaves: 3,
    maxSameFailureAttempts: 2,
    maxSessionSubagents: 4,
    permissionProfile: 'standard',
    completionMode: 'strict',
    verificationPolicyRevision: 'v1',
    targetBranch: 'integration/development-group-v1',
    protectedPaths: [],
    mandatoryTests: []
  },
  createdAt: '2026-09-03T00:00:00.000Z'
}
const state: DevelopmentGroupRuntimeState = {
  groupId: 'G1', status: 'ready', lastEventSequence: 0, unresolvedBlockers: [], outcomeUnknownCount: 0, repairWaveCount: 0, updatedAt: '2026-09-03T00:00:00.000Z'
}

test('durable JSON rejects tampering instead of returning corrupted state', async () => {
  await withTemp(async dir => {
    const path = join(dir, 'record.json')
    await writeDurableJson(path, { value: 1 })
    const raw = await readFile(path, 'utf8')
    await writeFile(path, raw.replace('"value":1', '"value":2'), 'utf8')
    await assert.rejects(readDurableJson(path), DurableStoreCorruptionError)
  })
})

test('event ledger is monotonic and duplicate event ids are idempotent only for identical content', async () => {
  await withTemp(async dir => {
    const store = new DevelopmentGroupStore(dir)
    await store.initialize(definition, state, [])
    const event = { eventId: 'E1', sequence: 1, at: '2026-09-03T00:00:00.000Z', groupId: 'G1', type: 'group.created' as const }
    assert.equal(await store.appendEvent(event), 'appended')
    assert.equal(await store.appendEvent(event), 'duplicate')
    await assert.rejects(store.appendEvent({ ...event, detail: 'different' }), DurableStoreCorruptionError)
    await assert.rejects(store.appendEvent({ eventId: 'E2', sequence: 3, at: event.at, groupId: 'G1', type: 'plan.frozen' }), DurableStoreCorruptionError)
  })
})

test('reconcile reports semantic replay when the ledger is ahead of state without lying about status', async () => {
  await withTemp(async dir => {
    const store = new DevelopmentGroupStore(dir)
    await store.initialize(definition, state, [])
    await store.appendEvent({ eventId: 'E1', sequence: 1, at: '2026-09-03T00:00:00.000Z', groupId: 'G1', type: 'group.created' })
    const result = await store.reconcile('G1')
    assert.equal(result.needsSemanticReplay, true)
    assert.equal((await store.loadState('G1')).status, 'ready')
  })
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Zero3RoutingMetricsStore } from './routing-metrics-store'

async function tempRoot(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `zero3-routing-metrics-${label}-`))
}

test('routing metrics record outcomes and derive per executor/task-class statistics', async () => {
  const root = await tempRoot('stats')
  const store = new Zero3RoutingMetricsStore(root)
  const latencies = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000]
  for (const [index, latencyMs] of latencies.entries()) {
    await store.recordOutcome({
      executorId: 'CLAUDE',
      taskClass: 'IMPLEMENT',
      succeeded: index !== 9,
      verificationPassed: index !== 9 ? true : false,
      latencyMs,
      costUsd: 0.1
    })
  }
  const snapshot = await store.snapshot()
  const stats = snapshot.executors['CLAUDE']?.['IMPLEMENT']
  assert.ok(stats)
  assert.equal(stats.attempts, 10)
  assert.equal(stats.successes, 9)
  assert.equal(stats.failures, 1)
  assert.equal(stats.verificationPasses, 9)
  assert.equal(stats.verificationFailures, 1)
  assert.ok(Math.abs(stats.successRate - 0.9) < 1e-9)
  assert.ok(Math.abs(stats.verificationPassRate - 0.9) < 1e-9)
  assert.equal(stats.p50LatencyMs, 5000)
  assert.equal(stats.p95LatencyMs, 10_000)
  assert.ok(Math.abs(stats.totalCostUsd - 1) < 1e-9, `totalCostUsd should be 1, got ${stats.totalCostUsd}`)
})

test('routing metrics persist across store instances', async () => {
  const root = await tempRoot('persist')
  const first = new Zero3RoutingMetricsStore(root)
  await first.recordOutcome({ executorId: 'CODEX', taskClass: 'FIX', succeeded: true, latencyMs: 1200 })

  const second = new Zero3RoutingMetricsStore(root)
  const snapshot = await second.snapshot()
  const stats = snapshot.executors['CODEX']?.['FIX']
  assert.ok(stats)
  assert.equal(stats.attempts, 1)
  assert.equal(stats.successes, 1)
  assert.equal(stats.avgLatencyMs, 1200)
})

test('routing metrics cap the sample window per executor/task-class key', async () => {
  const root = await tempRoot('cap')
  const store = new Zero3RoutingMetricsStore(root, { maxSamplesPerKey: 10 })
  for (let index = 0; index < 15; index += 1) {
    await store.recordOutcome({ executorId: 'GEMINI', taskClass: 'DESIGN', succeeded: true, latencyMs: index + 1 })
  }
  const snapshot = await store.snapshot()
  const stats = snapshot.executors['GEMINI']?.['DESIGN']
  assert.ok(stats)
  assert.equal(stats.attempts, 10)
  assert.equal(stats.p50LatencyMs, 10)
  assert.equal(stats.p95LatencyMs, 15)
})

test('routing metrics keep executor keys independent and tolerate unknown lookups', async () => {
  const root = await tempRoot('independent')
  const store = new Zero3RoutingMetricsStore(root)
  await store.recordOutcome({ executorId: 'CODEX', taskClass: 'IMPLEMENT', succeeded: true })
  await store.recordOutcome({ executorId: 'CLAUDE', taskClass: 'IMPLEMENT', succeeded: false })

  const snapshot = await store.snapshot()
  assert.equal(snapshot.executors['CODEX']?.['IMPLEMENT']?.successes, 1)
  assert.equal(snapshot.executors['CLAUDE']?.['IMPLEMENT']?.failures, 1)
  assert.equal(snapshot.executors['ZERO3_API']?.['IMPLEMENT'], undefined)
})

test('routing metrics require executor and task class identifiers', async () => {
  const root = await tempRoot('validate')
  const store = new Zero3RoutingMetricsStore(root)
  await assert.rejects(
    () => store.recordOutcome({ executorId: '', taskClass: 'IMPLEMENT', succeeded: true }),
    /executorId and taskClass are required/
  )
})

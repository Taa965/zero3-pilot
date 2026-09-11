import assert from 'node:assert/strict'
import test from 'node:test'

import { Zero3WorkerWakeupController, type GptWebWakeupPort, type WorkerWakeupRuntimePort } from './worker-wakeup.ts'

function wakeup(attemptCount = 0) {
  return {
    wakeupId: 'wake-1', workflowRunId: 'run-1', workerDefinitionId: 'visual-planner',
    workerSlotId: 'visual-worker-01', workerSessionId: 'gptws-1', logicalSessionId: 'gpt-entry-1',
    queueGeneration: 1, attemptCount, message: '继续执行当前工位任务。'
  }
}

function runtimePort(item = wakeup()) {
  const events: string[] = []
  const runtime: WorkerWakeupRuntimePort = {
    pendingWakeups: () => [item],
    markWakeupDelivered: id => events.push(`delivered:${id}`),
    deferWakeup: (id, reason) => events.push(`deferred:${id}:${reason}`),
    suppressWakeup: (id, reason) => events.push(`suppressed:${id}:${reason}`),
    requireRotationForWakeup: (id, reason) => events.push(`rotate:${id}:${reason}`)
  }
  return { runtime, events }
}

function gptPort(status: Awaited<ReturnType<GptWebWakeupPort['executionStatus']>>, failSend = false) {
  const sent: string[] = []
  const gpt: GptWebWakeupPort = {
    executionStatus: async () => status,
    sendWakeup: async (entryId, message) => {
      sent.push(`${entryId}:${message}`)
      if (failSend) throw new Error('composer not ready')
      return { sent: true }
    }
  }
  return { gpt, sent }
}

test('P5 idle GPT session receives exactly one wakeup and is marked delivered', async () => {
  const { runtime, events } = runtimePort()
  const { gpt, sent } = gptPort({ executing: false, health: null })
  const controller = new Zero3WorkerWakeupController(runtime, gpt)
  await controller.tick()
  assert.deepEqual(sent, ['gpt-entry-1:继续执行当前工位任务。'])
  assert.deepEqual(events, ['delivered:wake-1'])
})

test('P5 active GPT turn is deferred instead of receiving duplicate wakeup', async () => {
  const { runtime, events } = runtimePort()
  const { gpt, sent } = gptPort({ executing: true, health: 'active' })
  const controller = new Zero3WorkerWakeupController(runtime, gpt)
  await controller.tick()
  assert.equal(sent.length, 0)
  assert.match(events[0], /^deferred:wake-1:/)
})

test('P5 repeatedly stalled GPT session is fenced into physical-session rotation', async () => {
  const { runtime, events } = runtimePort(wakeup(3))
  const { gpt, sent } = gptPort({ executing: true, health: 'stalled' })
  const controller = new Zero3WorkerWakeupController(runtime, gpt, { stalledAttemptsBeforeRotate: 3 })
  await controller.tick()
  assert.equal(sent.length, 0)
  assert.match(events[0], /^rotate:wake-1:/)
})

test('P5 page/composer readiness failures are deferred and never treated as delivered', async () => {
  const { runtime, events } = runtimePort()
  const { gpt, sent } = gptPort({ executing: false, health: null }, true)
  const controller = new Zero3WorkerWakeupController(runtime, gpt)
  await controller.tick()
  assert.equal(sent.length, 1)
  assert.match(events[0], /^deferred:wake-1:/)
  assert.equal(events.some(value => value.startsWith('delivered:')), false)
})

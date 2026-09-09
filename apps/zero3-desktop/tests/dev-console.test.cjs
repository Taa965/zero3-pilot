const { test } = require('node:test')
const assert = require('node:assert/strict')

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('R waits for shutdown and collapses repeated keys while stopping', async () => {
  const { ReloadController } = await import('../scripts/dev-console.mjs')
  const stopping = deferred()
  const calls = []
  let serial = 0
  const controller = new ReloadController({
    start: async () => { calls.push('start'); return ++serial },
    stop: async id => { calls.push(`stop ${id}`); await stopping.promise }
  })
  await controller.reload()
  const transition = controller.reload()
  controller.reload()
  controller.reload()
  assert.deepEqual(calls, ['start', 'stop 1'])
  stopping.resolve()
  await transition
  assert.equal(controller.current, 2)
  assert.deepEqual(calls, ['start', 'stop 1', 'start'])
  await controller.quit()
})

test('Q during startup waits and closes the newly started child without restarting it', async () => {
  const { ReloadController } = await import('../scripts/dev-console.mjs')
  const starting = deferred()
  const stopped = []
  const controller = new ReloadController({ start: () => starting.promise, stop: async child => stopped.push(child) })
  controller.reload()
  controller.reload()
  const quit = controller.quit()
  starting.resolve('owned-child')
  await quit
  await controller.reload()
  assert.deepEqual(stopped, ['owned-child'])
  assert.equal(controller.current, null)
})

test('failed startup can retry, but failed shutdown never starts a duplicate', async () => {
  const { ReloadController } = await import('../scripts/dev-console.mjs')
  const errors = []
  let starts = 0
  const controller = new ReloadController({
    start: async () => { if (++starts === 1) throw new Error('build failed'); return 'child' },
    stop: async () => { throw new Error('stop failed') },
    onError: error => errors.push(error.message)
  })
  await controller.reload()
  await controller.reload()
  await controller.reload()
  assert.equal(starts, 2)
  assert.equal(controller.current, 'child')
  assert.deepEqual(errors, ['build failed', 'stop failed'])
})

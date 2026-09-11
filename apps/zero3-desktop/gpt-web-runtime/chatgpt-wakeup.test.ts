import assert from 'node:assert/strict'
import test from 'node:test'

import { sendChatGptWakeup } from './chatgpt-wakeup.ts'

function contents(options: { url?: string; destroyed?: boolean; result?: unknown } = {}) {
  const scripts: string[] = []
  return {
    scripts,
    value: {
      isDestroyed: () => options.destroyed === true,
      getURL: () => options.url ?? 'https://chatgpt.com/c/test',
      executeJavaScript: async (script: string) => {
        scripts.push(script)
        return options.result ?? true
      }
    }
  }
}

test('P5 ChatGPT wakeup sends only through the composer/send controls', async () => {
  const fake = contents()
  const result = await sendChatGptWakeup(fake.value as never, '继续执行当前工位任务。')
  assert.deepEqual(result, { sent: true })
  assert.equal(fake.scripts.length, 1)
  assert.match(fake.scripts[0], /prompt-textarea/)
  assert.match(fake.scripts[0], /send-button/)
  assert.match(fake.scripts[0], /继续执行当前工位任务/)
})

test('P5 wakeup refuses non-ChatGPT pages and destroyed views', async () => {
  await assert.rejects(
    sendChatGptWakeup(contents({ url: 'https://example.com/' }).value as never, 'continue'),
    /requires a live chatgpt.com page/
  )
  await assert.rejects(
    sendChatGptWakeup(contents({ destroyed: true }).value as never, 'continue'),
    /view is destroyed/
  )
})

test('P5 wakeup does not claim delivery when composer/send controls are unavailable', async () => {
  const fake = contents({ result: false })
  await assert.rejects(sendChatGptWakeup(fake.value as never, 'continue'), /composer\/send control is not ready/)
})

test('P5 wakeup bounds fixed internal messages', async () => {
  await assert.rejects(sendChatGptWakeup(contents().value as never, ' '.repeat(4)), /1\.\.2048/)
  await assert.rejects(sendChatGptWakeup(contents().value as never, 'x'.repeat(2049)), /1\.\.2048/)
})

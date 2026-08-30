import assert from 'node:assert/strict'
import test from 'node:test'

import { applyProviderOverride, normalizeProviderOverride } from './native-provider-seam.mjs'

test('provider seam keeps app-server request params and adds explicit model/provider overrides', () => {
  assert.deepEqual(
    applyProviderOverride(
      { threadId: 'thr_1', approvalPolicy: 'on-request' },
      { modelProvider: 'openai', model: 'gpt-5.6-codex' }
    ),
    {
      threadId: 'thr_1',
      approvalPolicy: 'on-request',
      modelProvider: 'openai',
      model: 'gpt-5.6-codex'
    }
  )
})

test('provider seam does not create a provider override when none was requested', () => {
  assert.deepEqual(normalizeProviderOverride({}), {})
})

test('provider seam rejects shell-like provider identifiers', () => {
  assert.throws(() => normalizeProviderOverride({ modelProvider: 'openai; rm -rf /' }), /unsupported/)
})

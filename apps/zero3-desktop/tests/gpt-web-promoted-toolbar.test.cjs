const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

test('promoted GPT controls are gated by the live preload bridge', () => {
  const surface = read('ui-v2/conversations/GptWebSurface.tsx')
  assert.match(surface, /typeof window\.zero3GptWeb\.toolbarAction === 'function'/)
  assert.match(surface, /promotedToolbarAvailable &&/)
  assert.match(surface, /typeof invoke !== 'function'/)
})

test('GPT provider reapplies native header suppression whenever a view is shown', () => {
  const provider = read('gpt-web-runtime/gpt-web-provider.ts')
  assert.match(provider, /await this\.applyHeaderSuppression\(live\)/)
  assert.match(provider, /did-stop-loading[\s\S]*void this\.applyHeaderSuppression\(live\)/)
})

test('generated Electron bridge upgrades old prepared trees with toolbar actions', () => {
  const overlay = read('scripts/apply-gpt-web-provider.mjs')
  assert.match(overlay, /zero3:gpt-web:toolbar-action/)
  assert.match(overlay, /toolbarAction: request => ipcRenderer\.invoke/)
  assert.match(overlay, /GPT Web promoted toolbar preload method/)
  assert.match(overlay, /already: "  toolbarAction: request => ipcRenderer\.invoke/)
})

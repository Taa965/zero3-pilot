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

test('conversation header suppression leaves attachment preview controls visible', () => {
  const provider = read('gpt-web-runtime/gpt-web-provider.ts')
  assert.ok(provider.includes('#page-header:has([data-testid="share-chat-button"], [data-testid="conversation-options-button"])'))
  assert.ok(!provider.includes('const CHATGPT_HEADER_CSS = `#page-header{'))
  assert.match(provider, /Attachment\/library[\s\S]*download\/close toolbar/)
})

test('promoted sidebar action releases Zero3 chrome suppression and follows current ChatGPT controls', () => {
  const provider = read('gpt-web-runtime/gpt-web-provider.ts')
  assert.match(provider, /button\[aria-label="打开侧边栏"\]/)
  assert.match(provider, /button\[aria-label="Open sidebar"\]/)
  assert.match(provider, /stage-slideover-sidebar/)
  assert.match(provider, /stage-popover-sidebar/)
  assert.match(provider, /action === 'sidebar' && live\.chromeHidden[\s\S]*setChromeVisible\(id, true\)/)
  assert.match(provider, /element\.getClientRects\(\)\.length === 0/)
})

test('generated Electron bridge upgrades old prepared trees with toolbar actions', () => {
  const overlay = read('scripts/apply-gpt-web-provider.mjs')
  assert.match(overlay, /zero3:gpt-web:toolbar-action/)
  assert.match(overlay, /toolbarAction: request => ipcRenderer\.invoke/)
  assert.match(overlay, /GPT Web promoted toolbar preload method/)
  assert.match(overlay, /already: "  toolbarAction: request => ipcRenderer\.invoke/)
})

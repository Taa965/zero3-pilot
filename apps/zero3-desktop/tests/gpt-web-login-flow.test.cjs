const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

test('signed-out project discovery opens a same-profile ChatGPT login window', () => {
  const provider = read('gpt-web-runtime/gpt-web-provider.ts')
  assert.match(provider, /error instanceof ChatGptSignedOutError/)
  assert.match(provider, /await this\.openLoginWindow\(parent\)/)
  assert.match(provider, /new BrowserWindow\(\{[\s\S]*session: profile/)
  assert.match(provider, /CHATGPT_LOGIN_STATUS_SCRIPT/)
})

test('catalog reports signed-out state distinctly from endpoint failures', () => {
  const catalog = read('gpt-web-runtime/chatgpt-project-catalog.ts')
  assert.match(catalog, /class ChatGptSignedOutError extends Error/)
  assert.match(catalog, /payload\.reason === 'signed-out'/)
})

test('project-list IPC supplies the invoking Zero3 window as login parent', () => {
  const overlay = read('scripts/apply-gpt-web-provider.mjs')
  assert.match(
    overlay,
    /list-remote-projects', event => zero3GptWeb\.listRemoteProjects\(zero3GptWebParent\(event\)\)/
  )
  assert.match(overlay, /GPT Web authenticated project-list parent window/)
})

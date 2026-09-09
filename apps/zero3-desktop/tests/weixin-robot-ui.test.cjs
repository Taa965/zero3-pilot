const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('runtime center exposes a real Weixin robot management target', () => {
  const list = read('ui-v2/runtime/RuntimeList.tsx')
  const workspace = read('ui-v2/runtime/WeixinRobotWorkspace.tsx')

  assert.match(list, /机器人 \(Robots\)/)
  assert.match(list, /onTargetChange\('weixin'\)/)
  assert.match(list, /微信机器人/)
  assert.match(workspace, /zero3Robots/)
  assert.match(workspace, /绑定微信/)
  assert.match(workspace, /重新绑定微信/)
  assert.match(workspace, /解除绑定/)
  assert.match(workspace, /authorization_configured/)
})

test('renderer can only invoke fixed Weixin robot operations', () => {
  const bridge = read('scripts/apply-weixin-robot-runtime.mjs')
  const runtime = read('robot-runtime/weixin-robot-runtime.ts')

  assert.match(bridge, /zero3:robots:weixin-status/)
  assert.match(bridge, /zero3:robots:weixin-bind/)
  assert.match(bridge, /zero3:robots:weixin-disconnect/)
  assert.match(runtime, /runWeixinCommand\(command: 'status' \| 'disconnect'\)/)
  assert.match(runtime, /Start-Process -FilePath \$env:ZERO3_WEIXIN_LAUNCH_EXE/)
  assert.match(runtime, /-ArgumentList 'login'/)
  assert.match(runtime, /ZERO3_WEIXIN_LAUNCH_CWD/)
  assert.doesNotMatch(runtime, /request\.command|request\.args|shell:\s*true/)
  assert.doesNotMatch(runtime, /ComSpec|cmd\.exe|\['\/d', '\/s', '\/c'/)
  assert.doesNotMatch(runtime, /ZERO3_PILOT_NODE_URL|api\/v1\/jobs/)
})

test('desktop build and Windows package carry the Weixin binary', () => {
  const run = read('scripts/run.mjs')
  const pack = read('scripts/prepare-windows-package.mjs')
  const prepare = read('scripts/prepare-gemini-integration.mjs')

  assert.match(run, /ensureZero3WeixinBinary/)
  assert.match(run, /'build', '-p', 'zero3-weixin'/)
  assert.match(run, /ZERO3_WEIXIN_BIN: weixinBinary/)
  assert.match(pack, /zero3-weixin.*zero3-pilot-weixin\.exe/s)
  assert.match(prepare, /applyZero3WeixinRobotRuntime\(\)/)
})

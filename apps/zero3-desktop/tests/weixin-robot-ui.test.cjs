const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('runtime center exposes real Weixin and QQ robot targets', () => {
  const list = read('ui-v2/runtime/RuntimeList.tsx')
  const workspace = read('ui-v2/runtime/RobotChannelWorkspace.tsx')
  const router = read('ui-v2/runtime/RuntimeWorkspace.tsx')

  assert.match(list, /机器人 \(Robots\)/)
  assert.match(list, /onTargetChange\('weixin'\)/)
  assert.match(list, /onTargetChange\('qq'\)/)
  assert.match(list, /微信机器人/)
  assert.match(list, /QQ 机器人/)
  assert.match(router, /QqRobotWorkspace/)
  assert.match(workspace, /消息服务/)
  assert.match(workspace, /Zero3 API Profile/)
})

test('renderer only receives fixed robot operations', () => {
  const bridge = read('scripts/apply-weixin-robot-runtime.mjs')
  const runtime = read('robot-runtime/weixin-robot-runtime.ts')

  for (const name of [
    'weixin-status', 'weixin-bind', 'weixin-disconnect', 'weixin-start', 'weixin-stop',
    'qq-status', 'qq-bind', 'qq-disconnect', 'qq-start', 'qq-stop', 'settings', 'settings-set'
  ]) assert.match(bridge, new RegExp(`zero3:robots:${name}`))

  assert.match(runtime, /listen\(0, '127\.0\.0\.1'/)
  assert.match(runtime, /timingSafeEqual/)
  assert.match(runtime, /ZERO3_ROBOT_GATEWAY_TOKEN/)
  assert.match(runtime, /child\.once\('error'/)
  assert.match(runtime, /service_error: serviceErrors\[channel\]/)
  assert.doesNotMatch(runtime, /request\.command|request\.args|shell:\s*true/)
  assert.doesNotMatch(runtime, /ComSpec|cmd\.exe|\['\/d', '\/s', '\/c'/)
})

test('robot default Zero3 path is read-only and elevated agents require channel approval', () => {
  const runtime = read('robot-runtime/weixin-robot-runtime.ts')
  const overlay = read('scripts/apply-weixin-robot-runtime.mjs')

  assert.match(runtime, /defaultBackend: 'zero3'/)
  assert.match(runtime, /body\.approved !== true/)
  assert.match(runtime, /approvalRequired = true/)
  assert.match(runtime, /routeZero3/)
  assert.match(overlay, /sandbox: 'read-only'/)
  assert.match(overlay, /zero3ApiAgentBridge\.register/)
  assert.match(overlay, /zero3ApiAgentRunTurn/)
})

test('desktop build carries Weixin binary and QQ transport bridge', () => {
  const run = read('scripts/run.mjs')
  const pack = read('scripts/prepare-windows-package.mjs')
  const prepare = read('scripts/prepare-gemini-integration.mjs')
  const qq = read('robot-runtime/qqbot_bridge.py')

  assert.match(run, /ensureZero3WeixinBinary/)
  assert.match(run, /ZERO3_QQBOT_BRIDGE/)
  assert.match(run, /'\.\[web\]'/)
  assert.match(pack, /zero3-robots/)
  assert.match(pack, /qqbot_bridge\.py/)
  assert.match(prepare, /applyZero3WeixinRobotRuntime\(\)/)
  assert.match(qq, /from gateway\.platforms\.qqbot import QQAdapter, qr_register/)
  assert.match(qq, /dm_policy.*allowlist/s)
  assert.match(qq, /group_policy.*open/s)
  assert.match(qq, /user_id != owner_user_id/)
  assert.match(qq, /parse_command\("你好"\).*"zero3"/s)
})

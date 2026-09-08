const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
const surface = fs.readFileSync(path.join(root, 'ui-v2', 'conversations', 'LocalConversationSurface.tsx'), 'utf8')
const picker = fs.readFileSync(path.join(root, 'ui-v2', 'conversations', 'SessionProviderPickerDialog.tsx'), 'utf8')

test('Zero3 API profile turns execute inside the pinned Codex Agent Kernel', () => {
  assert.match(runtime, /return zero3ApiAgentTurn\(profile, request\)/)
  assert.match(runtime, /zero3CodexAppServer\.request\('thread\/start'/)
  assert.match(runtime, /zero3CodexAppServer\.request\('turn\/start'/)
  assert.match(runtime, /model_providers\.' \+ providerId \+ '\.wire_api/)
  assert.match(runtime, /wire_api'\]: 'responses'/)
  assert.doesNotMatch(runtime, /return zero3ApiTurn\(profile, request\.messages\)/)
})

test('Zero3 renderer binds API sessions to project cwd and persistent Codex thread ids', () => {
  assert.match(surface, /cwd: project\.rootPath/)
  assert.match(surface, /projectId: project\.id/)
  assert.match(surface, /threadId: session\.runtimeId/)
  assert.match(runtime, /zero3ProjectId: projectId/)
  assert.match(runtime, /sandbox: 'danger-full-access'/)
  assert.match(surface, /LocalSessionAdapter\.setRuntimeId\(session\.id, result\.threadId\)/)
  assert.match(surface, /provider === 'antigravity' \|\| provider === 'zero3'/)
  assert.match(picker, /Zero3 本体.*Codex Agent Kernel.*requiresProject: true/)
})

test('provider picker removes the redundant selected-provider status panel', () => {
  assert.doesNotMatch(picker, /刷新状态/)
  assert.doesNotMatch(picker, /正在读取真实运行时状态/)
  assert.doesNotMatch(picker, /mt-4 rounded-lg border border-\(--ui-border\) bg-background\/40 p-4/)
  assert.match(picker, /打开官方 CLI 授权/)
  assert.match(picker, /保存 API 配置/)
})

test('provider cards re-probe runtime status when selected again after CLI login', () => {
  assert.match(picker, /setSelected\(provider\.id\)[\s\S]*void refresh\(\)/)
})

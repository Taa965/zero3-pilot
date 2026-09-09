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

test('provider probes run concurrently and each one is bounded', () => {
  // Sequentially, one stalled CLI held the whole dialog: codex login status has
  // hung for minutes here and agy models is a network call, so the worst case
  // was their sum and the picker simply looked frozen.
  assert.match(runtime, /await Promise\.all\(\[/)
  assert.match(runtime, /zero3ProbeWithDeadline<Zero3CliProbeResult>\(zero3ProbeCodexCli\(\)/)
  assert.match(runtime, /zero3ProbeWithDeadline<Zero3CliProbeResult>\(zero3ClaudeTaskAdapter\.availability\(\)/)
  assert.match(runtime, /zero3ProbeWithDeadline<\{ authenticated: boolean \| null; detail: string \| null \}>\(/)
  assert.match(runtime, /const ZERO3_PROVIDER_PROBE_DEADLINE_MS = 15_000/)
  // The old sequential awaits must be gone, or one of them still blocks.
  assert.doesNotMatch(runtime, /const codexCli = await zero3ProbeCodexCli\(\)/)
  assert.doesNotMatch(runtime, /const claude = await zero3ClaudeTaskAdapter\.availability\(\)/)
})

test('a probe that timed out reports unknown rather than missing', () => {
  // available:false renders as 未安装, which for a working install is the exact
  // wrong answer - and the one that already cost a long debugging detour.
  assert.match(runtime, /available: null,\r?\n\s+authenticated: null,\r?\n\s+detail: '检测超时/)
  assert.match(runtime, /available: boolean \| null/)
  assert.match(picker, /status\.available === null\) return \{ text: '检测超时'/)

  // And an unfinished probe must not be written up as a resolution failure.
  assert.match(runtime, /claude\.available === false \? \['claude'\] : \[\]/)
  assert.match(runtime, /codexAvailable === false \?/)
})

test('the picker re-probes when the window regains focus, one refresh at a time', () => {
  // Signing in happens in a terminal and a browser; the answer changes while
  // this window is in the background.
  assert.match(picker, /window\.addEventListener\('focus', onFocus\)/)
  assert.match(picker, /window\.removeEventListener\('focus', onFocus\)/)
  // Focus fires more often than a person changes windows, and every refresh
  // spawns CLIs.
  assert.match(picker, /const refreshing = useRef\(false\)/)
  assert.match(picker, /if \(refreshing\.current\) return/)
  assert.match(picker, /refreshing\.current = false/)
})

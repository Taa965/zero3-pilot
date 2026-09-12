const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const runtime = fs.readFileSync(path.join(root, 'scripts', 'apply-session-provider-runtime.mjs'), 'utf8')
const surface = fs.readFileSync(path.join(root, 'ui-v2', 'conversations', 'LocalConversationSurface.tsx'), 'utf8')
const nativeSurface = fs.readFileSync(path.join(root, 'ui-v2', 'conversations', 'Zero3NativeConversationSurface.tsx'), 'utf8')
const picker = fs.readFileSync(path.join(root, 'ui-v2', 'conversations', 'SessionProviderPickerDialog.tsx'), 'utf8')

test('Zero3 API profile turns execute inside the pinned Codex Agent Kernel', () => {
  assert.match(runtime, /zero3AcquireSessionWriter\(logicalSessionId, generation, profileId, projectId, handoff\)/)
  assert.match(runtime, /zero3ApiAgentTurn\(profile, \{ \.\.\.request, handoff \}, false/)
  assert.match(runtime, /zero3CodexAppServer\.request\('thread\/start'/)
  assert.match(runtime, /zero3CodexAppServer\.request\('turn\/start'/)
  assert.match(runtime, /model_providers\.' \+ providerId \+ '\.wire_api/)
  assert.match(runtime, /wire_api'\]: 'responses'/)
  assert.doesNotMatch(runtime, /return zero3ApiTurn\(profile, request\.messages\)/)
})

test('Zero3 renderer binds API sessions to project cwd and persistent Codex thread ids', () => {
  assert.match(nativeSurface, /cwd: project\.rootPath/)
  assert.match(nativeSurface, /projectId: project\.id/)
  assert.match(nativeSurface, /threadId: session\.runtimeId/)
  assert.match(nativeSurface, /generation: runtime\.binding\.generation/)
  assert.match(runtime, /zero3ProjectId: projectId/)
  assert.match(runtime, /sandbox: robotSafe \? 'read-only' : 'danger-full-access'/)
  assert.match(runtime, /async function zero3ApiRobotTurn[\s\S]*zero3ApiAgentTurn\(profile, requestValue, true\)/)
  assert.match(nativeSurface, /LocalSessionAdapter\.setRuntimeId\(session\.id, result\.threadId\)/)
  assert.match(nativeSurface, /beginZero3ProviderSwitch/)
  assert.match(picker, /Zero3 本体.*Codex Agent Kernel.*requiresProject: true/)
})

test('provider picker removes the redundant selected-provider status panel', () => {
  assert.doesNotMatch(picker, /刷新状态/)
  assert.doesNotMatch(picker, /正在读取真实运行时状态/)
  assert.doesNotMatch(picker, /mt-4 rounded-lg border border-\(--ui-border\) bg-background\/40 p-4/)
  assert.match(picker, /打开官方 CLI 授权/)
  assert.match(picker, /保存 API 配置/)
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

test('a failed turn is written to disk, not only into a chat bubble', () => {
  // The only record of a failure used to be a string in the conversation, where
  // the UI truncates it - so the one place the cause was written down was the
  // one place it could not be read.
  assert.match(runtime, /const ZERO3_TURN_LOG_FILE = path\.join\(app\.getPath\('userData'\), 'zero3', 'turn-failures\.log'\)/)
  assert.match(runtime, /async function zero3LogTurnFailure/)
  assert.match(runtime, /zero3TurnFailureError\('Claude CLI 执行失败'/)
  assert.match(runtime, /zero3TurnFailureError\('Codex CLI 执行失败'/)

  // Bounded, and never at the cost of the entry being written right now.
  assert.match(runtime, /const ZERO3_TURN_LOG_MAX_BYTES = 1024 \* 1024/)
  assert.match(runtime, /fsp\.rename\(ZERO3_TURN_LOG_FILE, ZERO3_TURN_LOG_FILE \+ '\.old'\)/)

  // The prompt is the user's own conversation: log its size, not its text.
  assert.match(runtime, /promptChars: text\.length/)
  assert.doesNotMatch(runtime, /prompt: text\b/)
})

test('an in-band API failure is reported as a failure, not as Claude answering', () => {
  // claude -p reports an API error inside its JSON and still exits 0. The error
  // text was being handed back as the assistant's reply.
  assert.match(runtime, /if \(parsed\.is_error === true\)/)
  assert.match(runtime, /zero3TurnFailureError\('Claude 拒绝了这次请求'/)
})

test('a turn failure reports what the CLI said, not what it happened to print first', () => {
  // Both CLIs state the cause on stdout as JSON and leave stderr unhelpful:
  // Codex prints a progress line, Claude prints nothing. Preferring stderr threw
  // the answer away and showed "Reading prompt from stdin..." for a model the
  // account is not allowed to use.
  assert.match(runtime, /function zero3CliFailureMessage\(stdout: string\)/)
  assert.match(runtime, /event\.type === 'error' \? event\.message : null/)
  assert.match(runtime, /zero3SessionRecord\(event\.error\)\.message/)
  assert.match(runtime, /event\.is_error === true \? event\.result : null/)

  // Codex wraps the server's words once more as {"detail": "..."}.
  assert.match(runtime, /function zero3UnwrapFailureDetail/)
  assert.match(runtime, /zero3SessionRecord\(JSON\.parse\(text\)\)\.detail/)

  // stdout is consulted first; stderr stays the fallback.
  const summary = runtime.slice(runtime.indexOf('function zero3TurnFailureSummary'))
  const reportedAt = summary.indexOf('zero3CliFailureMessage(stdout)')
  const stderrAt = summary.indexOf('stderr.trim()')
  assert.ok(reportedAt > 0 && stderrAt > reportedAt, 'the streamed failure message must win over stderr')
})

test('runtime resume failure can rotate inside the same logical session using a recovery handoff', () => {
  const nativeSurface = fs.readFileSync(path.join(root, 'ui-v2', 'conversations', 'Zero3NativeConversationSurface.tsx'), 'utf8')
  assert.match(runtime, /const recoveryHandoff = zero3RecoveryHandoff\(request\.recoveryHandoff\)/)
  assert.match(runtime, /recoveryHandoff && request\.allowRuntimeRecovery === true/)
  assert.match(runtime, /Zero3 recovery handoff identity is stale/)
  assert.match(runtime, /developerInstructions: recoveryDeveloperInstructions/)
  assert.match(nativeSurface, /Zero3SessionEventStore\.buildRecoveryHandoff\(session\.id\)/)
  assert.match(nativeSurface, /allowRuntimeRecovery: Boolean\(recoveryHandoff\)/)
})

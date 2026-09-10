const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('session list distinguishes active, idle, stalled, and unread-complete states', () => {
  const list = read('ui-v2/conversations/UnifiedSessionList.tsx')
  assert.match(list, /session\.executionHealth \?\? 'active'/)
  assert.match(list, /data-session-health/)
  assert.match(list, /border-emerald-500/)
  assert.match(list, /border-amber-500/)
  assert.match(list, /border-red-500/)
  assert.match(list, /motion-safe:animate-ping/)
  assert.match(list, /等待进展/)
  assert.match(list, /疑似卡住/)
  assert.match(list, /completionUnread && !executing/)
  assert.match(list, /bg-red-500/)
})

test('local turns still report execution start and completion to the unified shell', () => {
  const surface = read('ui-v2/conversations/LocalConversationSurface.tsx')
  const shell = read('ui-v2/shell/Zero3AppShell.tsx')
  assert.match(surface, /onExecutionChange\(session\.id, true\)/)
  assert.match(surface, /onExecutionChange\(session\.id, false\)/)
  assert.match(shell, /executingLocalSessionIds\.has\(record\.id\)/)
})
test('finished background sessions stay unread until their page is viewed', () => {
  const shell = read('ui-v2/shell/Zero3AppShell.tsx')
  const types = read('ui-v2/conversations/session-types.ts')
  assert.match(types, /completionUnread\?: boolean/)
  assert.match(shell, /SESSION_COMPLETION_UNREAD_STORAGE_KEY/)
  assert.match(shell, /persistCompletionUnreadSessionIds/)
  assert.match(shell, /previous === true && !status\.executing/)
  assert.match(shell, /viewedSessionIdRef\.current !== sessionId/)
  assert.match(shell, /setSessionCompletionUnread\(session\.id, false\)/)
})

test('GPT and Gemini web providers maintain a mutation heartbeat without copying response text', () => {
  const gpt = read('gpt-web-runtime/gpt-web-provider.ts')
  const gemini = read('gemini-web-runtime/gemini-web-provider.ts')
  for (const source of [gpt, gemini]) {
    assert.match(source, /EXECUTION_PROBE_INTERVAL_MS = 800/)
    assert.match(source, /EXECUTION_IDLE_AFTER_MS = 90_000/)
    assert.match(source, /EXECUTION_STALLED_AFTER_MS = 5 \* 60_000/)
    assert.match(source, /__zero3ExecutionWatchdogV1/)
    assert.match(source, /new MutationObserver/)
    assert.match(source, /lastProgressAt/)
    assert.match(source, /health = idleForMs >= EXECUTION_STALLED_AFTER_MS \? 'stalled'/)
  }
})
test('web execution health is carried through the renderer adapter', () => {
  const adapter = read('ui-v2/adapters/WebWorkspaceAdapter.ts')
  const types = read('ui-v2/conversations/session-types.ts')
  const shell = read('ui-v2/shell/Zero3AppShell.tsx')
  assert.match(types, /WorkspaceExecutionHealth = 'active' \| 'idle' \| 'stalled'/)
  assert.match(types, /executionHealth\?: WorkspaceExecutionHealth \| null/)
  assert.match(adapter, /executionHealth: execution\.health/)
  assert.match(adapter, /lastProgressAt: execution\.lastProgressAt/)
  assert.match(adapter, /idleForMs: event\.idleForMs/)
  assert.match(shell, /executionHealth: status\.health/)
  assert.match(shell, /executionIdleForMs: status\.idleForMs/)
})

test('generated preload type overlays expose the richer health contract', () => {
  const gpt = read('scripts/apply-gpt-web-provider.mjs')
  const gemini = read('scripts/apply-gemini-web-provider.mjs')
  for (const source of [gpt, gemini]) {
    assert.match(source, /health: 'active' \| 'idle' \| 'stalled' \| null/)
    assert.match(source, /lastProgressAt: number \| null/)
    assert.match(source, /idleForMs: number/)
  }
})

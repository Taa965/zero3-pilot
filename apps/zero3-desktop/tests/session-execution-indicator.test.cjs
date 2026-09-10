const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('session list distinguishes running ripple from unread completion marker', () => {
  const list = read('ui-v2/conversations/UnifiedSessionList.tsx')
  assert.match(list, /session\.executing === true/)
  assert.match(list, /session\.completionUnread === true/)
  assert.match(list, /attentionRing = executing \|\| completionUnread/)
  assert.match(list, /data-session-executing/)
  assert.match(list, /data-session-completion-unread/)
  assert.match(list, /border-emerald-500/)
  assert.match(list, /motion-safe:animate-ping/)
  assert.match(list, /bg-red-500/)
  assert.match(list, /执行完成，尚未查看/)
})

test('local turns report execution start and completion to the unified shell', () => {
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
  assert.match(shell, /previous === true && !executing/)
  assert.match(shell, /previous && !executing/)
  assert.match(shell, /viewedSessionIdRef\.current !== sessionId/)
  assert.match(shell, /setSessionCompletionUnread\(session\.id, false\)/)
  assert.match(shell, /completionUnread: completionUnreadSessionIds\.has/)
})

test('GPT and Gemini web providers detect visible stop controls and emit execution changes', () => {
  const gpt = read('gpt-web-runtime/gpt-web-provider.ts')
  const gemini = read('gemini-web-runtime/gemini-web-provider.ts')
  for (const source of [gpt, gemini]) {
    assert.match(source, /EXECUTION_PROBE_INTERVAL_MS = 800/)
    assert.match(source, /executionStatus\(idValue: unknown\)/)
    assert.match(source, /kind: 'execution'/)
    assert.match(source, /stop-button/)
  }
})

test('web execution events update status directly while navigation refreshes the list', () => {
  const gptOverlay = read('scripts/apply-gpt-web-provider.mjs')
  const geminiOverlay = read('scripts/apply-gemini-web-provider.mjs')
  const adapter = read('ui-v2/adapters/WebWorkspaceAdapter.ts')
  const shell = read('ui-v2/shell/Zero3AppShell.tsx')
  assert.match(gptOverlay, /zero3:gpt-web:execution-status/)
  assert.match(geminiOverlay, /zero3:gemini-web:execution-status/)
  assert.match(adapter, /bridge\.executionStatus/)
  assert.match(adapter, /onExecutionChange\?\.\(event\.entryId, event\.executing\)/)
  assert.match(adapter, /else if \(event\.kind === 'navigation'\) onChange\(\)/)
  assert.match(shell, /setWebSessions\(current => current\.map/)
})

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('desktop preparation stages the cross-app execution runtime after Development Group authority', () => {
  const prepare = read('scripts/prepare-codex-upstream.mjs')
  const reload = read('scripts/run.mjs')
  assert.match(prepare, /applyDevelopmentGroupBridge\(\)[\s\S]*applyExecutionRuntimeBridge\(\)/)
  assert.match(reload, /applyDevelopmentGroupBridge\(\)[\s\S]*applyExecutionRuntimeBridge\(\)/)
})

test('execution bridge exposes only scoped desktop control while reporter HTTP stays loopback-only', () => {
  const bridge = read('scripts/apply-execution-runtime-bridge.mjs')
  const reporterHttp = read('execution-runtime/reporter-http.ts')
  assert.match(bridge, /zero3Execution/)
  assert.match(bridge, /issueReporterTicket/)
  assert.match(reporterHttp, /127\.0\.0\.1/)
  assert.match(reporterHttp, /execution reporter HTTP server must bind loopback/)
  assert.doesNotMatch(reporterHttp, /0\.0\.0\.0/)
})

test('Windows package carries the purpose-specific DC reporter client', () => {
  const run = read('scripts/run.mjs')
  const packaging = read('scripts/prepare-windows-package.mjs')
  const client = read('execution-runtime/zero3-exec.ps1')
  assert.match(run, /stageZero3ExecutionToolsForWindowsPackage/)
  assert.match(packaging, /zero3-execution-tools/)
  assert.match(client, /zero3\.pilot\.execution-report\.v1/)
  assert.match(client, /Invoke-RestMethod/)
})

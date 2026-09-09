import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// Read-only real stdio acceptance; no LLM requests, credentials, or full context
// in output. The child receives the same cwd and environment as global Codex.
const args = process.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
const config = option('--config'), server = option('--server'), cwd = option('--cwd')
if (![config, server, cwd].every(value => value && path.isAbsolute(value))) throw new Error('--config, --server and --cwd must be absolute paths')
const pending = new Map()
const child = spawn(process.execPath, [server], { cwd, windowsHide: true, env: { ...process.env, ZERO3_SHARED_MEMORY_CONFIG: config, ZERO3_MEMORY_AUTO_PROJECT: '1', ZERO3_PROJECT_CONTEXT_DIR: path.join(os.tmpdir(), 'zero3-mcp-verification-context') }, stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = '', id = 0
child.stderr.on('data', chunk => { stderr += chunk })
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  const reply = JSON.parse(line)
  const item = pending.get(reply.id)
  if (item) { pending.delete(reply.id); clearTimeout(item.timer); reply.error ? item.reject(new Error(JSON.stringify(reply.error))) : item.resolve(reply.result) }
})
child.on('exit', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('MCP exited: ' + stderr.slice(-1000))) } pending.clear() })
const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const request = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)) }, 30000)
  pending.set(requestId, { resolve, reject, timer }); send({ id: requestId, method, params })
})
try {
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'zero3-memory-verification', version: '1.0.0' } })
  send({ method: 'notifications/initialized' })
  const inventory = await request('tools/list', {})
  const names = inventory.tools.map(tool => tool.name)
  for (const name of ['memory_get_scope', 'project_get_context', 'memory_publish_event', 'handoff_get', 'handoff_publish']) assert.ok(names.includes(name), name)
  const scopeReply = await request('tools/call', { name: 'memory_get_scope', arguments: {} })
  assert.ok(!scopeReply.isError, 'scope call failed')
  const scope = scopeReply.structuredContent ?? JSON.parse(scopeReply.content[0].text)
  const contextReply = await request('tools/call', { name: 'project_get_context', arguments: { projectId: scope.projectId } })
  assert.ok(!contextReply.isError, 'context call failed')
  const context = contextReply.structuredContent ?? JSON.parse(contextReply.content[0].text)
  assert.equal(context.projectId, scope.projectId)
  assert.equal(context.sync.stale, false)
  const denied = await request('tools/call', { name: 'project_get_context', arguments: { projectId: scope.projectId + '-other' } })
  assert.equal(denied.isError, true)
  console.log(JSON.stringify({ server: init.serverInfo.name, projectId: scope.projectId, tools: names, contextVersion: context.version, stale: context.sync.stale, scopeIsolation: 'passed' }, null, 2))
} finally {
  child.stdin.end()
  const kill = setTimeout(() => child.kill(), 2000); kill.unref()
  child.once('exit', () => clearTimeout(kill))
  lines.close()
}

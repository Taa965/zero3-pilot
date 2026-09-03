import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ZERO3_EXECUTOR_CONTRACT, ZERO3_HANDOFF_PROTOCOL, type ExecutorEvent } from '../executor-types.ts'
import { AcpContextLostError, AcpExternalExecutor } from './acp-executor.ts'
import { resolveExactLocalAcpAdapter } from './local-adapter.ts'

type Fixture = {
  root: string
  packageRoot: string
  stateDir: string
  logFile: string
  adapter: Awaited<ReturnType<typeof resolveExactLocalAcpAdapter>>
}

const fakeAgentSource = String.raw`
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const scenario = process.env.ZERO3_TEST_SCENARIO || 'normal'
const log = value => { if (process.env.ZERO3_TEST_LOG) appendFileSync(process.env.ZERO3_TEST_LOG, value + '\n') }
let pendingPrompt = null
let pendingSession = null
let idleTimer = null
const armIdleExit = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => process.exit(0), 1000) }
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
for await (const line of rl) {
  armIdleExit()
  const m = JSON.parse(line)
  if (m.id === 'perm-1' && m.result) {
    const outcome = m.result.outcome || {}
    log('permission:' + String(outcome.outcome) + ':' + String(outcome.optionId || ''))
    if (pendingPrompt != null) {
      send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:pendingSession, update:{ sessionUpdate:'tool_call_update', toolCallId:'tool-1', status: outcome.outcome === 'selected' ? 'completed' : 'cancelled' } } })
      if (outcome.outcome === 'selected') {
        send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:pendingSession, update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'done' } } } })
        send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:pendingSession, update:{ sessionUpdate:'usage_update', used:42, size:200, cost:{ amount:0.01, currency:'USD' } } } })
      }
      send({ jsonrpc:'2.0', id:pendingPrompt, result:{ stopReason: outcome.outcome === 'selected' ? 'end_turn' : 'cancelled' } })
      pendingPrompt = null
    }
    continue
  }
  if (m.method === 'session/cancel') {
    log('cancel:' + String(m.params?.sessionId || ''))
    if (pendingPrompt != null) { send({ jsonrpc:'2.0', id:pendingPrompt, result:{ stopReason:'cancelled' } }); pendingPrompt = null }
    continue
  }
  if (m.id == null) continue
  if (m.method === 'initialize') {
    send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion: scenario === 'v2' ? 2 : 1, agentCapabilities:{ loadSession: scenario !== 'no-load' }, agentInfo:{ name:'fake-acp-agent' } } })
    continue
  }
  if (m.method === 'session/new') {
    log('new:' + String(m.params?.cwd || ''))
    send({ jsonrpc:'2.0', id:m.id, result:{ sessionId:'session-1' } })
    continue
  }
  if (m.method === 'session/load') {
    log('load:' + String(m.params?.sessionId || '') + ':' + String(m.params?.cwd || ''))
    if (scenario === 'load-fail') send({ jsonrpc:'2.0', id:m.id, error:{ code:-32000, message:'session context missing' } })
    else send({ jsonrpc:'2.0', id:m.id, result:{} })
    continue
  }
  if (m.method === 'session/prompt') {
    if (scenario === 'crash') process.exit(7)
    if (scenario === 'rate') { send({ jsonrpc:'2.0', id:m.id, error:{ code:429, message:'rate limit reached' } }); continue }
    if (scenario === 'quota') { send({ jsonrpc:'2.0', id:m.id, error:{ code:-32000, message:'quota exhausted' } }); continue }
    if (scenario === 'auth') { send({ jsonrpc:'2.0', id:m.id, error:{ code:401, message:'authentication required' } }); continue }
    pendingPrompt = m.id
    pendingSession = m.params.sessionId
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:pendingSession, update:{ sessionUpdate:'agent_thought_chunk', content:{ type:'text', text:'thinking' } } } })
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:pendingSession, update:{ sessionUpdate:'tool_call', toolCallId:'tool-1', title:'Run tests' } } })
    const options = scenario === 'once-only'
      ? [{ optionId:'allow-once', name:'Allow once', kind:'allow_once' }, { optionId:'reject', name:'Reject', kind:'reject_once' }]
      : [{ optionId:'allow-once', name:'Allow once', kind:'allow_once' }, { optionId:'allow-session', name:'Allow session', kind:'allow_always' }, { optionId:'reject', name:'Reject', kind:'reject_once' }]
    send({ jsonrpc:'2.0', id:'perm-1', method:'session/request_permission', params:{ sessionId:pendingSession, toolCall:{ toolCallId:'tool-1', title:'Run tests', rawInput:{ command:'node test' } }, options } })
    continue
  }
  if (m.method === 'session/close') { send({ jsonrpc:'2.0', id:m.id, result:{} }); continue }
  send({ jsonrpc:'2.0', id:m.id, error:{ code:-32601, message:'method not found' } })
}
`

async function fixture(scenario = 'normal'): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zero3-acp-'))
  const packageRoot = path.join(root, 'node_modules', '@agentclientprotocol', 'claude-agent-acp')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(path.join(packageRoot, 'fake-agent.mjs'), fakeAgentSource)
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@agentclientprotocol/claude-agent-acp', version: '0.70.0', bin: { 'claude-agent-acp': './fake-agent.mjs' }
  }))
  const logFile = path.join(root, 'agent.log')
  const adapter = await resolveExactLocalAcpAdapter({
    packageRoot,
    packageName: '@agentclientprotocol/claude-agent-acp',
    packageVersion: '0.70.0',
    binName: 'claude-agent-acp',
    env: { ZERO3_TEST_SCENARIO: scenario, ZERO3_TEST_LOG: logFile }
  })
  return { root, packageRoot, stateDir: path.join(root, 'state'), logFile, adapter }
}

function executor(f: Fixture, scenarioId = 'claude-acp') {
  return new AcpExternalExecutor({
    id: scenarioId,
    label: 'Claude ACP',
    adapter: f.adapter,
    stateDir: f.stateDir,
    requestTimeoutMs: 2_000,
    now: () => '2026-08-31T00:00:00.000Z'
  })
}

const startContext = (workspace: string) => ({
  contract: ZERO3_EXECUTOR_CONTRACT,
  identity: { taskId:'task-1', executionId:'execution-1', workspace, objective:'test', constraints:[], acceptanceCriteria:[] },
  policy: { permissionProfile:'standard' as const, approvalRequired:true },
  generation: 1
})

async function promptWithDecision(exec: AcpExternalExecutor, session: Awaited<ReturnType<AcpExternalExecutor['start']>>, decision: 'approve_once'|'approve_session'|'deny') {
  const events: ExecutorEvent[] = []
  for await (const event of exec.prompt(session, { kind:'prompt', clientRequestId:'client-1', text:'run tests' })) {
    events.push(event)
    if (event.type === 'permission.requested') await exec.respondPermission(session, { requestId:event.requestId, decision })
  }
  return events
}

test('exact local adapter resolver accepts pinned package and rejects version drift', async () => {
  const f = await fixture()
  try {
    assert.equal(f.adapter.command, process.execPath)
    assert.equal(f.adapter.args[0], path.join(f.packageRoot, 'fake-agent.mjs'))
    await assert.rejects(resolveExactLocalAcpAdapter({ packageRoot:f.packageRoot, packageName:'@agentclientprotocol/claude-agent-acp', packageVersion:'0.71.0', binName:'claude-agent-acp' }), /exact pin/)
  } finally { await rm(f.root, { recursive:true, force:true }) }
})

test('ACP initialize, session/new, updates and approve-once flow normalize into frozen events', async () => {
  const f = await fixture()
  try {
    const exec = executor(f)
    assert.equal((await exec.probe()).status, 'ready')
    const session = await exec.start(startContext(f.root))
    const events = await promptWithDecision(exec, session, 'approve_once')
    assert.equal(events.some(event => event.type === 'reasoning'), true)
    assert.equal(events.some(event => event.type === 'tool.started'), true)
    assert.equal(events.some(event => event.type === 'tool.completed' && event.success), true)
    assert.equal(events.some(event => event.type === 'message' && event.text === 'done'), true)
    assert.equal(events.some(event => event.type === 'usage.updated' && event.usage.costUsd === 0.01), true)
    const completed = events.at(-1)
    assert.equal(completed?.type, 'completed')
    if (completed?.type === 'completed') assert.equal(completed.outcome, 'succeeded')
    assert.match(await readFile(f.logFile, 'utf8'), /permission:selected:allow-once/)
  } finally { await rm(f.root, { recursive:true, force:true }) }
})

test('permission deny returns explicit reject option and ends cancelled', async () => {
  const f = await fixture()
  try {
    const exec = executor(f)
    const session = await exec.start(startContext(f.root))
    const events = await promptWithDecision(exec, session, 'deny')
    assert.match(await readFile(f.logFile, 'utf8'), /permission:selected:reject/)
    const completed = events.at(-1)
    assert.equal(completed?.type, 'completed')
    if (completed?.type === 'completed') assert.equal(completed.outcome, 'cancelled')
  } finally { await rm(f.root, { recursive:true, force:true }) }
})

test('approve-session fails closed when adapter offers only allow-once', async () => {
  const f = await fixture('once-only')
  try {
    const exec = executor(f)
    const session = await exec.start(startContext(f.root))
    const iterator = exec.prompt(session, { kind:'prompt', clientRequestId:'client-2', text:'run' })[Symbol.asyncIterator]()
    let permission
    for (let i = 0; i < 4; i += 1) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === 'permission.requested') { permission = next.value; break }
    }
    assert.ok(permission && permission.type === 'permission.requested')
    await assert.rejects(exec.respondPermission(session, { requestId:permission.requestId, decision:'approve_session' }), /refusing implicit approval/)
    await exec.cancel(session)
    while (!(await iterator.next()).done) {}
    const log = await readFile(f.logFile, 'utf8')
    assert.equal(log.includes('allow-session'), false)
  } finally { await rm(f.root, { recursive:true, force:true }) }
})

test('resume after executor restart uses durable session/load and never session/new fallback', async () => {
  const f = await fixture()
  try {
    const first = executor(f)
    const session = await first.start(startContext(f.root))
    const second = executor(f)
    const resumed = await second.resume(
      { executorId:'claude-acp', sessionId:session.sessionId, generation:1 },
      { protocol:ZERO3_HANDOFF_PROTOCOL, checkpointHash:'a'.repeat(64), generation:1, workspaceFingerprint:'b'.repeat(64) }
    )
    assert.equal(resumed.sessionId, session.sessionId)
    const log = await readFile(f.logFile, 'utf8')
    assert.equal(log.split('\n').filter(line => line.startsWith('new:')).length, 1)
    assert.equal(log.split('\n').filter(line => line.startsWith('load:')).length, 1)
  } finally { await rm(f.root, { recursive:true, force:true }) }
})

test('missing loadSession capability becomes context_lost without replacement session', async () => {
  const normal = await fixture()
  try {
    const first = executor(normal)
    const session = await first.start(startContext(normal.root))
    const noLoadAdapter = await resolveExactLocalAcpAdapter({
      packageRoot:normal.packageRoot, packageName:'@agentclientprotocol/claude-agent-acp', packageVersion:'0.70.0', binName:'claude-agent-acp',
      env:{ ZERO3_TEST_SCENARIO:'no-load', ZERO3_TEST_LOG:normal.logFile }
    })
    const second = new AcpExternalExecutor({ id:'claude-acp', label:'Claude ACP', adapter:noLoadAdapter, stateDir:normal.stateDir, requestTimeoutMs:2_000 })
    await assert.rejects(second.resume(
      { executorId:'claude-acp', sessionId:session.sessionId, generation:1 },
      { protocol:ZERO3_HANDOFF_PROTOCOL, checkpointHash:'a'.repeat(64), generation:1, workspaceFingerprint:'b'.repeat(64) }
    ), error => error instanceof AcpContextLostError && error.failure.code === 'context_lost')
    const log = await readFile(normal.logFile, 'utf8')
    assert.equal(log.split('\n').filter(line => line.startsWith('new:')).length, 1)
  } finally { await rm(normal.root, { recursive:true, force:true }) }
})

test('adapter process crash maps to process_crash and terminal failure', async () => {
  const f = await fixture('crash')
  try {
    const exec = executor(f)
    const session = await exec.start(startContext(f.root))
    const events: ExecutorEvent[] = []
    for await (const event of exec.prompt(session, { kind:'prompt', clientRequestId:'crash-1', text:'crash' })) events.push(event)
    const failure = events.find(event => event.type === 'failure')
    assert.ok(failure && failure.type === 'failure')
    if (failure?.type === 'failure') assert.equal(failure.failure.code, 'process_crash')
    assert.equal(events.at(-1)?.type, 'completed')
  } finally { await rm(f.root, { recursive:true, force:true }) }
})

test('quota, rate-limit and auth JSON-RPC failures normalize to frozen taxonomy', async () => {
  for (const [scenario, code] of [['quota','quota_exhausted'],['rate','rate_limited'],['auth','auth_required']] as const) {
    const f = await fixture(scenario)
    try {
      const exec = executor(f)
      const session = await exec.start(startContext(f.root))
      const events: ExecutorEvent[] = []
      for await (const event of exec.prompt(session, { kind:'prompt', clientRequestId:scenario, text:scenario })) events.push(event)
      const failure = events.find(event => event.type === 'failure')
      assert.ok(failure && failure.type === 'failure')
      if (failure?.type === 'failure') {
        assert.equal(failure.failure.code, code)
        assert.equal(failure.failure.source, 'claude-acp')
      }
    } finally { await rm(f.root, { recursive:true, force:true }) }
  }
})

test('protocol version mismatch is unsupported and never creates a session', async () => {
  const f = await fixture('v2')
  try {
    const exec = executor(f)
    assert.equal((await exec.probe()).status, 'unsupported')
    await assert.rejects(exec.start(startContext(f.root)), /ACP v1|protocol/)
  } finally { await rm(f.root, { recursive:true, force:true }) }
})

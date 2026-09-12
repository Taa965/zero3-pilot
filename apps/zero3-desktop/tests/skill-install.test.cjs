const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const deps = createRequire(process.env.ZERO3_TEST_NODE_MODULES
  ? path.join(process.env.ZERO3_TEST_NODE_MODULES, '..', 'package.json')
  : path.resolve(root, '../../upstream/hermes-agent/apps/desktop/package.json'))
const ts = deps('typescript')
function evaluate(source, globals = {}, overrides = {}) {
  const exports = {}
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(js, { exports, require: name => overrides[name] ?? deps(name), Error, console, setTimeout, Buffer, ...globals })
  return exports
}
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const controllerSource = read('ui-v2/skills/SkillInstallController.ts')
function stubInstallJobStore(calls = []) {
  return class {
    constructor() {}
    async list() { return [] }
    async record(job) { calls.push(['record', job]); return job }
    async update(threadId, patch) { calls.push(['update', threadId, patch]); return { threadId, ...patch } }
    async recoverInterrupted() { calls.push(['recover']); return [] }
    async remove(threadId) { calls.push(['remove', threadId]); return true }
  }
}
function fixture(pendingState = null) {
  let receive = () => {}
  let resolve
  const calls = []
  const dismissCalls = []
  const bridge = {
    onEvent: listener => { receive = listener; return () => { receive = () => {} } },
    skills: {
      install: request => { calls.push(['install', request]); return new Promise(done => { resolve = done }) },
      list: async request => { calls.push(['list', request]); return { data: [] } },
      pending: async () => typeof pendingState === 'function' ? pendingState() : (pendingState ?? { activeJob: null, recoverableJobs: [], approvals: [] }),
      dismissInstallJob: async request => { dismissCalls.push(['dismiss', request]); return { removed: true } }
    },
    turn: { interrupt: async request => { calls.push(['interrupt', request]) } },
    respondToServerRequest: async request => { calls.push(['respond', request]) }
  }
  const module = evaluate(controllerSource, { window: { zero3Codex: bridge } })
  return { bridge, module, controller: module.skillInstallController(), calls, dismissCalls,
    emit: event => receive(event),
    started: () => resolve({ threadId: 'install-thread', source: 'demo', destination: 'C:/user/.codex/skills', turn: { turn: { id: 'turn-1', status: 'inProgress' } } }) }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const notification = (method, params = {}) => ({ kind: 'notification', method, params: { threadId: 'install-thread', ...params } })
const approval = { kind: 'request', id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'install-thread', command: 'python install.py --dest shared', reason: 'Network download' } }

test('native installer is system-scoped and explicitly targets shared skills despite isolated CODEX_HOME', async () => {
  const source = read('scripts/apply-codex-skills.mjs')
  const helpers = source.slice(source.indexOf('function zero3CodexSkillsListParams('), source.indexOf('\n`\n\nconst preloadSkills'))
  for (const configured of [undefined, 'C:/custom/shared-skills']) {
    const calls = []
    const bridge = { request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'skills/list') return { data: [{ skills: [
        { name: 'skill-installer', scope: 'repo', path: 'untrusted/SKILL.md' },
        { name: 'skill-installer', scope: 'system', path: 'native/SKILL.md', enabled: true }
      ] }] }
      if (method === 'thread/start') return { thread: { id: 'thread' } }
      return { turn: { id: 'turn' } }
    } }
    const { zero3InstallNativeSkill } = evaluate(helpers + '\nexport { zero3InstallNativeSkill }', {
      zero3CodexAppServer: bridge, zero3CodexRecord: value => value ?? {},
      zero3CodexRequiredString: value => { if (!value?.trim()) throw new Error('required'); return value.trim() },
      zero3CodexOptionalString: value => value, ZERO3_CODEX_TURN_TIMEOUT_MS: 1000,
      path: path.win32, os: { homedir: () => 'C:/user' }, process: { env: { CODEX_HOME: 'C:/Zero3/codex', ZERO3_SHARED_CODEX_SKILLS_ROOT: configured } },
      app: { getPath: () => 'C:/userData' },
      Zero3SkillInstallJobStore: stubInstallJobStore(calls),
      zero3CodexIdKey: id => String(id)
    })
    const result = await zero3InstallNativeSkill({ source: 'demo' })
    const input = calls.find(call => call.method === 'turn/start').params.input
    assert.equal(input[0].path, 'native/SKILL.md')
    assert.match(input[1].text, /Pass --dest/)
    assert.ok(input[1].text.includes(JSON.stringify(path.win32.resolve(configured || 'C:/user/.codex/skills'))))
    assert.equal(result.destination, path.win32.resolve(configured || 'C:/user/.codex/skills'))
    assert.equal(calls.find(call => call.method === 'thread/start').params.approvalPolicy, 'on-request')
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call[0] === 'record')[1])), { threadId: 'thread', source: 'demo', cwd: null, destination: path.win32.resolve(configured || 'C:/user/.codex/skills') })
  }
})

test('buffers early approvals/completion, filters unrelated threads, prevents duplicate installs and reloads catalog', async () => {
  const f = fixture()
  const pending = f.controller.install('demo', 'C:/work')
  await f.controller.install('duplicate')
  f.emit({ ...approval, params: { ...approval.params, threadId: 'another-thread' } })
  f.emit(approval)
  f.started()
  await pending
  assert.equal(f.calls.filter(call => call[0] === 'install').length, 1)
  assert.equal(f.controller.getSnapshot().requests.length, 1)
  await f.controller.respond(approval, { decision: 'decline' })
  assert.equal(f.calls.at(-1)[1].result.decision, 'decline')
  assert.equal(f.controller.getSnapshot().requests.length, 0)
  f.emit(notification('item/agentMessage/delta', { delta: 'Install failed: repository unavailable' }))
  f.emit(notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }))
  assert.equal(f.controller.getSnapshot().status, 'completed')
  assert.match(f.controller.getSnapshot().output, /repository unavailable/)
  assert.equal(f.calls.at(-1)[0], 'list')
})

test('completion before install RPC response is not lost', async () => {
  const f = fixture()
  const pending = f.controller.install('demo')
  f.emit(notification('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'quota exceeded' } } }))
  f.started()
  await pending
  assert.equal(f.controller.getSnapshot().status, 'failed')
  assert.equal(f.controller.getSnapshot().error, 'quota exceeded')
})

test('cancel and disconnection leave retryable terminal states; retryable transport errors keep running', async () => {
  const f = fixture()
  let pending = f.controller.install('demo')
  f.started(); await pending
  f.emit(notification('error', { willRetry: true, error: { message: 'retrying' } }))
  assert.equal(f.controller.getSnapshot().status, 'running')
  f.emit(approval)
  await f.controller.cancel()
  assert.equal(f.calls.find(call => call[0] === 'respond')[1].error.code, -32002)
  assert.equal(f.controller.getSnapshot().status, 'interrupted')
  assert.equal(f.calls.find(call => call[0] === 'interrupt')[1].turnId, 'turn-1')
  pending = f.controller.install('retry')
  f.emit({ kind: 'lifecycle', state: 'error', detail: 'server stopped' })
  f.started(); await pending
  assert.equal(f.controller.getSnapshot().status, 'failed')
  assert.equal(f.controller.getSnapshot().error, 'server stopped')
})

test('after a renderer reload the controller re-attaches to the running install and its pending approvals', async () => {
  const f = fixture({
    activeJob: { threadId: 'install-thread', source: 'demo', cwd: null, destination: 'C:/user/.codex/skills', status: 'running', error: null },
    recoverableJobs: [],
    approvals: [
      { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'install-thread', command: 'python install.py' } },
      { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'another-thread', command: 'unrelated' } }
    ]
  })
  await flush()
  const snapshot = f.controller.getSnapshot()
  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.threadId, 'install-thread')
  assert.equal(snapshot.source, 'demo')
  assert.equal(snapshot.requests.length, 1)
  assert.equal(snapshot.requests[0].id, 42)
  await f.controller.respond(snapshot.requests[0], { decision: 'accept' })
  assert.equal(f.calls.at(-1)[1].result.decision, 'accept')
  f.emit(notification('turn/completed', { turn: { status: 'completed' } }))
  assert.equal(f.controller.getSnapshot().status, 'completed')
})

test('a manual install during recovery wins and recovery steps aside', async () => {
  let releaseRecovery
  const gate = new Promise(resolve => { releaseRecovery = resolve })
  const f = fixture(async () => {
    await gate
    void f.controller.install('manual', null)
    return { activeJob: { threadId: 'stale-thread', source: 'stale', cwd: null, destination: 'd', status: 'running', error: null }, recoverableJobs: [], approvals: [] }
  })
  await flush()
  assert.equal(f.controller.getSnapshot().status, 'idle')
  releaseRecovery()
  await flush()
  assert.equal(f.controller.getSnapshot().status, 'starting')
  f.started()
  await flush()
  const snapshot = f.controller.getSnapshot()
  assert.equal(snapshot.threadId, 'install-thread')
  assert.equal(snapshot.status, 'running')
})

test('interrupted installs surface a recovery prompt; reinstall supersedes and dismisses the old record', async () => {
  const f = fixture({
    activeJob: null,
    recoverableJobs: [{ threadId: 'old-thread', source: 'demo-skill', cwd: 'C:/work', destination: 'C:/skills', status: 'needs_recovery', error: '应用重启中断了安装任务，请重新安装。' }],
    approvals: []
  })
  await flush()
  assert.equal(f.controller.getSnapshot().status, 'idle')
  const recoverable = f.controller.getSnapshot().recoverable
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0].source, 'demo-skill')
  const pendingReinstall = f.controller.reinstall(recoverable[0])
  f.started()
  await pendingReinstall
  assert.equal(f.calls.find(call => call[0] === 'install')[1].source, 'demo-skill')
  assert.equal(f.dismissCalls.at(-1)[1].threadId, 'old-thread')
  assert.equal(f.controller.getSnapshot().recoverable.length, 0)
})

test('a recovered install can be dismissed without reinstalling', async () => {
  const f = fixture({
    activeJob: null,
    recoverableJobs: [{ threadId: 'old-thread', source: 'demo-skill', cwd: null, destination: 'C:/skills', status: 'needs_recovery', error: null }],
    approvals: []
  })
  await flush()
  await f.controller.dismissRecoverable(f.controller.getSnapshot().recoverable[0])
  assert.equal(f.dismissCalls.at(-1)[1].threadId, 'old-thread')
  assert.equal(f.controller.getSnapshot().recoverable.length, 0)
})

test('actual install panel shows approvals, survives remount and reports installer result without claiming installation success', async () => {
  const { JSDOM } = deps('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const before = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const React = deps('react')
  const { render, fireEvent, cleanup, act } = deps('@testing-library/react')
  const f = fixture()
  const { SkillInstallPanel } = evaluate(read('ui-v2/skills/SkillInstallPanel.tsx'), {}, {
    react: React, 'react/jsx-runtime': deps('react/jsx-runtime'), './SkillInstallController': f.module
  })
  let refreshes = 0
  const props = { cwd: null, onFinished: () => { refreshes++ } }
  try {
    let view = render(React.createElement(SkillInstallPanel, props))
    fireEvent.change(view.getByRole('textbox', { name: 'Skill 安装来源' }), { target: { value: 'demo' } })
    fireEvent.click(view.getByRole('button', { name: '安装' }))
    await act(async () => { f.emit(approval); f.started() })
    assert.ok(view.getByRole('button', { name: '允许本次操作' }))
    view.unmount()
    view = render(React.createElement(SkillInstallPanel, props))
    assert.ok(view.getByRole('button', { name: '允许本次操作' }))
    await act(async () => fireEvent.click(view.getByRole('button', { name: '允许本次操作' })))
    assert.equal(f.calls.at(-1)[1].result.decision, 'accept')
    await act(async () => f.emit({ kind: 'request', id: 43, method: 'item/tool/requestUserInput', params: {
      threadId: 'install-thread', questions: [{ id: 'path', question: '选择 Skill 路径', options: [{ label: 'skills/demo', description: 'Demo Skill' }] }]
    } }))
    fireEvent.click(view.getByRole('button', { name: 'skills/demo' }))
    await act(async () => fireEvent.click(view.getByRole('button', { name: '提交回答' })))
    assert.equal(f.calls.at(-1)[1].result.answers.path.answers[0], 'skills/demo')
    await act(async () => {
      f.emit(notification('item/agentMessage/delta', { delta: 'Repository not found' }))
      f.emit(notification('turn/completed', { turn: { status: 'completed' } }))
    })
    assert.match(view.getByRole('status').textContent, /安装任务已结束/)
    assert.doesNotMatch(view.container.textContent, /安装成功/)
    assert.match(view.getByLabelText('安装器输出').textContent, /Repository not found/)
    assert.equal(refreshes, 1)
    assert.equal(view.getByRole('button', { name: '安装' }).disabled, false)
  } finally { cleanup(); dom.window.close(); Object.assign(globalThis, before) }
})

test('install panel offers reinstall and dismiss for installs an app restart interrupted', async () => {
  const { JSDOM } = deps('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const before = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const React = deps('react')
  const { render, fireEvent, cleanup, act } = deps('@testing-library/react')
  const f = fixture({
    activeJob: null,
    recoverableJobs: [{ threadId: 'old-thread', source: 'demo-skill', cwd: null, destination: 'C:/skills', status: 'needs_recovery', error: '应用重启中断了安装任务，请重新安装。' }],
    approvals: []
  })
  const { SkillInstallPanel } = evaluate(read('ui-v2/skills/SkillInstallPanel.tsx'), {}, {
    react: React, 'react/jsx-runtime': deps('react/jsx-runtime'), './SkillInstallController': f.module
  })
  try {
    const view = render(React.createElement(SkillInstallPanel, { cwd: null, onFinished: () => {} }))
    await act(async () => { await flush() })
    assert.match(view.container.textContent, /检测到上次未完成的安装任务/)
    assert.match(view.container.textContent, /demo-skill/)
    await act(async () => fireEvent.click(view.getByRole('button', { name: '重新安装' })))
    assert.equal(f.calls.find(call => call[0] === 'install')[1].source, 'demo-skill')
    assert.equal(f.controller.getSnapshot().recoverable.length, 0)
    assert.doesNotMatch(view.container.textContent, /检测到上次未完成的安装任务/)
  } finally { cleanup(); dom.window.close(); Object.assign(globalThis, before) }
})

test('final item text is shown when no deltas arrived and is not duplicated after streaming', async () => {
  const f = fixture()
  const pending = f.controller.install('demo')
  f.started(); await pending
  f.emit(notification('item/completed', { item: { id: 'one', type: 'agentMessage', text: 'Installed demo' } }))
  f.emit(notification('item/agentMessage/delta', { itemId: 'two', delta: '\nAvailable next turn' }))
  f.emit(notification('item/completed', { item: { id: 'two', type: 'agentMessage', text: 'Available next turn' } }))
  assert.equal(f.controller.getSnapshot().output, '\nInstalled demo\nAvailable next turn')
})

test('RPC failure leaves an actionable error and permits retry without a stale event subscription', async () => {
  const f = fixture()
  f.bridge.skills.install = async () => { throw new Error('native installer unavailable') }
  await f.controller.install('demo')
  assert.equal(f.controller.getSnapshot().status, 'failed')
  assert.equal(f.controller.getSnapshot().error, 'native installer unavailable')
  f.emit(approval)
  assert.equal(f.controller.getSnapshot().requests.length, 0)
})

test('skill install job store persists tasks, recovers interrupted installs and supports dismissal', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zero3-install-jobs-'))
  const file = path.join(tmp, 'jobs.json')
  const { Zero3SkillInstallJobStore } = evaluate(read('skill-runtime/skill-install-jobs.ts'), {}, {
    '../workspace-runtime/atomic-file': { zero3AtomicWriteFile: async (target, body) => fs.writeFileSync(target, body) }
  })
  const store = new Zero3SkillInstallJobStore(file)
  await store.record({ threadId: 't1', source: 'demo', cwd: 'C:/work', destination: 'C:/skills' })
  await store.record({ threadId: 't2', source: 'demo2', cwd: null, destination: 'C:/skills' })
  assert.equal((await store.list()).length, 2)
  await store.update('t1', { status: 'completed' })
  const recovered = await store.recoverInterrupted()
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].threadId, 't2')
  assert.equal(recovered[0].status, 'needs_recovery')
  assert.ok((await store.list()).find(job => job.threadId === 't2').endedAt)
  const rerun = await store.record({ threadId: 't2', source: 'demo2', cwd: null, destination: 'C:/skills' })
  assert.equal(rerun.status, 'running')
  assert.equal(await store.remove('t2'), true)
  assert.equal((await store.list()).length, 1)
  assert.equal(await store.remove('missing'), false)
  await store.update('missing', { status: 'failed' })
  assert.equal((await store.list()).length, 1)
  fs.rmSync(tmp, { recursive: true, force: true })
})

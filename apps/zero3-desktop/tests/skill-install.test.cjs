const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
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
  vm.runInNewContext(js, { exports, require: name => overrides[name] ?? deps(name), Error, console, ...globals })
  return exports
}
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const controllerSource = read('ui-v2/skills/SkillInstallController.ts')
function fixture() {
  let receive = () => {}
  let resolve
  const calls = []
  const bridge = {
    onEvent: listener => { receive = listener; return () => { receive = () => {} } },
    skills: { install: request => { calls.push(['install', request]); return new Promise(done => { resolve = done }) }, list: async request => { calls.push(['list', request]); return { data: [] } } },
    turn: { interrupt: async request => { calls.push(['interrupt', request]) } },
    respondToServerRequest: async request => { calls.push(['respond', request]) }
  }
  const module = evaluate(controllerSource, { window: { zero3Codex: bridge } })
  return { bridge, module, controller: module.skillInstallController(), calls,
    emit: event => receive(event),
    started: () => resolve({ threadId: 'install-thread', source: 'demo', destination: 'C:/user/.codex/skills', turn: { turn: { id: 'turn-1', status: 'inProgress' } } }) }
}
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
      path: path.win32, os: { homedir: () => 'C:/user' }, process: { env: { CODEX_HOME: 'C:/Zero3/codex', ZERO3_SHARED_CODEX_SKILLS_ROOT: configured } }
    })
    const result = await zero3InstallNativeSkill({ source: 'demo' })
    const input = calls.find(call => call.method === 'turn/start').params.input
    assert.equal(input[0].path, 'native/SKILL.md')
    assert.match(input[1].text, /Pass --dest/)
    assert.ok(input[1].text.includes(JSON.stringify(path.win32.resolve(configured || 'C:/user/.codex/skills'))))
    assert.equal(result.destination, path.win32.resolve(configured || 'C:/user/.codex/skills'))
    assert.equal(calls.find(call => call.method === 'thread/start').params.approvalPolicy, 'on-request')
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

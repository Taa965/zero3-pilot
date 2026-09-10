const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('task center is a workflow module host rather than a hard-coded review demo', () => {
  const list = read('ui-v2/tasks/TaskList.tsx')
  const workspace = read('ui-v2/tasks/TaskWorkspace.tsx')
  assert.match(list, /WorkflowAdapter\.listRuns/)
  assert.match(list, /新建/)
  assert.doesNotMatch(list, /UI2-GEMINI-001/)
  assert.match(workspace, /WorkflowPicker/)
  assert.match(workspace, /workflowModuleUi/)
  assert.doesNotMatch(workspace, /代码变更/)
})

test('cognitive store task UI exposes worker pipeline and per-item stage matrix', () => {
  const view = read('ui-v2/tasks/modules/cognitive-store-video/RunView.tsx')
  const create = read('ui-v2/tasks/modules/cognitive-store-video/CreateRun.tsx')
  assert.match(view, /GPT 工位/)
  assert.match(view, /批次流水线/)
  assert.match(create, /选择本地文件/)
  assert.match(create, /Google Drive/)
  assert.match(create, /脚本 Worker/)
})

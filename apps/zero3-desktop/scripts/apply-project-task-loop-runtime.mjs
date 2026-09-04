import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'
import { applyZero3ProjectRuntime } from './apply-project-runtime.mjs'

function read(relativePath) {
  return fs.readFileSync(path.join(hermesDesktopDir, ...relativePath.split('/')), 'utf8')
}

function write(relativePath, content) {
  fs.writeFileSync(path.join(hermesDesktopDir, ...relativePath.split('/')), content)
}

function patchFile(relativePath, replacements) {
  let source = read(relativePath)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Zero3 project/task-loop overlay drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(relativePath, source)
}

function applyTaskListAndReviewBridge() {
  const main = read('electron/main.ts')
  if (!main.includes('const zero3AgentDesktopHandlers = createZero3AgentDesktopHandlers({')) {
    console.log('Zero3 task-list/review bridge deferred until the Agent Router integration is staged.')
    return
  }

  patchFile('electron/main.ts', [
    {
      label: 'durable task list and review runtime methods',
      from: 'const zero3AgentDesktopHandlers = createZero3AgentDesktopHandlers({\n  task: taskId => zero3AgentRuntime.task(taskId),\n  dispatch:',
      to:
        'const zero3AgentDesktopHandlers = createZero3AgentDesktopHandlers({\n' +
        '  task: taskId => zero3AgentRuntime.task(taskId),\n' +
        '  tasks: input => zero3AgentTaskStore.list(input),\n' +
        '  review: taskId => zero3ReviewStore.get(taskId),\n' +
        '  dispatch:'
    },
    {
      label: 'task list and review IPC handlers',
      from: "ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.taskGet, (_event, request: unknown) => zero3AgentDesktopHandlers.taskGet(request))\nipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.dispatch,",
      to:
        "ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.taskGet, (_event, request: unknown) => zero3AgentDesktopHandlers.taskGet(request))\n" +
        "ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.taskList, (_event, request: unknown) => zero3AgentDesktopHandlers.taskList(request))\n" +
        "ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.reviewGet, (_event, request: unknown) => zero3AgentDesktopHandlers.reviewGet(request))\n" +
        "ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.dispatch,"
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'task list and review preload surface',
      from: "contextBridge.exposeInMainWorld('zero3AgentTask', {\n  get: request => ipcRenderer.invoke('zero3:agent-task:get', request),\n  dispatch:",
      to:
        "contextBridge.exposeInMainWorld('zero3AgentTask', {\n" +
        "  get: request => ipcRenderer.invoke('zero3:agent-task:get', request),\n" +
        "  list: request => ipcRenderer.invoke('zero3:agent-task:list', request),\n" +
        "  reviewGet: request => ipcRenderer.invoke('zero3:agent-task:review-get', request),\n" +
        "  dispatch:"
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'task list and review renderer types',
      from: '    zero3AgentTask: {\n      get: (request: { taskId: string }) => Promise<unknown>\n      dispatch:',
      to:
        '    zero3AgentTask: {\n' +
        '      get: (request: { taskId: string }) => Promise<unknown>\n' +
        '      list: (request?: { projectId?: string | null; states?: string[] | null; limit?: number | null }) => Promise<unknown>\n' +
        '      reviewGet: (request: { taskId: string }) => Promise<unknown>\n' +
        '      dispatch:'
    }
  ])

  const provenancePath = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
  if (fs.existsSync(provenancePath)) {
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
    provenance.projectContextPhase = 'P2A-project-registry-active-context'
    provenance.taskBoardPhase = 'P2B-durable-task-review-board'
    fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)
  }
  console.log('Zero3 task authority surface staged: durable project-filtered task list and review packet lookup are available to the owned renderer.')
}

export function applyZero3ProjectTaskLoopRuntime() {
  applyZero3ProjectRuntime()
  applyTaskListAndReviewBridge()
}

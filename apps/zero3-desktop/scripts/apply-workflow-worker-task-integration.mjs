import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.writeFileSync(file, content) }

export function applyWorkflowWorkerTaskIntegration() {
  const file = path.join(hermesDesktopDir, 'electron', 'main.ts')
  let source = read(file)
  const marker = 'zero3WorkflowRuntime.attachWorkflowWorkerAdmin({'
  if (source.includes(marker)) return
  const workerAnchor = "const zero3WorkflowWorkerRuntime = new Zero3WorkflowWorkerRuntime(zero3WorkflowWorkerStore, { ticketSecret: zero3WorkerBindingSecret() })\n"
  if (!source.includes(workerAnchor)) {
    throw new Error('Workflow Worker / Task integration drift: long-lived worker runtime composition is missing')
  }
  const workflowAnchor = "const zero3WorkflowRuntime = createWorkflowDesktopRuntime(path.join(app.getPath('userData'), 'workflow'))\n"
  if (!source.includes(workflowAnchor)) {
    throw new Error('Workflow Worker / Task integration drift: Task Workflow Runtime composition is missing')
  }
  const integration = `${workflowAnchor}zero3WorkflowRuntime.attachWorkflowWorkerAdmin({
  ensureWorkflowRun: input => zero3WorkflowWorkerRuntime.ensureWorkflowRun(input),
  ensureWorkerBinding: input => zero3WorkflowWorkerRuntime.ensureWorkerBinding(input),
  addWorkItems: input => zero3WorkflowWorkerRuntime.addWorkItems(input),
  workflowSnapshot: workflowRunId => zero3WorkflowWorkerRuntime.workflowSnapshot(workflowRunId)
})
`
  source = source.replace(workflowAnchor, integration)
  write(file, source)
}

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const manager = read('apps/zero3-desktop/workflow-runtime/worker-station-manager.ts')
const prompts = read('apps/zero3-desktop/workflow-runtime/worker-prompt-registry.ts')
const runtime = read('apps/zero3-desktop/worker-runtime/v2/workflow-worker-runtime.ts')
const wakeup = read('apps/zero3-desktop/workflow-runtime/worker-wakeup.ts')
const cognitive = read('apps/zero3-desktop/workflow-runtime/cognitive-store-module.ts')
const overlay = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
const gateway = read('apps/web/src/worker_gateway.rs')

requireText(manager, 'class Zero3WorkerStationManager', 'Local Station Manager is missing.')
requireText(manager, 'this.gpt.create(projectId)', 'Station Manager must create GPT Web sessions through the local provider.')
requireText(manager, 'this.runtime.rotatePhysicalSession', 'Station Manager must perform generation-fenced physical-session rotation.')
requireText(manager, 'buildWorkerBootstrapPrompt', 'Station Manager must inject a version-controlled bootstrap prompt.')
requireText(prompts, 'cognitive-store-script-worker.v1', 'Script station prompt revision is missing.')
requireText(prompts, 'cognitive-store-visual-worker.v1', 'Visual station prompt revision is missing.')
requireText(prompts, 'cognitive-store-image-worker.v1', 'Image station prompt revision is missing.')
requireText(runtime, "state: 'STARTING'", 'New Physical Sessions must start before bootstrap.')
requireText(runtime, 'must call bootstrap_worker before claim_work', 'Claim must be fenced until bootstrap completes.')
requireText(runtime, 'issueBindingTicket(workerSlotIdValue', 'Runtime must locally refresh generation-scoped Binding Tickets.')
requireText(runtime, 'expiresInSeconds: 86_400', 'Physical Session Binding Tickets must have a bounded long-lived TTL.')
requireText(wakeup, 'this.runtime.issueBindingTicket', 'Wakeup must attach a fresh current-generation Binding Ticket.')
requireText(cognitive, 'autoProvisionGptWorkers: true', 'Cognitive Store Workflow must opt into automatic GPT station provisioning.')
requireText(cognitive, 'projectId', 'Cognitive Store Workflow must retain project scope for GPT project binding.')
requireText(overlay, 'zero3WorkerStationManager.start()', 'Electron composition must start the local Station Manager.')
requireText(overlay, 'zero3WorkerStationManager.reconcileRun', 'Workflow installation must immediately reconcile GPT stations.')

for (const forbidden of ['worker_station_manager', 'provision_gpt_station', 'create_gpt_session', 'rotate_gpt_session']) {
  forbidText(gateway, forbidden, `Station lifecycle authority must not be exposed through public MCP: ${forbidden}`)
}
for (const source of [manager, prompts]) {
  for (const forbidden of ['dispatch_codex', 'run_gpu', 'child_process', 'shell.execute', 'webContents.executeJavaScript']) {
    forbidText(source, forbidden, `Station Manager must remain a narrow local coordinator: ${forbidden}`)
  }
}

console.log('Zero3 Worker Station Manager guard passed: local auto-provision -> versioned bootstrap prompt + current-generation ticket -> STARTING/ACTIVE protocol -> automatic physical-session rotation, with no public MCP or executor authority.')

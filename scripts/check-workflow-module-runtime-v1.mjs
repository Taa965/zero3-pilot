import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const contracts = read('apps/zero3-desktop/workflow-runtime/contracts.ts')
const store = read('apps/zero3-desktop/workflow-runtime/store.ts')
const registry = read('apps/zero3-desktop/workflow-runtime/registry.ts')
const module = read('apps/zero3-desktop/workflow-modules/cognitive-store-video/module.ts')
const workerV2 = read('apps/zero3-desktop/workflow-runtime/worker-v2-adapter.ts')
const taskList = read('apps/zero3-desktop/ui-v2/tasks/TaskList.tsx')
const taskWorkspace = read('apps/zero3-desktop/ui-v2/tasks/TaskWorkspace.tsx')
const bridge = read('apps/zero3-desktop/scripts/apply-execution-runtime-bridge.mjs')

for (const token of ['WorkflowModule', 'WorkflowRun', 'WorkflowItem', 'WorkflowStageRunRecord', 'WorkflowArtifactRecord']) {
  requireText(contracts, token, `Workflow contracts are missing ${token}.`)
}
requireText(store, 'CREATE TABLE IF NOT EXISTS work_items', 'Workflow runtime must persist WorkItems.')
requireText(store, 'CREATE TABLE IF NOT EXISTS stage_runs', 'Workflow runtime must persist per-item StageRuns.')
requireText(store, 'releaseDependenciesTx(runId, row.item_id', 'Completion must release dependencies only for the completed WorkItem.')
requireText(store, "status='READY'", 'Workflow runtime must expose item-level ready queues.')
requireText(registry, 'workflow module already registered', 'Workflow Registry must reject duplicate module identities.')
requireText(module, "id: 'cognitive-store-video'", 'Cognitive Store Video must be a first-class workflow module.')
requireText(module, "workerDefinitionId: 'script-worker'", 'Cognitive Store module must define a script worker.')
requireText(module, 'maxImagesPerBatch: 10', 'The module must own the 10-image batch business rule.')
requireText(workerV2, 'WorkflowWorkUnit', 'Workflow Runtime must project READY StageRuns into Worker Protocol v2 WorkUnits.')
requireText(workerV2, 'WorkflowWorkerBinding', 'Workflow Runtime must project module workers into Worker Protocol v2 bindings.')
requireText(bridge, "copyProductionTree(workflowSource", 'Desktop preparation must stage Workflow Runtime.')
requireText(bridge, "contextBridge.exposeInMainWorld('zero3Workflow'", 'Renderer must receive a purpose-specific Workflow bridge.')
forbidText(taskList, 'UI2-GEMINI-001', 'TaskList must not retain the hard-coded demo task.')
forbidText(taskWorkspace, '审核轮次', 'TaskWorkspace must not remain a code-review-specific demo.')
requireText(taskWorkspace, 'workflowModuleUi', 'TaskWorkspace must mount registered module UI instead of hardcoding business screens.')

console.log('Zero3 Workflow Module Runtime V1 architecture guard passed: module registry -> per-item pipeline runtime -> artifact registry -> module-host Task Center.')

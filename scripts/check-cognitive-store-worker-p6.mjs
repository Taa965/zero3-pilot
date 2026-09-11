import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const moduleSource = read('apps/zero3-desktop/workflow-runtime/cognitive-store-module.ts')
const runtime = read('apps/zero3-desktop/worker-runtime/v2/workflow-worker-runtime.ts')
const overlay = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
const gateway = read('apps/web/src/worker_gateway.rs')

for (const slot of ['script-worker-01', 'visual-worker-01', 'image-worker-01']) {
  requireText(moduleSource, slot, `Cognitive Store module is missing ${slot}.`)
}
requireText(moduleSource, 'COGNITIVE_STORE_IMAGE_BATCH_LIMIT = 10', 'Image batch limit must remain module-local.')
requireText(moduleSource, "stageKey: 'script-rewrite'", 'Script StageRun is missing.')
requireText(moduleSource, "stageKey: 'visual-plan'", 'Visual StageRun is missing.')
requireText(moduleSource, "stageKey: 'image-overview'", 'Overview image StageRun is missing.')
requireText(moduleSource, "stageKey: 'image-chapter-batch'", 'Chapter image batch StageRun is missing.')
requireText(moduleSource, "stageKey: 'image-package'", 'Image package StageRun is missing.')
requireText(runtime, 'const declaredInputs = workflowParse<WorkflowArtifactRef[]>(row.inputs_json, [])', 'Downstream claims must merge declared and dependency Artifacts.')
requireText(runtime, 'JOIN stage_runs p ON p.stage_run_id=d.depends_on_stage_run_id', 'Dependency Artifact propagation query is missing.')
requireText(overlay, "zero3:workflow-worker:install-cognitive-store", 'Task/Workflow local installer IPC is missing.')
requireText(overlay, 'installCognitiveStoreWorkflow', 'Prepared desktop must import the Cognitive Store module installer.')

for (const forbidden of [
  'dispatch_codex', 'run_gpu', 'child_process', 'powershell', 'shell.execute'
]) {
  forbidText(moduleSource, forbidden, `Cognitive Store Workflow Module must not gain executor authority: ${forbidden}`)
}
forbidText(gateway, 'install_cognitive_store', 'Cognitive Store installer must not be exposed through public Worker MCP.')
forbidText(gateway, 'install-cognitive-store', 'Cognitive Store installer must remain local-only.')

console.log('Zero3 Cognitive Store Worker P6 guard passed: three long-lived stations + Script->Visual->Image DAG + module-local 10-image batching + dependency Artifact propagation, with local-only installation and no executor authority.')

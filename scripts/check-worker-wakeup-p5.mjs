import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const store = read('apps/zero3-desktop/worker-runtime/v2/worker-store.ts')
const runtime = read('apps/zero3-desktop/worker-runtime/v2/workflow-worker-runtime.ts')
const controller = read('apps/zero3-desktop/workflow-runtime/worker-wakeup.ts')
const gptWakeup = read('apps/zero3-desktop/gpt-web-runtime/chatgpt-wakeup.ts')
const gptProvider = read('apps/zero3-desktop/gpt-web-runtime/gpt-web-provider.ts')
const overlay = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
const gateway = read('apps/web/src/worker_gateway.rs')

requireText(store, 'workflow_worker_queue_state', 'P5 queue transition state table is missing.')
requireText(store, 'workflow_worker_wakeups', 'P5 durable wakeup table is missing.')
requireText(store, 'UNIQUE(worker_slot_id,queue_generation)', 'P5 wakeup dedupe constraint is missing.')
requireText(runtime, 'previousCount === 0 && readyCount > 0', 'P5 must trigger only on READY queue 0->1 transitions.')
requireText(runtime, 'pendingWakeups(', 'P5 pending wakeup reconciliation is missing.')
requireText(runtime, 'requireRotationForWakeup(', 'P5 stalled-session rotation handoff is missing.')
requireText(controller, 'executionStatus(', 'P5 must guard wakeup against an active GPT turn.')
requireText(controller, 'sendWakeup(', 'P5 controller is not wired to the narrow GPT wakeup port.')
requireText(controller, "status.health === 'stalled'", 'P5 stalled execution detection is missing.')
requireText(gptProvider, 'async sendWakeup(', 'GPT Web provider must expose the internal-only wakeup method.')
requireText(gptWakeup, "url.origin !== 'https://chatgpt.com'", 'P5 wakeup must be origin-pinned to chatgpt.com.')
requireText(gptWakeup, '#prompt-textarea', 'P5 wakeup must target the ChatGPT composer.')
requireText(gptWakeup, 'send-button', 'P5 wakeup must use the ChatGPT send control.')
requireText(overlay, 'const zero3WorkerWakeupController = new Zero3WorkerWakeupController', 'P5 controller is not composed in Electron main.')
requireText(overlay, 'zero3WorkerWakeupController.start()', 'P5 controller must start with the local desktop runtime.')
requireText(overlay, 'zero3WorkerWakeupController.stop()', 'P5 controller must stop during desktop shutdown.')

for (const forbidden of ['send_wakeup', 'wakeup_worker', 'browser_control', 'web_output', 'read_response']) {
  forbidText(gateway, forbidden, `P5 wakeup must not become a remote MCP capability: ${forbidden}`)
}
for (const forbidden of ['fetch(', 'XMLHttpRequest', '/backend-api/', '/conversation']) {
  forbidText(gptWakeup, forbidden, `P5 must not bypass the visible ChatGPT composer: ${forbidden}`)
}
forbidText(controller, 'executeJavaScript', 'Wakeup controller must not inspect or manipulate page output directly.')

console.log('Zero3 Worker Wakeup P5 guard passed: durable READY 0->1 transition -> deduped local wakeup -> active-turn guard -> composer-only send -> stalled rotation, with no remote wakeup tool or output reading.')

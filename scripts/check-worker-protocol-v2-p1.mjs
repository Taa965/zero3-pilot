import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const contracts = read('apps/zero3-desktop/worker-runtime/v2/contracts.ts')
const tickets = read('apps/zero3-desktop/worker-runtime/v2/binding-ticket.ts')
const compatibility = read('apps/zero3-desktop/worker-runtime/v2/compatibility.ts')
const v1Tools = read('apps/zero3-desktop/mcp-runtime/worker-tools.mjs')

requireText(contracts, 'zero3.pilot.worker-protocol.v2', 'Worker Protocol v2 identifier is missing.')
requireText(contracts, "provider: WorkerProvider", 'Workflow binding must carry a provider.')
requireText(contracts, 'generation: number', 'Worker Slot / Physical Session generation fencing is missing.')
requireText(contracts, "'GOOGLE_DRIVE' | 'LOCAL' | 'REMOTE_COMPUTE' | 'URL'", 'Artifact v2 storage providers are incomplete.')
requireText(contracts, 'expectedOutputs: ExpectedArtifact[]', 'WorkUnit v2 expected outputs are missing.')
requireText(tickets, 'createHmac', 'Binding Ticket must be cryptographically signed.')
requireText(tickets, 'timingSafeEqual', 'Binding Ticket signature comparison must be timing safe.')
requireText(tickets, 'allowedCapabilities', 'Binding Ticket capability scope is missing.')
requireText(tickets, 'worker binding ticket generation is stale', 'Binding Ticket generation fencing must fail closed.')
requireText(compatibility, 'adaptV1WorkUnitToV2', 'V1 WorkUnit compatibility adapter is missing.')
requireText(compatibility, 'adaptV2ArtifactToV1Ref', 'V2 Artifact reverse compatibility adapter is missing.')

for (const tool of [
  'register_worker', 'claim_work', 'report_progress',
  'complete_and_claim_next', 'report_failure', 'get_task_context'
]) {
  requireText(v1Tools, `'${tool}'`, `V1 compatibility tool is missing: ${tool}`)
}

for (const source of [contracts, tickets, compatibility]) {
  for (const forbidden of [
    'child_process', 'dispatch_codex', 'run_gpu', 'workflow_admin',
    'powershell', 'cmd.exe', 'shell.execute'
  ]) {
    forbidText(source, forbidden, `Worker Protocol v2 P1 must not gain execution authority: ${forbidden}`)
  }
}

console.log('Zero3 Worker Protocol v2 P1 guard passed: long-lived worker identity + structured WorkUnit/Artifact + signed scoped generation-fenced Binding Ticket + v1 compatibility, without executor authority.')

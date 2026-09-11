import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const runtime = read('apps/zero3-desktop/worker-runtime/v2/lifecycle-runtime.ts')
const store = read('apps/zero3-desktop/worker-runtime/v2/lifecycle-store.ts')
const artifact = read('apps/zero3-desktop/artifact-runtime/artifact-reference-store.ts')
const memory = read('apps/zero3-desktop/memory-sync-runtime/shared-memory-runtime.mjs')
const overlay = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
const gateway = read('apps/web/src/worker_gateway.rs')

for (const method of [
  'sessionStart', 'contextResolve', 'taskClaim', 'eventRecord',
  'artifactRegister', 'taskComplete', 'memoryCommit', 'handoffCreate'
]) requireText(runtime, `async ${method}(`, `Agent lifecycle MVP is missing ${method}.`)

requireText(runtime, 'this.execution.getTask(', 'Lifecycle must read Task state from the authoritative Execution Runtime.')
requireText(runtime, 'this.execution.createAssignment(', 'Lifecycle task.claim must bind through the authoritative Execution Runtime.')
requireText(runtime, 'this.execution.requestCompletion(', 'task.complete must request authoritative Completion Gate verification.')
requireText(runtime, "'COMPLETED_WITH_WARNINGS'", 'Memory/registration degradation must be explicit.')
requireText(runtime, 'this.store.enqueueMemory(', 'Memory publication must be protected by a local compensation outbox.')
requireText(runtime, 'contextCheck(', 'Context version stale detection must be available for incremental refresh.')
requireText(runtime, 'sessionInterrupt(', 'Interrupted-session recovery hook must be present.')

for (const table of [
  'agent_lifecycle_sessions', 'agent_lifecycle_claims', 'agent_worklog',
  'task_context_versions', 'task_context_changes', 'lifecycle_idempotency', 'lifecycle_memory_outbox'
]) requireText(store, table, `Lifecycle supplemental store is missing ${table}.`)

forbidText(store, 'CREATE TABLE IF NOT EXISTS tasks', 'Lifecycle layer must not create a second Task ledger.')
forbidText(store, 'task_status TEXT', 'Lifecycle layer must not persist a second authoritative Task status.')
requireText(artifact, 'Zero3ArtifactReferenceStore', 'External/Drive Artifact registry extension is missing.')
requireText(artifact, 'idempotencyKey', 'Artifact registration must be idempotent.')
requireText(memory, 'zero3.memory.event.v1', 'Shared Memory must remain event-based authority.')
requireText(overlay, 'zero3ExecutionRuntime', 'Lifecycle must compose over the existing Execution Runtime.')
requireText(overlay, 'zero3SharedMemoryForProject', 'Lifecycle must reuse the existing Shared Memory runtime.')
requireText(overlay, 'zero3ArtifactReferenceStore', 'Lifecycle must reuse the Artifact subsystem.')

for (const tool of [
  'session_start','context_resolve','task_claim','event_record',
  'artifact_register','task_complete','memory_commit','handoff_create'
]) requireText(gateway, `"${tool}"`, `Private MCP gateway is missing lifecycle tool ${tool}.`)

for (const forbidden of ['dispatchCodex', 'runGpu', 'child_process', 'execCommand(', '.gatePassed(']) {
  forbidText(runtime, forbidden, `Shared lifecycle runtime must not gain executor/completion authority: ${forbidden}`)
}

console.log('Zero3 shared organizational state MVP guard passed: authoritative Task Runtime + Shared Memory + Artifact registry + Worklog lifecycle hooks, without a second task ledger or executor authority.')

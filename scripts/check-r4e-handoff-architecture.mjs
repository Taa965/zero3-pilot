import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const handoffRoot = path.join(root, 'apps', 'zero3-desktop', 'executor-runtime', 'handoff')
const read = file => fs.readFileSync(path.join(handoffRoot, file), 'utf8')
const types = read('handoff-types.ts')
const builder = read('handoff-builder.ts')
const store = read('handoff-store.ts')
const lease = read('workspace-lease.ts')
const verifier = read('handoff-verifier.ts')
const all = [types, builder, store, lease, verifier].join('\n')
const requireText = (source, text, message) => { if (!source.includes(text)) throw new Error(message) }
const forbidText = (source, text, message) => { if (source.includes(text)) throw new Error(message) }

requireText(types, "'zero3.pilot.handoff.v1'", 'R4E schema version missing')
for (const field of ['task_id', 'execution_id', 'workspace', 'branch', 'base_sha', 'head_sha', 'dirty_worktree_fingerprint', 'changed_files', 'untracked_files', 'tests_run', 'test_results', 'pending_approvals', 'checkpoint_hash', 'handoff_generation']) requireText(types, field, `R4E required field missing: ${field}`)
requireText(store, 'handle.sync()', 'checkpoint file must be fsynced before rename')
requireText(store, 'await rename(temporary, target)', 'checkpoint persistence must use atomic rename')
requireText(store, 'syncParentDirectory', 'checkpoint persistence must attempt parent directory fsync')
requireText(builder, "execFile('git'", 'R4E must capture Git state using fixed git argv')
forbidText(builder, 'shell: true', 'R4E Git capture must never use shell execution')
requireText(verifier, 'Do not modify code yet.', 'HANDOFF_VERIFY must forbid writes before verification')
requireText(verifier, "'HANDOFF_ACCEPT'", 'handoff accept state missing')
requireText(verifier, "'HANDOFF_REJECT'", 'handoff reject state missing')
requireText(lease, "state: 'active' | 'handoff_pending'", 'workspace writer lease state missing')
requireText(lease, "open(file, 'wx'", 'writer lease acquisition must use exclusive create')
requireText(lease, 'workspace already has an active or pending writer lease', 'duplicate writer gate missing')
requireText(lease, "verification.decision !== 'HANDOFF_ACCEPT'", 'writer transfer must require HANDOFF_ACCEPT')
requireText(lease, 'executor does not hold verified workspace write authority', 'write authority verification missing')

for (const forbidden of ['@agentclientprotocol', 'acpx', 'Zero3CodexAppServer', 'executor-router', 'retryBudget', 'circuitBreaker', 'ipcRenderer', 'http://', 'https://']) forbidText(all, forbidden, `R4E boundary violation: ${forbidden}`)
console.log('Zero3 Pilot R4E Handoff architecture guard passed.')

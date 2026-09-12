import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const loop = read('apps/zero3-desktop/worker-runtime/v2/autonomous-task-loop.ts')
const orchestrator = read('apps/zero3-desktop/worker-runtime/v2/autonomous-orchestrator.ts')
const store = read('apps/zero3-desktop/worker-runtime/v2/lifecycle-store.ts')
const overlay = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
const doc = read('docs/AUTONOMOUS_TASK_RUNTIME_V1_3.md')
const taskWorkspace = read('apps/zero3-desktop/ui-v2/tasks/TaskWorkspace.tsx')
const taskList = read('apps/zero3-desktop/ui-v2/tasks/TaskList.tsx')

for (const marker of [
  'ZERO3_AUTONOMOUS_ORCHESTRATOR', 'ZERO3_PLUGIN_CAPABILITY_BASELINE',
  'IGNORE', 'OBSERVE', 'DEFER', 'PARALLEL', 'INTERRUPT',
  'evaluateAttentionBudget', 'guardEventToCandidate', 'buildAutonomousAgentDispatchRequest', 'createAutonomousPlanProposal',
  'ZERO3_PLAN_PROPOSAL', 'materialized: false'
]) requireText(orchestrator, marker, `Autonomous v1.3 contract is missing ${marker}.`)

for (const capability of [
  'zero3.full-capability.web-gpt', 'agent.dispatch.unified', 'agent.dispatch.codex.full',
  'session.bootstrap.project', 'memory.shared.lifecycle'
]) requireText(orchestrator, capability, `Post-plugin capability baseline is missing ${capability}.`)

forbidText(orchestrator, 'createTask(', 'Governance/Planner contract module must not directly mutate Execution Task authority.')
forbidText(orchestrator, 'CREATE TABLE', 'Autonomous orchestrator contract must not create a second authority database.')
for (const marker of [
  'decideAutonomousCandidate(', "disposition !== 'PARALLEL' && disposition !== 'INTERRUPT'",
  'autonomousLineage', 'resumeParentOnComplete', 'reconcileParentResume(',
  'evaluatePluginCapabilityBaseline(', 'agentDispatch?: AutonomousAgentDispatchPort',
  'ingestGuardEvent(', 'ingestExecutionGuardEvents(', 'ingestGptWebGuardEvents(', 'reconcileProjectNow(',
  'memoryTimeoutMs', 'memoryCall(',
  'createGoal(', 'dashboard('
]) requireText(loop, marker, `Autonomous loop is missing v1.3 behavior ${marker}.`)

for (const column of [
  'disposition', 'decision_reason', 'root_task_id', 'parent_task_id',
  'attention_cost', 'human_attention_reason', 'resolved_at'
]) requireText(store, column, `Autonomous intake governance persistence is missing ${column}.`)
requireText(store, 'autonomous_parent_resume', 'Parent-resume receipt table is missing.')
requireText(store, 'PRAGMA table_info(autonomous_task_intake)', 'Legacy intake migration guard is missing.')
forbidText(store, 'CREATE TABLE IF NOT EXISTS autonomous_tasks', 'Autonomous layer must not create a second Task ledger.')
forbidText(store, 'autonomous_task_status', 'Autonomous layer must not persist duplicate authoritative Task status.')

requireText(overlay, 'zero3ExecutionRuntime.runtime.transitionTask', 'Parent resume must mutate Task status through the authoritative Execution Runtime.')
requireText(overlay, "zero3:autonomous:status", 'Post-plugin capability baseline status API must be wired.')
requireText(overlay, "zero3:autonomous:reconcile-project", 'Event-triggered project reconcile API must be wired.')

forbidText(loop, 'listProviders()', 'Autonomous Runtime must reuse the unified Intelligent Agent Router instead of maintaining a second provider selector.')
requireText(overlay, 'zero3AgentRuntime.dispatchAgentTask', 'Autonomous Agent dispatch must reuse the authoritative unified Agent Runtime.')
requireText(overlay, 'zero3AutonomousExternalGuards', 'Structured Worker/Capability/Compute Runtime Guard composition is missing.')
for (const channel of ['zero3:autonomous:create-goal', 'zero3:autonomous:dashboard', 'zero3:autonomous:ingest-guard']) {
  requireText(overlay, channel, `Autonomous desktop bridge is missing ${channel}.`)
}
requireText(overlay, "exposeInMainWorld('zero3Autonomous'", 'Autonomous renderer bridge is missing.')
for (const marker of ['新建自主目标', '自主编排', 'Human Attention', 'Execution Graph']) requireText(taskWorkspace, marker, `Task workspace is missing ${marker}.`)
requireText(taskList, '自主目标', 'Task Board must expose the autonomous Root Goal entry point.')

for (const marker of [
  'Plugin Capability Gate', 'CURRENT', 'REQUIRED_POST_PLUGIN',
  'Execution Runtime', 'Completion Gate', 'Worker Runtime', 'Memory Authority',
  'Parent Resume', 'Human Attention', 'Execution Graph', 'Daily Review'
]) requireText(doc, marker, `Autonomous v1.3 documentation is missing ${marker}.`)

console.log('Zero3 Autonomous Task Runtime v1.3 guard passed: Root Goal entry, governance, unified Agent Runtime dispatch, structured guards, lineage/budget/parent-resume, planner proposals and Task Board projections without duplicate authority.')
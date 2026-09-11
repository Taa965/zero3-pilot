import fs from 'node:fs'

const contracts = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/intelligent-router-contracts.ts', 'utf8')
const agentContracts = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/agent-contracts.ts', 'utf8')
const router = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/intelligent-router.ts', 'utf8')
const metrics = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/routing-metrics-store.ts', 'utf8')
const orchestrator = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/agent-runtime-orchestrator.ts', 'utf8')
const taskStore = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/agent-task-store.ts', 'utf8')
const bridge = fs.readFileSync('apps/zero3-desktop/agent-desktop-bridge/bridge.ts', 'utf8')
const codexAdapter = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/codex-task-adapter.ts', 'utf8')
const fastPath = fs.readFileSync('apps/zero3-desktop/host-runtime/web-gpt-fast-path.ts', 'utf8')

const require = (text, file, message) => { if (!file.includes(text)) throw new Error(message) }
const forbid = (text, file, message) => { if (file.includes(text)) throw new Error(message) }

// Structured, auditable routing decisions are mandatory.
require("ZERO3_INTELLIGENT_ROUTE_DECISION_V1 = 'zero3.pilot.intelligent-route-decision.v1'", contracts, 'routing decision protocol missing')
require("Zero3RoutingMode = 'AUTO' | 'PINNED' | 'PREFERRED'", contracts, 'routing modes missing')
require("Zero3TaskImportance = 'low' | 'normal' | 'high' | 'critical'", agentContracts, 'task importance ladder missing')
require('verificationProfileFor', contracts, 'importance -> verification profile mapping missing')
require('requiresIndependentVerifier: boolean', contracts, 'independent verifier requirement missing')
require('requiresDistinctReviewer: boolean', contracts, 'distinct reviewer requirement missing')
require('crossModelReview: boolean', contracts, 'cross-model review requirement missing')
require('class Zero3RoutingError', contracts, 'typed routing error missing')
require('fallbackOrder', contracts, 'failover order missing from the routing decision contract')
require('rejectedExecutors', contracts, 'rejection audit trail missing from the routing decision contract')

// Every routing dimension must exist, and capability must stay a hard filter.
for (const factor of ['capability', 'availability', 'taskType', 'contextAffinity', 'latency', 'cost', 'historicalSuccess']) {
  require(`${factor}: number`, contracts, `routing factor missing: ${factor}`)
}
require('REQUIRED_CAPABILITIES_BY_TYPE', router, 'capability hard filter derivation missing')
require('blockedStatusReason', router, 'availability hard filter missing')
require('missing required capabilities', router, 'capability rejection reason missing')
require('quota exhausted', router, 'quota_exhausted rejection handling missing')
require('offline', router, 'offline rejection handling missing')
for (const forbidden of ['child_process', 'eval(', 'new Function', 'execSync']) {
  forbid(forbidden, router, `router must stay a pure decision component: ${forbidden}`)
}

// Importance must never bind an executor: the affinity tables are keyed by
// executor and task type only.
require('TASK_TYPE_AFFINITY: Record<Zero3RoutingExecutorId, Record<Zero3TaskType, number>>', router, 'task-type affinity table must stay importance-free')
forbid("ImportanceToExecutor", router, 'importance-to-executor bindings are forbidden')

// Historical metrics are durable and per (executor, taskClass).
require('zero3.pilot.routing-metrics.v1', metrics, 'routing metrics protocol missing')
require('p95LatencyMs', metrics, 'latency history missing')
require('successRate', metrics, 'success history missing')

// Unified dispatch: bounded failover, attempt ledger, stable task identity.
require('async dispatchAgentTask', orchestrator, 'unified dispatch_agent_task entry missing')
require('maxAttempts', orchestrator, 'attempt bound missing')
require('maxExecutorSwitches', orchestrator, 'executor-switch bound missing')
require("mode !== 'PINNED'", orchestrator, 'pinned tasks must never switch executors automatically')
require('exclusions.push', orchestrator, 'failed-executor exclusion list missing')
require('appendAttempt', orchestrator, 'attempt ledger missing')
require('appendRoutingDecision', orchestrator, 'routing decision ledger missing')
require('setResolvedTarget', orchestrator, 'resolved executor update on failover missing')
require('applyReviewerIndependence', orchestrator, 'reviewer independence enforcement missing')
require('dispatchLegacy', orchestrator, 'legacy single-shot compatibility path missing')
require("providerRuntime !== 'ZERO3_API_SESSION'", orchestrator, 'Zero3 API result runtime binding missing')

// Task identity must survive executor switches inside one task record.
require('attempts?: Zero3TaskAttemptRecord[]', taskStore, 'attempt ledger field missing')
require('routingDecisions?: Zero3IntelligentRouteDecision[]', taskStore, 'routing decision ledger field missing')
require('attemptId: string', taskStore, 'attempt identity missing')

// Explicit executor choice must reach the orchestrator: the desktop bridge
// accepts every resolved target.
require("'CODEX', 'GEMINI', 'CLAUDE', 'ZERO3_API', 'AUTO'", bridge, 'desktop bridge target whitelist incomplete')

// The Codex fast path stays intact: Codex remains an explicit fast-path adapter.
require('export class Zero3CodexTaskAdapter', codexAdapter, 'Codex task adapter contract changed')
require('export async function dispatchZero3CodexTask', fastPath, 'dispatch_codex_task fast path must remain untouched')

console.log('Zero3 Pilot Intelligent Agent Router architecture guard passed.')

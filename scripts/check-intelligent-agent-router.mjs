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
// P1 production executor wiring: the Zero3 API executor, its availability probe
// and the shared failure classifier.
const zero3ApiAdapter = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/zero3-api-task-adapter.ts', 'utf8')
const zero3ApiAvailability = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/zero3-api-availability.ts', 'utf8')
const executorFailure = fs.readFileSync('apps/zero3-desktop/agent-routing-runtime/zero3-executor-failure.ts', 'utf8')
const zero3ApiApply = fs.readFileSync('apps/zero3-desktop/scripts/apply-agent-zero3-api-runtime.mjs', 'utf8')

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

// Zero3 API is a real production executor: a task adapter over the existing
// session-provider runtime (no second model API runtime) plus a probe that
// reports registration, authentication, quota, rate limits and latency.
require('export class Zero3Zero3ApiTaskAdapter', zero3ApiAdapter, 'Zero3 API task adapter contract missing')
require("providerRuntime: 'ZERO3_API_SESSION'", zero3ApiAdapter, 'Zero3 API result runtime binding missing')
require("executorId: `ZERO3_API:", zero3ApiAdapter, 'Zero3 API executor id must name the concrete profile')
require("sandbox: 'read-only'", zero3ApiAdapter, 'the Zero3 API executor must stay read-only')
require('parseZero3ApiStructuredOutput', zero3ApiAdapter, 'structured Zero3 API result parsing missing')
require('usage:', zero3ApiAdapter, 'Zero3 API usage reporting missing')
require('timing:', zero3ApiAdapter, 'Zero3 API timing reporting missing')
require('export class Zero3Zero3ApiAvailabilityProbe', zero3ApiAvailability, 'Zero3 API availability probe missing')
require("'unregistered'", zero3ApiAvailability, 'an unconfigured provider must be typed, never silently offline')
require('quotaExhausted', zero3ApiAvailability, 'quota probe missing')
require('rateLimited', zero3ApiAvailability, 'rate-limit probe missing')
require('latencyMs', zero3ApiAvailability, 'latency probe missing')
// One failure taxonomy, one statistics truth source.
require("from '../executor-runtime/failure-normalizer'", executorFailure, 'the executor failure taxonomy must be reused')
for (const invented of ['failureCode', 'FailureCode =']) {
  forbid(`Zero3Executor${invented}`, executorFailure, 'a parallel executor failure taxonomy is forbidden')
}
// Statistics stay in the routing metrics store: the probe reads it instead of
// keeping a second success/latency ledger of its own.
for (const forbidden of ['successRate', 'verificationPassRate', 'attempts:']) {
  forbid(forbidden, zero3ApiAdapter, `the Zero3 API executor must not keep its own statistics: ${forbidden}`)
  forbid(forbidden, zero3ApiAvailability, `the Zero3 API probe must not keep its own statistics: ${forbidden}`)
}
require('metrics', zero3ApiAvailability, 'the availability probe must read the shared routing metrics')
for (const forbidden of ['child_process', 'require(', 'fetch(', 'apiKey', 'authorization']) {
  forbid(forbidden, zero3ApiAdapter, `the Zero3 API adapter must not reach providers or secrets directly: ${forbidden}`)
}

// The production host must bind the executor, the probe and the availability
// state; a router entry without a wired adapter is a dead code path.
require('Zero3Zero3ApiTaskAdapter', zero3ApiApply, 'production Zero3 API adapter composition missing')
require('zero3Api: zero3Zero3ApiTaskAdapter,', zero3ApiApply, 'production orchestrator must receive the Zero3 API dispatcher')
require('zero3Api: zero3ApiAvailability', zero3ApiApply, 'production availability probe must feed the router')
require('zero3Zero3ApiAvailabilityProbe.probe()', zero3ApiApply, 'production availability probe is not called')
require("sandbox: 'read-only'", zero3ApiApply, 'the production Zero3 API turn must run read-only')
require('zero3ApiAgentRunTurn', zero3ApiApply, 'the Zero3 API executor must reuse the session-provider bridge')
for (const forbidden of ['child_process', 'shell: true', 'execSync']) {
  forbid(forbidden, zero3ApiApply, `the Zero3 API executor overlay must not introduce shell access: ${forbidden}`)
}

console.log('Zero3 Pilot Intelligent Agent Router architecture guard passed.')

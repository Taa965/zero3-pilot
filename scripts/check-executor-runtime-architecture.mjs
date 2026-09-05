import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const runtimeRoot = path.join(root, 'apps', 'zero3-desktop', 'executor-runtime')

function read(file) {
  return fs.readFileSync(path.join(runtimeRoot, file), 'utf8')
}

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message)
}

function forbidText(source, needle, message) {
  if (source.includes(needle)) throw new Error(message)
}

const types = read('executor-types.ts')
const manager = read('executor-manager.ts')
const registry = read('executor-registry.ts')
const router = read('executor-router.ts')
const failures = read('failure-normalizer.ts')

requireText(types, "'zero3.pilot.executor.v1'", 'R4A executor contract version is missing.')
requireText(types, 'interface Zero3Executor', 'Stable Zero3-owned executor interface is missing.')
requireText(types, 'taskId: string', 'Task identity must remain owned by Zero3 Pilot.')
requireText(types, 'executionId: string', 'Execution identity must remain owned by Zero3 Pilot.')
requireText(types, 'fencingToken: number', 'Executor contract must be able to preserve Remote Host fencing identity.')
requireText(types, 'respondPermission', 'Executor contract must provide a Zero3-owned permission response path.')
requireText(manager, 'startFromHandoff', 'Executor Manager must expose an explicit fresh-session cross-provider handoff entrance.')
requireText(failures, 'EXECUTOR_FAILURE_CODES', 'Runtime failure validation must be owned by the Zero3 Pilot failure taxonomy.')
for (const event of [
  'message',
  'reasoning',
  'plan',
  'tool.started',
  'tool.updated',
  'tool.completed',
  'file.changed',
  'permission.requested',
  'usage.updated',
  'failure',
  'completed'
]) {
  requireText(types, `'${event}'`, `Executor event contract is missing: ${event}`)
}
for (const code of [
  'quota_exhausted',
  'rate_limited',
  'auth_required',
  'provider_overloaded',
  'provider_error',
  'context_exhausted',
  'budget_exhausted',
  'user_stopped',
  'permission_denied',
  'policy_denied',
  'bad_request',
  'unsupported',
  'transport_lost',
  'process_crash',
  'context_lost',
  'internal_error'
]) {
  requireText(types, `'${code}'`, `Executor failure taxonomy is missing: ${code}`)
}

requireText(manager, 'ZERO3_EXECUTOR_CONTRACT', 'Executor Manager must pass the stable Zero3-owned contract to executors.')
requireText(manager, 'identitySnapshot', 'Executor Manager must snapshot task identity before delegation.')
requireText(manager, 'task execution already has an active executor session', 'Executor Manager must reject duplicate active authority for one task execution.')
requireText(manager, 'permission request is not pending for this task execution', 'Permission responses must be correlated to observed pending requests.')
requireText(manager, 'does not allow session-wide approval', 'Session approval must be constrained by the exact pending permission request.')
requireText(manager, 'isExecutorFailure(event.failure)', 'Executor Manager must reject provider-defined failure codes before exposing events.')
requireText(manager, 'event.failure.source !== binding.executorId', 'Provider failure provenance must match the executor bound to the task execution.')
requireText(registry, 'executor already registered', 'Executor Registry must reject duplicate executor ids.')
requireText(router, 'isExecutorFailure(failure)', 'Executor Router must validate runtime failure payloads before deriving failover candidates.')
requireText(router, 'failurePolicyFor(failure.code)', 'Router safety must derive from core failure code policy, not provider-declared failover metadata.')
requireText(failures, "'permission_denied'", 'permission_denied policy guard is missing.')
requireText(failures, "'policy_denied'", 'policy_denied policy guard is missing.')
requireText(failures, "'bad_request'", 'bad_request fail-closed policy guard is missing.')
requireText(failures, "'budget_exhausted'", 'task budget exhaustion must not be bypassed by automatic executor switching.')
requireText(failures, "'user_stopped'", 'user cancellation must not be converted into automatic executor switching.')
requireText(failures, "'provider_error'", 'generic provider failures must have a frozen provider-neutral failure code.')
requireText(failures, "const IMMEDIATE_FAILOVER_FAILURES = new Set<ExecutorFailureCode>(['quota_exhausted'])", 'Only quota exhaustion may be marked as an immediate failover class in R4A.')
requireText(failures, "return createExecutorFailure('internal_error', message, source)", 'Unknown provider errors must be normalized without retaining raw exception objects.')
forbidText(types, 'cause?: unknown', 'ExecutorFailure must not expose raw provider exception objects across the shared Core boundary.')
forbidText(failures, 'source, cause', 'Failure normalization must not retain raw provider exception objects.')
requireText(failures, "'forbidden'", 'Forbidden automatic-failover disposition is missing.')
requireText(failures, 'KNOWN_FAILURE_CODES.has', 'Provider-defined unknown failure codes must not enter core routing policy.')

for (const [name, source] of [
  ['executor-types.ts', types],
  ['executor-manager.ts', manager],
  ['executor-registry.ts', registry],
  ['executor-router.ts', router],
  ['failure-normalizer.ts', failures]
]) {
  for (const forbidden of [
    '@agentclientprotocol',
    'agentclientprotocol/',
    'acpx',
    'claude-agent',
    'openhands',
    'open-hands',
    'goose/',
    "from 'node:child_process'",
    'spawn(',
    'execFile(',
    'ipcRenderer',
    'Zero3CodexAppServer',
    'zero3:codex:rpc',
    'zero3:codex:proxy',
    'http://',
    'https://'
  ]) {
    forbidText(source.toLowerCase(), forbidden.toLowerCase(), `${name} violates the R4A Executor Core boundary: ${forbidden}`)
  }
}

for (const premature of ['retryBudget', 'circuitBreaker', 'cooldownUntil', 'automaticSwitch']) {
  forbidText(router, premature, `R4A must not implement R4F automatic routing policy yet: ${premature}`)
  forbidText(manager, premature, `R4A must not implement R4F automatic routing policy yet: ${premature}`)
}

console.log('Zero3 Pilot R4A Executor Core architecture guard passed: stable Zero3-owned contract, explicit handoff and approval boundaries, one task/execution authority, complete provider-neutral failure taxonomy, sanitized and provenance-bound failure boundary, fail-closed provider event validation, and no premature R4F auto-failover runtime.')

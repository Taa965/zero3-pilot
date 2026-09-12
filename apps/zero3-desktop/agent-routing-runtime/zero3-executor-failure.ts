import { EXECUTOR_FAILURE_CODES, failurePolicyFor } from '../executor-runtime/failure-normalizer'
import type { ExecutorFailureCode } from '../executor-runtime/executor-types'
import type { Zero3ExecutionFailure, Zero3ExecutorFailureClass } from './agent-contracts'

// The executor failure taxonomy already exists (executor-runtime); the routing
// plane only adds the *decision* each code implies, so classification stays a
// single source of truth instead of a second parallel error system.
//
//   retry_same_executor -> the executor is not at fault; keep it eligible
//   reroute             -> exclude/blame the executor and continue elsewhere
//   waiting_human       -> a human decision is required; never auto-switch
//   terminal            -> the task ends
//   outcome_unknown     -> recovery reconciler owns the task
const FAILURE_CLASS_BY_CODE: Record<ExecutorFailureCode, Zero3ExecutorFailureClass> = {
  quota_exhausted: 'reroute',
  rate_limited: 'reroute',
  provider_overloaded: 'reroute',
  transport_lost: 'reroute',
  process_crash: 'reroute',
  context_exhausted: 'reroute',
  // The provider answered, but not usably: re-running this executor is the
  // cheapest correct next step, so the executor is not excluded.
  provider_error: 'retry_same_executor',
  internal_error: 'retry_same_executor',
  // A missing credential is a provider condition for this task: another
  // executor may hold the credential the task needs, so the task continues.
  auth_required: 'reroute',
  // The executor cannot do this kind of work (its tools are not enough for the
  // objective). That is a routing problem, not a human decision: continue with
  // an executor whose capabilities cover the task.
  unsupported: 'reroute',
  budget_exhausted: 'waiting_human',
  permission_denied: 'waiting_human',
  policy_denied: 'waiting_human',
  bad_request: 'terminal',
  user_stopped: 'terminal',
  // The provider may already have executed work; Zero3 must reconcile the
  // authoritative Git/artifact evidence before trying anyone else.
  context_lost: 'outcome_unknown'
}

export const ZERO3_EXECUTOR_FAILURE_CODES = EXECUTOR_FAILURE_CODES

export function failureClassFor(code: ExecutorFailureCode): Zero3ExecutorFailureClass {
  return FAILURE_CLASS_BY_CODE[code] ?? 'retry_same_executor'
}

export function createExecutorFailure(code: ExecutorFailureCode, detail: string): Zero3ExecutionFailure {
  const failureClass = failureClassFor(code)
  return {
    code,
    class: failureClass,
    // Another attempt is legal for both routable classes; for a same-executor
    // retry the existing taxonomy still decides whether retrying is sensible.
    retryable: failureClass === 'reroute'
      || (failureClass === 'retry_same_executor' && failurePolicyFor(code).retryable),
    detail
  }
}

// Provider text -> existing executor failure code. Transport/auth/quota/rate
// conditions are matched before generic provider errors, and the patterns stay
// deliberately narrow: a misclassified failure changes who runs the task.
export function executorFailureCodeFromMessage(message: string): ExecutorFailureCode {
  const value = message.toLowerCase()
  if (/(econnrefused|enotfound|eai_again|socket hang up|transport lost|transport_lost|connection (lost|refused|reset)|network error|fetch failed|网络|无法连接|连接已关闭|传输)/.test(value)) return 'transport_lost'
  if (/(401|403|unauthor|invalid api key|no api key|api key|认证|未授权|login|登录)/.test(value)) return 'auth_required'
  if (/429|rate limit|too many requests|限流|频率/.test(value)) return 'rate_limited'
  if (/quota|usage_limit|insufficient|balance|credit|余额|额度|欠费/.test(value)) return 'quota_exhausted'
  if (/overload|overloaded|busy|服务器繁忙|过载|capacity/.test(value)) return 'provider_overloaded'
  if (/context (window|length)|context_exhausted|token limit|上下文/.test(value)) return 'context_exhausted'
  if (/context_lost|outcome unknown|不可恢复/.test(value)) return 'context_lost'
  if (/budget/.test(value)) return 'budget_exhausted'
  if (/(permission denied|permission_denied|权限)/.test(value)) return 'permission_denied'
  if (/(policy|denied by policy|策略)/.test(value)) return 'policy_denied'
  if (/(not supported|unsupported|不支持)/.test(value)) return 'unsupported'
  if (/bad request|invalid request|参数错误/.test(value)) return 'bad_request'
  if (/(crash|崩溃|process exited|exited with code)/.test(value)) return 'process_crash'
  if (/(timeout|timed out|超时|abort|etimedout)/.test(value)) return 'transport_lost'
  if (/(empty|malformed|non-json|非 json|解析|没有返回)/.test(value)) return 'provider_error'
  return 'provider_error'
}

export function classifyExecutorError(error: unknown): Zero3ExecutionFailure {
  const message = error instanceof Error ? error.message : String(error)
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 2_000) || 'executor failed without a provider message'
  const declared = declaredFailureFrom(error)
  return createExecutorFailure(declared ?? executorFailureCodeFromMessage(detail), detail)
}

// An executor that already classified its own failure keeps its code; the
// source of that classification is the executor, not a string match here.
function declaredFailureFrom(error: unknown): ExecutorFailureCode | null {
  if (!error || typeof error !== 'object') return null
  const candidate = (error as { failure?: { code?: unknown } }).failure?.code
  if (typeof candidate === 'string' && (EXECUTOR_FAILURE_CODES as readonly string[]).includes(candidate)) {
    return candidate as ExecutorFailureCode
  }
  return null
}

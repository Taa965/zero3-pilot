import type {
  ExecutorFailure,
  ExecutorFailureCode,
  ExecutorFailurePolicy,
  ExecutorId
} from './executor-types.ts'

export const EXECUTOR_FAILURE_CODES = [
  'quota_exhausted',
  'rate_limited',
  'auth_required',
  'provider_overloaded',
  'context_exhausted',
  'budget_exhausted',
  'permission_denied',
  'policy_denied',
  'bad_request',
  'unsupported',
  'transport_lost',
  'process_crash',
  'context_lost',
  'internal_error'
] as const satisfies readonly ExecutorFailureCode[]

const KNOWN_FAILURE_CODES = new Set<string>(EXECUTOR_FAILURE_CODES)
const RETRYABLE_FAILURES = new Set<ExecutorFailureCode>([
  'rate_limited',
  'provider_overloaded',
  'transport_lost',
  'process_crash',
  'internal_error'
])

const IMMEDIATE_FAILOVER_FAILURES = new Set<ExecutorFailureCode>(['quota_exhausted', 'unsupported'])
const FORBIDDEN_FAILOVER_FAILURES = new Set<ExecutorFailureCode>([
  'budget_exhausted',
  'permission_denied',
  'policy_denied',
  'bad_request'
])

export function failurePolicyFor(code: ExecutorFailureCode): ExecutorFailurePolicy {
  return {
    retryable: RETRYABLE_FAILURES.has(code),
    failover: FORBIDDEN_FAILOVER_FAILURES.has(code)
      ? 'forbidden'
      : IMMEDIATE_FAILOVER_FAILURES.has(code)
        ? 'eligible'
        : 'conditional'
  }
}

export function createExecutorFailure(
  code: ExecutorFailureCode,
  message: string,
  source: ExecutorId | 'executor-core',
  cause?: unknown
): ExecutorFailure {
  return { code, message, source, cause }
}

export function normalizeUnknownExecutorFailure(
  error: unknown,
  source: ExecutorId | 'executor-core' = 'executor-core'
): ExecutorFailure {
  if (isExecutorFailure(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return createExecutorFailure('internal_error', message, source, error)
}

export function isExecutorFailure(value: unknown): value is ExecutorFailure {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ExecutorFailure>
  return (
    typeof candidate.code === 'string' &&
    KNOWN_FAILURE_CODES.has(candidate.code) &&
    typeof candidate.message === 'string' &&
    typeof candidate.source === 'string'
  )
}

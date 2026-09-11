# Zero3 Intelligent Agent Task Router

This document describes the merged `main` capability that lets Zero3 decide **who executes a task**, instead of hard-binding important work to Codex. Codex remains the native Agent Kernel and one executor among several; the router treats CLAUDE, ZERO3_API, GEMINI and future registry members as peers selected by evidence, not importance.

## 1. Principle

> Task importance scales **verification, review and failure policy** — never the executor.

A critical task may be executed by Claude, verified through Codex `command/exec` evidence, and reviewed by Web GPT. The routing layer is additive: the legacy single-shot path and the Web GPT Fast Path (`dispatch_codex_task`) are preserved unchanged.

## 2. Where it lives

```text
User / Task Runtime
        ↓
Zero3AgentRuntimeOrchestrator.dispatchAgentTask()   (unified dispatch entry)
        ↓
Zero3IntelligentTaskRouter.route()                  (decision only — no execution)
        ↓  capability / availability / task-type / context / latency / cost / history
Zero3IntelligentRouteDecision                       (structured, auditable)
        ↓
registered task adapters (Codex / Gemini / Claude / Zero3 API)
        ↓
Zero3VerificationCollector + authoritative result finalizer
        ↓
success | bounded failover → re-route with exclusions
```

Responsibilities stay separated:

- **Router** decides (`intelligent-router.ts`) and never spawns anything;
- **Adapters** call providers (`claude-task-adapter.ts`, `codex-task-adapter.ts`, orchestrator ports);
- **Orchestrator** owns the lifecycle, retry/failover bounds and ledger writes;
- **Task store** is the authoritative Task Ledger;
- **Verification** runs through the existing `Zero3VerificationCollector` / finalizer / review loop.

## 3. Routing modes

| Mode | Meaning |
| --- | --- |
| `AUTO` | Zero3 selects the best eligible executor by composite score. |
| `PINNED` | The TaskSpec names the executor (`target: 'CODEX' | 'GEMINI' | 'CLAUDE' | 'ZERO3_API'`). The router fails closed (`PINNED_EXECUTOR_UNAVAILABLE`) instead of silently switching, and no automatic failover runs. |
| `PREFERRED` | Opt-in via dispatch context (`preferredExecutor` or `routingMode: 'PREFERRED'`): the requested executor is honored when eligible; otherwise the router falls back to the best scored executor. |

Mode resolution: an explicit TaskSpec target dispatches `PINNED` (default) or `PREFERRED` (when requested in the dispatch context); `target: 'AUTO'` dispatches `AUTO` unless a preferred executor is given.

## 4. Scoring model

Capability is a **hard filter**: an executor missing a required capability (derived from the task type plus explicit `requiredCapabilities`) is never selected, whatever its other factors look like. Availability is likewise a hard filter: offline, known-unauthenticated, rate-limited, quota-exhausted, overloaded and unregistered executors are excluded and recorded as rejections.

The remaining factors are weighted (`intelligent-router.ts`):

| Factor | Weight | Source |
| --- | --- | --- |
| taskType affinity | 0.28 | executor × task-type affinity table |
| historicalSuccess | 0.22 | `Zero3RoutingMetricsStore` per `(executor, taskClass)`: success rate + verification pass rate |
| contextAffinity | 0.18 | catalog profile (live context the executor already holds) |
| availability | 0.12 | probe result (authenticated probes score higher than unproven ones) |
| latency | 0.10 | catalog latency profile + metrics p50/p95 history |
| cost | 0.10 | catalog cost profile + recorded cost history |

The default catalog ships capability/effort profiles for `CODEX`, `GEMINI` (Antigravity), `CLAUDE` and `ZERO3_API` (profile-based model session: reasoning/review/research capabilities, no repository write). Hosts may override catalog entries through `Zero3IntelligentTaskRouter({ catalogOverrides })`. The affinity tables are keyed by executor and task type only — importance never appears, so importance cannot bind an executor.

## 5. Metrics store

`Zero3RoutingMetricsStore` persists per `(executor, taskClass)` samples (success, verification pass, latency, cost, failover flag) in a durable JSON store and derives success/verification rates and p50/p95 latency for the router. Missing history is a neutral prior (0.5), never a penalty. Metrics failures never break dispatch.

## 6. Failover

On a retryable failure (executor error, or a `FAILED` result) the orchestrator re-routes with the failed executor **excluded**, up to:

- `maxAttempts` (default 3, including the first attempt);
- `maxExecutorSwitches` (default 2).

Not switchable (the task stays with human/recovery authority):

- `BLOCKED` results (auth/permission/policy/context gates) — waiting human;
- `OUTCOME_UNKNOWN` results — owned by the `Zero3AgentRecoveryController`;
- `PINNED` tasks — a pinned failure is surfaced, never silently re-routed.

Every re-route produces a fresh structured decision recorded on the task, so the failover chain (`CODEX → quota exhausted → CLAUDE`) is fully auditable.

## 7. Verification profiles

`verificationProfileFor(importance)` maps `low → low`, `normal → standard`, `high → high`, `critical → critical`:

- **low** — executor self-checks suffice;
- **standard** — TaskSpec verification commands run through the authoritative collector;
- **high** — independent verifier required; reviewer must differ from the executor;
- **critical** — executor, verifier and reviewer must not collapse into one model; cross-model review enforced.

Enforcement point that ships today: the orchestrator re-maps a `CODEX` reviewer on a `CODEX` execution to `GPT_WEB` whenever the profile requires a distinct reviewer. The recorded profile drives the existing verification collector, completion gate and review loop; deeper independent-verifier orchestration plugs into the same profile without contract changes.

## 8. Task Ledger

`Zero3AgentTaskRecord` gains additive, optional observability fields (old records load unchanged):

```text
Task #<taskId>                     ← identity never changes across executors
  routingDecisions[]               ← every structured routing decision
  attempts[]                       ← one record per executor attempt
    attempt 1: CODEX    FAILED  failureReason="usage_limit_exceeded…" failoverReason="…"
    attempt 2: CLAUDE   SUCCEEDED
  result / resolvedTarget          ← final authoritative result + owning executor
  importance / verificationProfile
```

Attempts append under the same `taskId`/`executionId`; a switch updates `resolvedTarget` instead of creating a new task. Handoff/shared-memory behavior is untouched (executor-level handoff remains the R4E verified-handoff layer).

## 9. Compatibility and security

- `dispatch()` keeps its exact signature; without `intelligentRouting` configured it behaves exactly as before, and the Web GPT Fast Path `dispatch_codex_task` / `task_bootstrap` / `verify_commit` are untouched.
- The desktop bridge now accepts explicit `CLAUDE`/`ZERO3_API` targets (previously rejected) and validates optional routing context fields.
- The router is a pure decision component: no child processes, no shell, no network. Every executor still runs through its own reviewed adapter; workspace allow-lists, control-plane boundaries and the completion gate are unchanged.
- Guard: `node scripts/check-intelligent-agent-router.mjs` (CI lane `r4a-executor-contract.yml`).

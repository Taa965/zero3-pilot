# R4I Remote Host → Executor Manager integration audit

Status: **AUDIT / TEST-DESIGN ONLY**

Session owner: **Session 6 — Remote Host Integration**  
Branch: `feat/r4i-remote-executor-events`  
Audit base: `9f11c6e8c88283dbcaf8cc51e6a6fb35c5f25f7f`  
Implementation gate: **BLOCKED until R4A Executor Contract, R4E Handoff, and R4F Router contracts are frozen by the integration controller.**

This document records the current H0–H5 Remote Host seam and the exact invariants/tests that R4I must preserve when `RemoteTaskRunner` is moved behind `ExecutorManager`. It deliberately makes no runtime behavior changes and introduces no provisional Executor/Handoff types.

## 1. Current authority boundary

Current path on this baseline:

```text
RemoteTask
  -> Zero3RemoteNode
  -> Zero3RemoteTaskRunner
  -> Zero3CodexRuntime
       -> startThread
       -> startTurn
       -> readThread
```

`Zero3RemoteTaskRunner` owns RemoteTask validation, workspace allow-list enforcement, task fingerprinting, durable task→Codex mapping, duplicate-turn recovery and terminal observation. It currently accepts a narrow `Zero3CodexRuntime` interface with only `startThread`, `startTurn`, and `readThread`.

The future R4I path must be:

```text
RemoteTask
  -> Zero3RemoteNode
  -> Zero3RemoteTaskRunner
  -> ExecutorManager
  -> selected Executor
```

Native Codex must remain a typed executor adapter that internally uses the existing narrow Codex app-server operations. R4I must not recreate an agent loop, shell executor, scheduler, approval system, sandbox or provider-specific runtime inside `host-runtime`.

## 2. Existing Remote Host invariants that are non-negotiable

### Task identity

The following identities are control-plane authority and must remain unchanged across executor selection and handoff:

- `task_id`
- `execution_id`
- `lease_id`
- `fencing_token`

A repeated `task_id` with a different `execution_id`, payload fingerprint or workspace must continue to fail closed.

### Lease / fencing

Executor selection must happen only while the current host lease is valid. A stale lease/fencing rejection must continue to quarantine the relevant durable envelope and must prevent further task-side effects where the current implementation already fails closed.

### Durable outbox ordering

The current outbox provides:

- durable local persistence before publish;
- monotonically increasing `eventSequence` per `(taskId, executionId)`;
- event-before-terminal ordering for the same task/execution;
- replay after restart;
- quarantine for stale lease/fencing rejection;
- terminal durability independent of immediate network delivery.

R4I executor/handoff events must use this existing outbox. They must not add a second event store or bypass `Zero3RemoteOutbox`.

### Terminal idempotency

A task still has one terminal result from H5's perspective. Executor generations/handoffs are evidence inside the same task execution, not separate remote tasks and not additional terminal records.

### Permission / sandbox authority

Remote Host must continue to fail closed. Executor selection or handoff must never widen approval/sandbox permissions, and permission/policy failures must not be converted into provider failover by host-runtime.

## 3. Event contract required by R4I

R4I must project the following evidence through the existing generic Remote Host event envelope:

```text
executor.selected
executor.failed
handoff.created
executor.switched
handoff.verified
executor.completed
```

These events must remain ordinary H5 ordered task events with the original:

```text
taskId
executionId
leaseId
fencingToken
eventSequence
```

No executor or handoff event is allowed to become an independent terminal authority.

### Minimum payload requirements

The frozen upstream contracts should provide enough typed data to populate these payloads without importing provider-private types into H5.

`executor.selected`

- executor id / kind
- executor generation
- selection reason (manual / policy / recovery where applicable)

`executor.failed`

- executor id / generation
- normalized failure kind
- retryability / failover eligibility as decided by R4F
- no raw secret/token/provider-private object

`handoff.created`

- handoff id
- from generation / requested target generation
- workspace fingerprint or checkpoint reference from R4E

`executor.switched`

- from executor/generation
- to executor/generation
- handoff id

`handoff.verified`

- handoff id
- verified generation
- verifier result / checkpoint hash sufficient for audit

`executor.completed`

- executor id / generation
- executor-level completion classification
- does **not** replace H5 terminal result

## 4. Contracts Session 6 needs before implementation

Session 6 must not invent these symbols. The integration controller must freeze their actual names/signatures after R4A/R4E/R4F merge.

### From R4A / R4F

Required capabilities, regardless of final symbol names:

```text
ExecutorManager.execute/resume remote task intent
selected executor metadata
typed executor event stream or callback
normalized executor failure
executor generation identity
cancel/interrupt surface
manual/automatic switch outcome
```

The manager must remain the single selection/router authority. `host-runtime` must not duplicate fallback-chain, retry-budget, circuit-breaker or cooldown logic.

### From R4E

Required capabilities:

```text
handoff id
generation
workspace/checkpoint fingerprint
handoff created notification
handoff verification result
proof that next executor is not allowed to write before HANDOFF_ACCEPTED / verified gate
```

`host-runtime` observes and publishes handoff evidence; it does not implement provider-specific handoff semantics.

## 5. Proposed R4I integration shape after contract freeze

The preferred change is a narrow adapter local to `host-runtime` rather than importing the whole executor-runtime internals into `remote-node.ts`.

Target decomposition:

```text
remote-node.ts
  - owns lease lifecycle, outbox, publication, terminal durability
  - passes the leased RemoteTask to runner

remote-task-runner.ts
  - owns RemoteTask validation / workspace admission / task-level correlation
  - invokes a narrow ExecutorManager-facing adapter
  - observes typed executor/handoff lifecycle events
  - returns one task-level terminal outcome

remote-executor-adapter.ts (name provisional until contract freeze)
  - translates Zero3RemoteTask into frozen Executor Contract input
  - translates frozen typed lifecycle events into host-runtime evidence payloads
  - contains no routing policy and no provider-private types
```

The existing `Zero3CodexRuntime` seam should disappear from the RemoteTaskRunner constructor only after the Native Codex executor is proven to preserve the same narrow app-server behavior through ExecutorManager.

## 6. Mandatory test matrix for the implementation PR

### A. Identity preservation

1. `task_id` and `execution_id` are identical before and after executor selection.
2. Handoff generation changes do not create another H5 task/execution.
3. Duplicate submit/resume does not start a duplicate executor execution.
4. Reusing a task id with a different execution id/payload/workspace remains blocked.

### B. Lease / fencing

1. Executor side effects do not start when `host.accepted` cannot be durably correlated/published under a valid lease.
2. Stale fencing during executor execution prevents subsequent local evidence publication and quarantines stale envelopes according to the existing rule.
3. Lease renewal failure does not silently start another executor generation.
4. A restarted host does not resume an execution under a different fencing token without the normal H5 lease path.

### C. Outbox ordering

For one task/execution, assert durable ordering across:

```text
host.accepted
executor.selected
handoff.created
executor.switched
handoff.verified
executor.completed
terminal
```

Also verify restart/replay preserves sequence numbers and terminal remains after all earlier events.

### D. Executor failure semantics

Fixtures required from R4F/R4B/R4C:

- quota exhausted;
- rate limit after retry budget;
- provider unavailable;
- ACP subprocess crash;
- permission denied;
- policy denied;
- context loss.

Assertions:

- host-runtime publishes normalized `executor.failed` evidence;
- host-runtime does not decide fallback eligibility itself;
- permission/policy failure cannot be failover-enabled by Remote Host;
- context loss cannot silently create a new provider session.

### E. Handoff gate

1. `handoff.created` is emitted before any switched executor can mutate the workspace.
2. `executor.switched` and `handoff.verified` reflect the frozen R4E lifecycle ordering.
3. Workspace fingerprint mismatch fails closed and reaches one H5 terminal result.
4. Pending approval blocks unsafe handoff continuation.
5. Crash between handoff creation and verification is restart-recoverable without duplicate writes.

### F. Terminal idempotency

1. Exactly one H5 terminal envelope is produced for success.
2. Exactly one H5 terminal envelope is produced for final failure/block/outcome_unknown.
3. Replaying executor/handoff events never creates a second terminal.
4. Network failure after local terminal persistence replays the same terminal rather than executing the task again.

### G. Native Codex regression

After migration through ExecutorManager, verify the Native Codex path still preserves:

- current sandbox / approval behavior;
- typed app-server operations rather than generic RPC;
- no host-owned shell execution authority;
- restart-safe no-duplicate behavior;
- real thread/turn evidence available through the Native executor's own typed metadata where required.

## 7. H5 compatibility observation

The current H5 event envelope already carries an opaque string `event_type` and arbitrary JSON `payload`, so the six R4I lifecycle events should not require a second H5 event transport. Any `apps/web` change should therefore be limited to validation/contract tests or deliberately typed presentation fields proven necessary by the frozen UI/contract, while retaining H5's lease/fencing/event-sequence checks.

## 8. Implementation stop conditions

Stop and escalate to the integration controller if implementation would require any of the following:

- changing another session's executor/handoff core types directly;
- duplicating ExecutorManager routing policy in Remote Host;
- creating a second durable execution/event authority;
- weakening permission/sandbox semantics;
- bypassing H5 lease/fencing/outbox ordering;
- copying auth/provider credentials into Remote Host events;
- treating failed resume/handoff verification as permission to silently start a new session;
- modifying the task/execution identity model.

## 9. Session 6 readiness state

```text
current_audit_base: 9f11c6e8c88283dbcaf8cc51e6a6fb35c5f25f7f
runtime_changes: none
executor_contract: not frozen
handoff_contract: not frozen
router_contract: not frozen
ready_for_wave4: no
next_action: re-read current main and frozen R4A/R4E/R4F contracts after BASELINE FREEZE, then implement only the adapter + evidence projection + regression tests described above
```

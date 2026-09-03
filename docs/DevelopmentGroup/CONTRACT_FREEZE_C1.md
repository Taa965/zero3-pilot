# Development Group V1 — Contract Freeze C1

Status: **FROZEN**

Baseline: `c912f17e109b1710fe56b94bb289df546af597f9` on `integration/development-group-v1`.

This contract freeze establishes the public types consumed by P01-P13. Implementations may add private helpers but must not mutate these contracts without an Interface Change Request reviewed by P99.

## Frozen contracts

```text
zero3.pilot.development-group.v1
zero3.pilot.development-session.v1
zero3.pilot.development-delivery.v1
zero3.pilot.group-completion-proof.v1
zero3.pilot.development-protocol.v1
```

## Authority hierarchy

```text
DevelopmentGroup
  -> DevelopmentSession
  -> Zero3Executor
  -> Codex Root Thread
  -> Codex native Subagents
```

Open-source Codex remains the only Native Agent Kernel. Development Group does not implement a second model/tool/approval/subagent loop.

## Identity and exactness

The following are first-class identifiers: `GroupId`, `SessionId`, `RequirementId`, `WaveId`, `IntegrationRunId`, `VerificationRunId`, and `RepairTaskId`.

A Session binds one execution identity, one exact baseline SHA, one integration ref, one branch, one worktree, one writer generation, and one eventual structured Delivery. Runtime implementations must preserve these identities across resume/handoff.

## State machines

Group states:

```text
draft planning plan_review ready running integrating verifying repairing
paused blocked waiting_approval waiting_human outcome_unknown completed cancelled failed
```

Session states:

```text
planned waiting_dependencies ready starting running waiting_input delivering delivered
integrating integrated verified paused blocked outcome_unknown failed cancelled superseded
```

`outcome_unknown` has no automatic transition back to execution. It requires human resolution, cancellation, failure, or supersession as appropriate.

## Planning invariants

A frozen plan is invalid when any of these are true:

- duplicate IDs;
- unknown/self dependencies;
- Requirement, Session, or Wave DAG cycles;
- mandatory Requirement not assigned exactly once;
- one Requirement assigned to multiple Sessions;
- exact owned-path collision across Sessions;
- one path placed in multiple ownership classes inside one Session;
- Session baseline differs from Group baseline;
- Session integration ref differs from Group integration ref;
- zero, negative, infinite, non-integer, or unsafe concurrency/attempt/repair budgets;
- recursive Development Group creation is enabled through subagent policy.

P03 is responsible for full Git-aware/glob-aware ownership validation at delivery time. C1 only freezes deterministic structural checks.

## Delivery invariants

Agent text such as `completed` is never evidence. A `zero3.pilot.development-delivery.v1` record must bind exact Group/Session/execution identity, base SHA, distinct head SHA, changed paths, Requirement coverage, test evidence, Handoff checkpoint when required, and a delivery hash. P03 adds Git/Handoff proof before a Delivery becomes integration-eligible.

## Verification and completion

Verification evidence binds to an exact integration SHA. `GroupCompletionProof` is fail-closed. A Group cannot complete while any mandatory Requirement lacks Verified/explicit-Waived evidence, any referenced Delivery is invalid, integration is not clean, required verification has not passed, blockers remain, or `outcomeUnknownCount > 0`.

An explicit waiver requires approver, timestamp, reason, and evidence; waiver support does not silently convert failed verification into PASS.

## Security / architectural red lines

- no generic Renderer -> Codex RPC;
- no Zero3 replacement Agent Loop or Subagent Manager;
- no silent approval escalation;
- no blind retry of OutcomeUnknown;
- no provider-private type leakage into Group Core;
- external providers, when later enabled, remain behind `Zero3Executor`;
- existing `zero3.pilot.handoff.v1` remains the handoff authority.

## Validation status

Contract tests were authored with Node's `node:test` API. Under the current ChatGPT-web workflow, Linux/Windows execution is **NOT_RUN**; P00 status is based on static contract/code review only until an external runtime executes them.

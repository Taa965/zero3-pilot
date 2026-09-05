# P00 — Development Group Contract Freeze

Status: `READY_FOR_INTEGRATION_REVIEW`

Base SHA: `c912f17e109b1710fe56b94bb289df546af597f9`

## Delivered

- frozen Group / Session / Delivery / Completion Proof protocol constants;
- DTOs for Group, Requirement, Wave, Session, Delivery, Integration, Verification, Failure, Repair, Completion and Event Ledger;
- explicit Group and Session state transition tables;
- deterministic structural validators for IDs, DAGs, mandatory assignment, ownership classes/collisions, exact baselines and bounded budgets;
- Delivery identity/scope validator;
- fail-closed Completion Proof validator;
- JSON Schema documents for the four externally persisted contracts;
- contract-level Node test fixtures.

## Public interfaces

`apps/zero3-desktop/group-runtime/contracts/index.ts` is the C1 public import surface.

## Architecture

No Agent Loop, Subagent Registry, Codex RPC, Executor implementation, Handoff implementation, Scheduler, filesystem runtime or UI was introduced.

## Test status

- static contract/code review: completed by P99 web session;
- Node contract tests: `NOT_RUN` under current ChatGPT-web execution policy;
- Windows product/runtime acceptance: `NOT_RUN` and intentionally deferred.

## Risks / follow-up

- P03 must implement Git/glob-aware ownership semantics; P00 only rejects exact path collisions structurally.
- P09 must bind Completion Proof to durable store/integration evidence; P00 only freezes the proof contract and pure validation rules.
- Any P01-P13 need to change C1 requires an ICR; no sibling branch may mutate contracts directly.

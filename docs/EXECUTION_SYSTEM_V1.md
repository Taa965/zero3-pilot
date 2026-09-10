# Zero3 Cross-App Execution System v1

## Purpose

The Execution System is the authority for a business task that spans multiple AI sessions, applications, and computers. A Task owns a DAG of Steps. Each dispatched Step creates an Assignment which may bind to a real GPT Web, Gemini Web, Codex, Claude, Antigravity, Zero3, remote-compute, or human session.

`TaskSpecV2` remains the protocol used by development-agent executors. It is no longer required to represent the whole cross-application workflow.

## Authority model

The renderer session list is not authoritative execution state. Execution state is stored durably in the desktop main/runtime layer. The v1 durable snapshot contains the workflow definition plus task/step runtime, assignments, and session bindings. An fsync-backed append-only event ledger provides a monotonic audit trail and a recovery signal when an event was written before the latest snapshot.

The first implementation intentionally uses the repository's existing checksum-protected durable JSON primitive instead of introducing a second persistence dependency. The snapshot format keeps a later SQLite migration behind `Zero3ExecutionStore`.

## Core objects

- `ExecutionTaskDefinition`: high-level business goal and concurrency policy.
- `ExecutionStepDefinition`: DAG node, executor target, dependencies, inputs, expected outputs, and completion-gate policy.
- `ExecutionAssignment`: one concrete attempt to execute a Step.
- `ExecutionSessionBinding`: maps an Assignment to a real application/runtime conversation.
- `ExecutionEvent`: monotonic task-local event record.
- `ExecutionRuntimeState`: authoritative mutable task and step state.

## Completion authority

An executor never directly marks its own Step `completed`. Normal completion is:

`running -> verifying -> completed`

The executor requests completion; Zero3 records `completion.requested`. Only the Completion Gate records `gate.passed` and moves the Step to `completed`. A failed gate moves it to `fix_required`, allowing the same logical work to continue or a new Assignment attempt to be dispatched.

## Scheduler

The v1 scheduler is deterministic. It validates unknown dependencies, duplicate Step IDs, self-dependencies, and cycles. A Step becomes dependency-ready only after every dependency is `completed`. Dispatch candidates are capped by `maxParallelSteps`; active `dispatching`, `running`, `waiting_report`, and `verifying` steps consume capacity.

The contract supports dynamic DAG expansion by incrementing the workflow revision and adding Steps. This is required for workflows such as visual planning that discover the eventual number of image/video production batches at runtime.

## Reporter boundary (next phase)

Web agents will report through Remote Desktop Commander into a narrow Zero3 Reporter API/CLI. DC is transport, not the execution protocol. The Reporter will be allowed to emit bounded events such as progress, artifact-produced, blocked, waiting-human, and completion-requested for its own Assignment, but it will not be allowed to set `completed`, edit another task, or mutate the durable store directly.

## Phase 1 status

Implemented in `apps/zero3-desktop/execution-runtime/`:

- cross-app contracts and executor targets;
- task/step state machines;
- deterministic DAG scheduling and concurrency gating;
- checksum-protected durable snapshot store;
- monotonic idempotent event ledger;
- runtime controller for task creation, dynamic Step expansion, Assignment creation, session binding, progress/artifact events, completion requests, gate pass/fail, and automatic dependency release.

The existing Task UI remains a demo until the later UI phase is wired to this authority.

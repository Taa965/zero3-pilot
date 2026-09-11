# Zero3 Agent Shared Organizational State MVP

## Goal

Different GPT web conversations and other agents do not share chat history. They share authoritative organizational state through Zero3:

```text
Agent Adapter
  -> Execution Task Runtime
  -> Shared Memory
  -> Artifact Registry
  -> Agent Worklog
  -> structured Handoff
```

The existing Execution Runtime remains the only Task/Step/Assignment ledger. This MVP does not create a second task system.

## Lifecycle API

The private Worker MCP exposes these lifecycle actions in addition to the V1 WorkUnit tools:

```text
session_start
context_resolve
task_claim
event_record
artifact_register
task_complete
memory_commit
handoff_create
```

The conceptual API names from the design (`session.start`, `context.resolve`, etc.) map to underscore MCP tool names because the existing Worker Gateway uses that naming convention.

## Data ownership

### Task State

Owned by `execution-runtime/`. Lifecycle hooks call its existing assignment, session-binding, progress, artifact-event and completion-request methods. `task_complete` moves work to Completion Gate verification; it cannot call `gatePassed`.

### Shared Memory / Decision

Owned by the existing Zero3 memory event system (`zero3.memory.event.v1`). Lifecycle hooks publish project/task entities such as Decision, summary, warning, next actions, Artifact and Handoff. Agent authority remains capped by the existing Memory promotion policy.

### Agent Worklog and context cursor

The lifecycle supplemental SQLite contains only:

- agent sessions;
- task claim bindings;
- Agent Worklog;
- `context_version` / change journal;
- lifecycle idempotency receipts;
- pending Shared Memory compensation events.

It deliberately has no Task status table.

### Artifact

`artifact-runtime` now supports both the existing local content-addressed file records and structured external Artifact references. Google Drive stores only `fileId`/metadata in Zero3; Drive credentials remain in the Google Drive app.

## Completion transaction / saga

`task_complete` performs the required registration sequence before requesting authoritative completion:

1. register any bundled Artifacts;
2. validate required outputs;
3. write deterministic local Worklog;
4. publish summary/Decision/warning/next-action Memory candidates through a durable local outbox;
5. create structured Handoff;
6. request the Execution Step Completion Gate;
7. release the lifecycle claim and move the Agent session to WAITING.

If Shared Memory is unavailable, deterministic local state and pending memory events remain durable and the result is `COMPLETED_WITH_WARNINGS`. A completely invalid Artifact registration fails the operation instead of silently claiming success.

## Context version

`context.resolve` reconciles:

- Shared Memory sequence;
- Execution Task event sequence;
- Artifact count;
- lifecycle-local changes.

The Task gets a monotonically increasing `context_version`. `context.check` returns only the changes since an older version, reserving the incremental refresh path without forcing every Agent to reload all project memory.

## Recovery

`sessionInterrupt` is an internal lifecycle hook for browser close/crash/timeout recovery. It marks the bound Execution session lost, releases the supplemental claim, records the interruption and reopens recoverable work through the existing Execution state machine. A new GPT session can then claim the same authoritative Step and receive old Worklog, Artifact, Decision and Handoff through `context_resolve`.

## Deferred phase

The data model and context journal reserve future support for:

- automatic heartbeat/STALLED classification;
- Event Bus push notifications;
- cross-agent live context-change alerts;
- semantic Memory Router/compression;
- Decision supersede/conflict resolution UI;
- Worker wakeup and physical-session rotation;
- richer Agent capability/profile registry.

These are not required for the MVP and must not create a parallel Task authority when implemented.

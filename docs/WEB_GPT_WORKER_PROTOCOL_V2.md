# Zero3 Web-GPT Worker Protocol v2

## Status

Phases P1-P4 are implemented: contracts, long-lived Worker Runtime v2, Private Gateway v2 and the long-lived GPT Worker Skill. V1 remains fully supported for compatibility.

## Purpose

V2 changes the Web GPT identity from a one-Assignment worker into a long-lived Workflow worker slot:

```text
WorkflowRun
  -> WorkerDefinition
  -> WorkerSlot
  -> PhysicalWorkerSession
  -> Claim
  -> WorkItem / StageRun
```

The worker remains deliberately narrow. It does not own Workflow topology, executor selection, Codex/GPU dispatch, local filesystem access, shell access, or Completion Gate authority.

## P1 contracts

Source: `apps/zero3-desktop/worker-runtime/v2/`.
P1 defines and validates:

- `WorkflowWorkerBinding`
- `WorkerSlot`
- `PhysicalWorkerSession`
- `WorkflowWorkUnit`
- `WorkflowArtifactRef`
- Worker Binding Ticket claims and scope
- generation fencing
- V1 WorkUnit/Artifact compatibility adapters

Artifact storage metadata supports `GOOGLE_DRIVE`, `LOCAL`, `REMOTE_COMPUTE`, and `URL`. `GOOGLE_DRIVE` artifacts require a Drive `fileId`; the Worker Gateway never receives Drive credentials.

## Worker Binding Ticket

The MCP bearer token authenticates the private gateway. The Worker Binding Ticket provides business-level authorization and binds one physical session to:

```text
workflowRunId
workerDefinitionId
workerSlotId
workerSessionId
provider
allowedCapabilities
generation
issuedAt / expiresAt
```
Tickets use HMAC-SHA256 and timing-safe signature verification. Rotation increments the Worker Slot generation; a ticket from an older physical session is rejected as stale.

## Compatibility

The six V1 tools remain present for a full compatibility cycle:

```text
register_worker
claim_work
report_progress
complete_and_claim_next
report_failure
get_task_context
```

V1 tables and tools remain intact. V2 uses separate Workflow worker tables and the shared Private Gateway routes `claim_work` / `report_progress` by the presence of `bindingTicket`. `adaptV1WorkUnitToV2` and Artifact adapters remain the explicit compatibility bridge.

## P1 acceptance

The static acceptance set covers:

- schema normalization and invalid storage rejection;
- Worker Binding Ticket slot/session/capability scope;
- generation fencing after session rotation;
- signature tamper and expiry rejection;
- existing V1 runtime claim behavior after V2 is added.

## P2 long-lived runtime

V2 persists WorkflowRun, WorkerBinding, WorkerSlot, PhysicalWorkerSession, WorkItem, StageRun, Claim, Lease, generation history and worker events in a dedicated SQLite authority. `commit_and_claim_next` completes the current StageRun(s), validates required structured Artifacts, releases downstream StageRuns per WorkItem immediately, and claims the next available work in the same transaction.

Session rotation increments the WorkerSlot generation. Any old Binding Ticket is fenced. Lease expiry returns retryable StageRuns to READY and lets another worker slot claim them.

## P3 Private Gateway v2

The private MCP catalog now includes `bootstrap_worker`, `commit_and_claim_next`, `report_blocked`, and `recover_worker`. Existing `claim_work` / `report_progress` remain one public tool each; `bindingTicket` selects v2 while legacy Task/Step/Assignment identities continue to select v1.

Zero3-only administration (`ensureRun`, `ensureBinding`, `addItems`, `openSession`, `rotateSession`, snapshot and lease expiry) is exposed only through local Electron IPC and is not registered as GPT MCP tools.

## P4 long-lived Worker Skill

`skills/zero3-web-worker/SKILL.md` now requires bootstrap, bounded claim execution, structured Artifact commit, NO_WORK_AVAILABLE waiting behavior, generation rotation handling, blocked reporting and authoritative recovery after context loss.

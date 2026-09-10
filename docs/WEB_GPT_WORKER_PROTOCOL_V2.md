# Zero3 Web-GPT Worker Protocol v2

## Status

Phase P1 protocol/schema baseline is implemented. V1 remains fully supported and is not replaced in P1.

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

P1 does not migrate the existing SQLite tables and does not alter Gateway behavior. `adaptV1WorkUnitToV2` and Artifact adapters provide the explicit bridge needed by P2.

## P1 acceptance

The static acceptance set covers:

- schema normalization and invalid storage rejection;
- Worker Binding Ticket slot/session/capability scope;
- generation fencing after session rotation;
- signature tamper and expiry rejection;
- existing V1 runtime claim behavior after V2 is added.

Phase P2 will add the V2 persistent WorkerSlot / Physical Session / Claim runtime and `commit_and_claim_next` transaction semantics.

# Zero3 Execution Reporter v1

## Purpose

Execution Reporter is the narrow callback path from an assigned external/web session back into the authoritative Zero3 Cross-App Execution Runtime. The first operational transport is Remote Desktop Commander (DC): a GPT Web session can invoke the purpose-specific `zero3-exec` client on the paired machine, and that client sends a bounded report to the loopback reporter service.

DC is transport only. It does not own task state, DAG scheduling, Completion Gate decisions, or arbitrary Zero3 administration.

## Flow

```text
GPT Web session
  -> Remote Desktop Commander
  -> zero3-exec (Node in development / PowerShell in packaged Windows)
  -> authenticated loopback HTTP reporter
  -> Assignment Ticket validation
  -> Zero3ExecutionReporter
  -> Zero3ExecutionRuntime
  -> durable Execution Event Ledger + snapshot
```

The reporter service binds only `127.0.0.1`/`::1`. Its endpoint descriptor contains a process-local bearer token and is written inside the Zero3 user-data execution directory. The Assignment Ticket is a second, HMAC-signed capability scoped to one concrete Assignment and, for web executors, one bound session.

## Assignment Ticket

`zero3.pilot.execution-assignment-ticket.v1` contains:

- Task / Step / Assignment identity;
- concrete executor and attempt number;
- optional bound Session identity;
- allowed report types;
- issue/expiry timestamps.

The signature secret never leaves Zero3. A new Assignment invalidates the previous Assignment's ticket because the Step's authoritative `assignmentId` changes. Web tickets require a SessionBinding and cannot be issued for lost/closed sessions.

## Report protocol

Every report uses `zero3.pilot.execution-report.v1` and a caller-chosen stable `reportId`. Supported types are:

- `SESSION_STARTED`
- `PROGRESS_UPDATED`
- `ARTIFACT_PRODUCED`
- `BLOCKED`
- `WAITING_HUMAN`
- `COMPLETION_REQUESTED`

`reportId` becomes an Execution Event idempotency key. Replaying the same report returns the existing result; reusing it with different content fails closed.

`COMPLETION_REQUESTED` moves the Step only to `verifying`. The web session cannot submit `gate.passed`, cannot set `completed`, and cannot schedule another Step. Zero3 remains the completion authority.

## DC client

Development/Linux example:

```text
node apps/zero3-desktop/execution-runtime/zero3-exec.mjs context \
  --endpoint-file <endpoint-file> \
  --ticket <assignment-ticket>

node apps/zero3-desktop/execution-runtime/zero3-exec.mjs report \
  --endpoint-file <endpoint-file> \
  --ticket <assignment-ticket> \
  --report-id progress-001 \
  --type PROGRESS_UPDATED \
  --payload-json '{"progress":0.5,"currentActivity":"正在生成视觉提示词"}'
```

Packaged Windows carries `zero3-execution-tools/zero3-exec.ps1` and Zero3 returns the exact executable/argument prefix together with the Assignment Ticket. The web session should use those values rather than guessing installation paths.

## Artifact reports

`ARTIFACT_PRODUCED` is a logical registration event in Phase 2. It requires `logicalName` and either `artifactId` or `pathOrUri`; optional hash, MIME type, kind, size, and metadata may be supplied.

Physical collection of ChatGPT-generated images/files into the shared Artifact Store remains the later Web Artifact Collector phase. Reporting an asset reference is not proof that the binary has been collected.

## Recovery behavior

The existing Execution Store already detects an event-ledger/snapshot gap. Reporter replay fails closed when it observes that its durable report event exists but the snapshot has not caught up. Semantic crash replay remains a dedicated recovery phase rather than silently guessing the missing state transition.

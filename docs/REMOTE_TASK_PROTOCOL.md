# Zero3 Pilot Remote Task Protocol v1

## Purpose

This protocol carries high-level development intent from an external commander to a local Zero3 Pilot desktop. It is deliberately not a remote-shell protocol.

## Envelope

```json
{
  "protocol": "zero3.pilot.remote-task.v1",
  "task_id": "z3p-20260830-000001",
  "execution_id": "exec-000001",
  "objective": "Implement the requested Zero3 Pilot feature and verify it.",
  "target": {
    "workspace": "D:\\Projects\\zero3-pilot",
    "base_ref": "main"
  },
  "constraints": [
    "Do not force-push protected branches"
  ],
  "acceptance_criteria": [
    "Architecture guard passes",
    "Relevant tests pass"
  ],
  "permission_profile": "standard",
  "execution": {
    "max_turns": 8,
    "timeout_seconds": 3600,
    "require_clean_worktree": true
  }
}
```

## Required fields

- `protocol`: exactly `zero3.pilot.remote-task.v1`.
- `task_id`: stable idempotency and correlation identifier.
- `execution_id`: external execution correlation identifier.
- `objective`: result-oriented instruction for Codex.
- `target.workspace`: local workspace requested by the task; it must also be present in the host's local allow-list.

## Optional fields

- `target.base_ref`
- `constraints[]`
- `acceptance_criteria[]`
- `permission_profile`
- `execution.max_turns`
- `execution.timeout_seconds`
- `execution.require_clean_worktree`

Unknown fields may be retained for forward compatibility, but unknown security-sensitive semantics must never widen permissions.

## Permission profiles

The protocol names mirror Zero3's existing permission semantics:

```text
read_only  -> ReadOnly
standard   -> Standard
elevated   -> Elevated
full_control -> FullControl
```

`full_control` is not a remote default and does not imply silent Codex `danger-full-access`.

## Objective projection

The local adapter converts the contract into a stable Codex turn input containing:

```text
[ZERO3 REMOTE TASK]
Task ID: ...
Execution ID: ...

Objective:
...

Constraints:
- ...

Acceptance Criteria:
- ...

Execution requirements:
- inspect the real repository before changing it
- preserve Zero3 architecture invariants
- use real project verification
- do not claim success until acceptance criteria are verified
- stop rather than bypassing permissions outside the granted profile
```

The adapter does not tell Codex which exact shell commands to run unless a task explicitly contains non-authoritative contextual suggestions.

## Result contract

A terminal result should contain at least:

```json
{
  "task_id": "...",
  "execution_id": "...",
  "state": "succeeded",
  "codex": {
    "thread_id": "...",
    "turn_ids": ["..."]
  },
  "summary": "...",
  "evidence": {
    "commands": [],
    "file_changes": [],
    "mcp_calls": [],
    "turn_completion": {}
  },
  "remaining_risks": []
}
```

Terminal states are:

```text
succeeded
failed
cancelled
blocked
outcome_unknown
quarantined
```

## Idempotency

`task_id` is idempotent. Re-delivery of the same task must resume or report the existing local mapping rather than start an unrelated duplicate Codex Thread.

## Lease and fencing

The AWS control plane owns lease/fencing semantics. Every task delivery should include a `lease_id` and monotonically increasing `fencing_token`. Uploads from a stale fencing token must be rejected by the control plane.

The local host must stop publishing authoritative progress once it knows its lease is invalid.

## Security invariants

The protocol cannot request:

- an arbitrary unaudited direct-shell channel;
- bypass of Codex approval;
- bypass of Codex sandbox;
- access to a workspace not allowed locally;
- silent credential export;
- silent destructive system changes.

Such requirements must be rejected or surfaced through an explicit local approval/policy path.

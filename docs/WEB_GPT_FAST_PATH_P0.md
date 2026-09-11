# Web GPT Fast Path P0

## Scope

Fast Path P0 reduces Web GPT ↔ Zero3 round trips without moving authority into the web session. The cloud Worker Gateway remains a durable forwarding layer; Task Runtime, Agent Lifecycle Runtime, Remote Host, Git and Codex execution remain authoritative on the configured Zero3 host/control plane.

P0 adds three bounded Worker MCP operations:

- `task_bootstrap`: composes session start/resume, GPT_WEB task claim, and filtered context/handoff resolution into one retry-safe call.
- `dispatch_codex_task`: creates one typed high-level Codex development task through the existing `/api/control/v1/tasks` contract. It does not expose a shell command, filesystem primitive, control token, destination node, or raw Codex RPC.
- `verify_commit`: runs only allow-listed static checks, stages only explicitly declared task-owned paths, creates one scoped commit, and performs a normal non-force push of the current branch.

Existing Worker/Lifecycle and Skill MCP tools remain compatible.

## Fast-path round-trip policy

For the common Web GPT development path:

1. Use `task_bootstrap` instead of separate `session_start` + `task_claim` + `context_resolve` calls.
2. Prefer one `dispatch_codex_task` for a coherent local Codex work package rather than decomposing the same objective into chatty remote operations.
3. Batch related file changes into one coherent closeout boundary and call `verify_commit` once after the task-owned changes are ready.
4. Keep independent/unrelated work out of that closeout. `verify_commit` refuses unrelated pre-staged files and stages only the declared paths, so parallel work can remain dirty but unstaged.
5. Do not use Fast Path as a replacement for ordinary progress/memory/handoff events when those events are organizationally meaningful.

This is a round-trip reduction policy, not a latency SLA. Worker RPC still crosses the MCP gateway, durable queue, outbound host tunnel, and local runtime. `verify_commit` may outlive the normal MCP synchronous wait while static checks run; its Worker lease/request lifetime is extended and retries reuse the same idempotency key.

## Security boundary

Fast Path is deliberately narrower than general remote execution:

- Web GPT cannot provide an arbitrary command line or script.
- Web GPT cannot read or write arbitrary local files through these tools.
- `dispatch_codex_task` accepts only a typed objective/constraints/acceptance contract and only `read_only`, `standard`, or `elevated` permission profiles; `full_control` is rejected.
- The requested workspace must exactly match `ZERO3_REMOTE_HOST_WORKSPACES`.
- `verify_commit` accepts only repository-relative owned paths and the fixed verification enum: `git_diff_check`, `cargo_fmt_check`, `cargo_check_web`, `desktop_typecheck`.
- `verify_commit` rejects detached HEAD, repository-root mismatch, task-scope escape, unrelated pre-staged changes, and any staged path outside the declared scope.
- Push is always a normal push to `origin` and the current branch. The runtime never force-pushes, rewrites history, changes remotes, or accepts a caller-supplied destination remote.
- AWS continues to hold no direct shell/filesystem/Codex execution surface for MCP. Codex work is dispatched through the existing typed Control Plane and executed by the authorized local Remote Host.

## Idempotency and retry behavior

All three P0 MCP tools require `idempotencyKey`.

- The Worker Gateway deduplicates scoped retries into the same durable RPC record.
- `task_bootstrap` derives separate lifecycle idempotency keys for its session and claim sub-operations, so retrying the composite call resumes the same authoritative session/claim.
- `dispatch_codex_task` deterministically derives `task_id` and `execution_id` from `(sessionId, idempotencyKey)`. The Control Plane returns the existing task for an identical task/execution payload and rejects conflicting reuse.
- `dispatch_codex_task` writes its context/handoff sidecar before the core task, always as a first writer (`expected_version: 0`), so a retried dispatch reaches that endpoint as a stale writer for its own sidecar. The Control Plane therefore treats a sidecar whose schema, execution and extension fields exactly match the stored record as an already-satisfied replay: it returns the stored version unchanged. Any difference in payload or execution identity still fails closed with the original conflict, and the local client only continues past a conflict after re-reading the sidecar and proving it equals the dispatched payload.
- `verify_commit` writes `Zero3-Idempotency-Key: <key>` into the commit message. If result publication is lost after commit/push, a retry recognizes the same scoped HEAD commit, verifies its paths, and safely re-pushes without creating a duplicate commit. Reusing the key after task-owned files change again fails closed.

## GitHub batch commit strategy

The default Fast Path commit boundary is one coherent task, not one file and not the whole dirty worktree.

- Declare every path owned by the current task in one `verify_commit` call.
- Run the approved static checks before staging/committing.
- Stage only the declared paths.
- Fail if unrelated content was already staged.
- Commit the whole coherent task once and push once.
- Leave unrelated unstaged changes untouched for their owning task/session.

This preserves parallel-agent isolation while reducing GitHub/Git round trips.

## Observability

Where the local operation naturally has a synchronous result, P0 returns lightweight `timingMs` metadata:

- `task_bootstrap`: `session`, `claim`, `context`, `total`.
- `dispatch_codex_task`: `total` for validation and Control Plane submission.
- `verify_commit`: `total`, plus per-check duration in the returned check results.

These values are diagnostic measurements for the completed operation, not guaranteed performance targets. Queue wait, tunnel wait, and later Codex task execution remain separately observable in their existing Worker/Remote Host records.

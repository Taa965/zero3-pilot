# Zero3 Remote Capability Protocol (ZRCP)

Zero3 Pilot's ChatGPT plugin is a private remote-control connector for the local Zero3 Pilot application. It is not an executor, scheduler, or second Zero3 runtime.

## Authority boundary

```text
Web GPT -> Zero3 Pilot MCP -> AWS transport relay -> outbound Zero3 tunnel -> local Capability Runtime -> local Policy -> local executor
```

The AWS service persists bounded RPC correlation state only. It never executes PowerShell, filesystem, Git, browser, Agent, Workflow, GPU, or other Zero3 capabilities.

## P0 protocol

Tunnel capability: `zero3-capability-v1`

Public MCP tools:

- `list_capabilities`
- `describe_capability`
- `invoke_capability`
- `get_operation`
- `cancel_operation`

Local capabilities initially registered:

- `system.status`
- `shell.powershell.execute`

The old Worker Protocol remains available for task/worker compatibility but is no longer the only top-level remote-control surface.

## Operations

`invoke_capability` creates a local operation and returns quickly. Long-running execution continues inside local Zero3. Callers inspect it through `get_operation` or cancel it through `cancel_operation`.

Terminal states: `BLOCKED`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`.

Local operation metadata is persisted under the Zero3 user-data directory. Non-terminal operations fail closed after a local runtime restart rather than pretending they completed.

## Policy

Execution authorization belongs to local Zero3. P0 provides a local environment-backed policy port:

- `disabled` / `read_only`: execution denied.
- `project_scope` (default): out-of-scope cwd is denied; in-scope PowerShell still requires local confirmation because cwd does not sandbox arbitrary shell access.
- `full_control`: explicit operator opt-in to unattended local full-control execution.

Allowed roots come from `ZERO3_CAPABILITY_ALLOWED_ROOTS`, existing `ZERO3_REMOTE_HOST_WORKSPACES`, and `ZERO3_CODEX_CWD`. No policy secret or command execution authority is moved to AWS.

## PowerShell

`shell.powershell.execute` selects an installed local PowerShell (`pwsh` preferred, Windows PowerShell fallback), executes without a command shell wrapper, returns `exitCode`, `stdout`, `stderr`, `durationMs`, `cwd`, and shell kind, and enforces bounded output, timeout, cancellation, idempotency, and local Policy.

## Next protocol layers

The same registry/invoke/operation pattern is intended to expose existing local Zero3 capabilities such as filesystem, Git, browser/computer control, Agent, Task/Workflow, Skill, Artifact, Compute and GPU without changing the transport boundary.

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

P1 (below) added filesystem and Git this way, without changing the transport boundary or the MCP catalog. The same registry/invoke/operation pattern is intended to expose the remaining local Zero3 capabilities such as browser/computer control, Agent, Task/Workflow, Skill, Artifact, Compute and GPU.

## P1 protocol: local filesystem and Git

P1 adds no MCP tool and no gateway route. Web GPT still calls `invoke_capability`; the new capabilities appear only through `list_capabilities`, and every one of them executes on the local Zero3 host after local policy authorization.

Filesystem capabilities:

- `filesystem.list` - bounded directory listing with an entry limit and an optional recursion depth.
- `filesystem.stat` - stable path description; a missing path is `exists:false`, never a raw `ENOENT` stack.
- `filesystem.read` - bounded UTF-8 text read returning `sha256`; binary and oversized files are refused instead of decoded or silently truncated.
- `filesystem.write` - atomic UTF-8 write with `expectedSha256` optimistic concurrency.
- `filesystem.mkdir`
- `filesystem.copy`
- `filesystem.move`
- `filesystem.delete`

Git capabilities:

- `git.status` - structured branch, `head`, upstream, ahead/behind and staged/unstaged/untracked/conflicted entries.
- `git.diff` - bounded diff for `working`, `staged` or `commit` scope; an oversized diff returns a stat summary.
- `git.log` - at most 100 commits with sha, short sha, author, date and subject.
- `git.show` - bounded `git show` for one validated ref, optionally limited to one repository-relative path.
- `git.add` - stages only the explicitly named repository-relative paths.
- `git.commit` - commits only when every staged path was declared by the same invocation.
- `git.fetch` - fetch only; never pull, merge or reset.
- `git.push` - one explicit non-forced refspec; a diverged remote fails closed.
- `git.branch` - `list`, `current` and `create` only; switching branches is a separate future capability.

There is deliberately no `filesystem.exec`, no `git.exec` and no arbitrary argv passthrough. Each capability id is the authorization unit, which is what keeps local policy meaningful.

### P1 policy mapping

- `read_only`: filesystem and Git inspection (`filesystem.list`, `filesystem.stat`, `filesystem.read`, `git.status`, `git.diff`, `git.log`, `git.show`, `git.branch` list/current) is allowed; everything else is denied.
- `project_scope` (default): the same reads are allowed inside the allow-listed roots; `filesystem.write`, `filesystem.mkdir` and `filesystem.copy` are allowed inside those roots; `filesystem.move`, `filesystem.delete`, `git.add`, `git.commit`, `git.fetch`, `git.push` and `git.branch create` stop at `WAITING_APPROVAL`.
- `full_control`: all P1 capabilities may run, still bounded by the structured capability set, path containment and the response-size limits.

Policy is a second containment gate independent of the handlers: a request naming a path outside the allow-listed roots is refused before any handler is scheduled.

### P1 safety properties

- Path containment uses `path.relative` on resolved real paths, so `..` traversal and symlink/junction escapes such as `C:\project\link -> C:\Windows` fail closed. Windows comparison is case-insensitive and UNC paths are refused unless a UNC root is allow-listed.
- `filesystem.write` reuses the reviewed `zero3AtomicWriteFile` (temporary file, fsync, rename) and fails with `FILE_CHANGED` when `expectedSha256` no longer matches.
- `filesystem.delete` can never remove an allow-listed root or a volume root.
- Git runs through `execFile` with `shell:false` and an argument array; refs, branches, remotes and pathspecs are validated and pathspecs are passed as `:(literal)`. `git.add` cannot express `-A`, `.` or an implicit repository-wide stage.
- No force push exists: no `--force`, no `--force-with-lease`, no `+` refspec, and a rejected push is reported as `PUSH_REJECTED`.
- Payloads are bounded locally before the gateway's 2 MiB body cap: file reads and writes 1 MiB, diffs 1 MiB, listings 1000 entries, history 100 commits.

### P1 acceptance

`node --experimental-transform-types scripts/zero3-p1-windows-e2e.mjs` drives every P1 capability through the real local Capability Runtime inside one throwaway sandbox (default `~/Documents/ChatGPT/.zero3-p1-e2e-*`, falling back to the platform temporary directory), prints one PASS/FAIL line per capability, and removes the sandbox afterwards. It never touches the Zero3 Pilot repository or its Git state, and it covers the `expectedSha256` conflict, the delete-root guard, the `project_scope` `WAITING_APPROVAL` stop, a non-forced push to a local bare remote, a rejected divergent push, and ref/pathspec injection refusals.

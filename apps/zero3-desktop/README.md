# Zero3 Desktop — Hermes UI shell over Codex core

This directory owns the target Zero3 desktop architecture.

## Role hierarchy

- `upstream/codex` — **core runtime / Agent Kernel**.
- `upstream/hermes-agent` — **Electron + React UI/UX shell**.
- `upstream/deepseek-harness` — **capability donor/reference**.
- installed Codex/Claude/Hermes apps — **External Agent Collaboration targets**, never Zero3's core.

The architecture constitution is [`../../docs/ARCHITECTURE_CONSTITUTION.md`](../../docs/ARCHITECTURE_CONSTITUTION.md).

## Target transport

```text
Hermes-derived React UI
        |
Zero3 Codex adapters
        |
window.zero3Codex
        |
typed Electron preload IPC
        |
Electron main Codex client
        |
codex app-server --stdio
        |
open-source Codex
```

Codex Thread / Turn / Item and app-server notifications/server requests are authoritative for the migrated primary chat path.

## R1A — implemented transport boundary

`apply-codex-transport.mjs` adds the Zero3-owned Codex transport directly to the Hermes-derived Electron shell.

The Renderer receives only purpose-specific operations:

```text
status / start
thread.start
thread.resume
thread.list
thread.read
turn.start
turn.interrupt
respondToServerRequest
onEvent
```

There is deliberately **no** `call(method, params)`, arbitrary JSON-RPC proxy, localhost proxy, or Zero3 Node bridge exposed to Renderer code.

Electron main owns `codex app-server --stdio` lifecycle, `initialize -> initialized`, JSONL parsing, request correlation/timeouts, bounded frame/stderr handling, notification forwarding, server-originated request forwarding, and shutdown.

During `npm run dev`, `run.mjs` resolves the Codex core to the binary built from the exact pinned `upstream/codex` checkout. Host-installed Codex/Claude/Hermes applications do not satisfy the core path; those belong to External Agent Collaboration.

Zero3 also gives its core a separate `CODEX_HOME`, defaulting on Windows to `%LOCALAPPDATA%\Zero3Pilot\codex` unless `ZERO3_CODEX_HOME` is explicitly set.

## R2A — implemented primary chat cut

`apply-codex-primary-chat.mjs` keeps the mature Hermes-derived visual chat shell but replaces the **main chat callbacks** with Codex-native semantics whenever `window.zero3Codex` is present:

```text
new chat       -> thread/start
sidebar list   -> thread/list
resume/history -> thread/resume + thread/read(includeTurns=true)
send text      -> turn/start
stream text    -> item/started + item/agentMessage/delta + item/completed
turn settle    -> turn/completed
Stop / Esc     -> turn/interrupt
```

Codex Threads and Items are projected into the existing `SessionInfo` / `ChatMessage` stores only as presentation adapters. Hermes session/job semantics are no longer authoritative for this main path.

R2A was the initial primary-chat cut. Later merged R3B-R3F work added additional Item families, structured attachments/input, native Thread actions, exact Turn mapping and authoritative paginated history. Any still-unported shell surface must continue to fail closed or remain explicitly compatibility-only rather than silently falling back into Hermes Runtime for migrated core behavior. See [`../../docs/CODEX_PRIMARY_CHAT_R2.md`](../../docs/CODEX_PRIMARY_CHAT_R2.md).

## R2B — Codex native approval and user-input bridge

`apply-codex-prompts.mjs` connects selected app-server **server requests** directly to Zero3-owned prompt UI mounted inside the existing Hermes-derived presentation shell.

Supported in R2B:

```text
item/commandExecution/requestApproval -> Zero3 approval dialog
item/fileChange/requestApproval       -> Zero3 approval dialog
item/tool/requestUserInput             -> Zero3 multi-question input dialog
```

Approval responses map only to the reviewed Codex decisions:

```text
accept
acceptForSession
decline
```

Zero3 deliberately does **not** expose persistent exec-policy or network-policy amendments yet. User-input answers are returned in Codex's native `{ answers: { questionId: { answers: [...] } } }` shape; secret values stay in component-local state rather than a global store.

The main Codex chat now uses:

```text
approvalPolicy = on-request
sandbox = read-only
```

`read-only` is the default sandbox, not a claim that an explicitly approved escalation can never write. A command or file action can gain the permission represented by its Codex server request only after the user explicitly approves it; R2B still does **not** switch the default thread sandbox to `workspace-write`. Unsupported app-server request classes — including permission-profile escalation, MCP elicitation, dynamic tool callbacks, auth refresh/attestation and legacy approval RPCs — are rejected fail-closed rather than auto-approved.

Prompt requests are queued per Codex Thread instead of stored in a single slot. Blocking Codex prompts are also wired into the shell's existing `awaiting-input` state so the composer, Stop/Esc behavior and session UI do not treat a user decision as ordinary background execution. Stop, terminal turn settlement and runtime errors clear/reject unresolved request IDs so Electron main does not retain orphaned app-server callbacks.

## R3A — Codex native Item presentation

`apply-codex-item-rendering.mjs` preserves Codex as the authoritative Item source and projects selected native Items into the mature Hermes-derived reasoning/tool presentation components. The mapping is presentation-only; it does not call Hermes Runtime or Zero3 Node.

Implemented Item mappings include:

```text
Codex reasoning        -> Hermes reasoning timeline part
Codex commandExecution -> Hermes terminal tool card
Codex fileChange       -> Hermes patch/file-change card
Codex mcpToolCall      -> Hermes generic MCP tool card
```

History comes from the same `thread/read(includeTurns=true)` Turn Item arrays, so restored conversations and live conversations share one projection model. Live updates use the pinned app-server notifications.

R3A does not change the R2B security boundary: `approvalPolicy=on-request`, default `sandbox=read-only`, and unsupported server-request classes remain fail-closed.

## R3B-R3F — merged Codex-native parity

The phases previously listed as “next implementation” are now merged:

- **R3B:** additional Codex-native Item presentation, including dynamic-tool, plan and web-search families;
- **R3C:** validated structured `UserInput[]`, including supported local-image input;
- **R3D:** native archive/unarchive/delete/rename/fork and active-Turn steer;
- **R3E:** authoritative message-to-Turn mapping for history-sensitive operations;
- **R3F:** authoritative paginated history with fail-closed destructive/history-sensitive flows.

See the corresponding documents under `docs/CODEX_*_R3*.md` for detailed boundaries and test evidence.

## Durable AppServer conversation source — #49 merged

Zero3 explicitly launches pinned Codex with `--session-source app-server` and lists `sourceKinds: ['appServer']`. The release-blocking persistence smoke creates two non-ephemeral Threads, starts a first Turn on each, restarts app-server with the same `CODEX_HOME`, then requires both original IDs to remain listable/readable in the AppServer source namespace.

Development sessions created before explicit source tagging may have been persisted under Codex's `vscode` source; the first public alpha does not promise automatic migration of those pre-release rows.

## Codex-native Windows package — #51 merged

`npm run dist:win` builds the exact reviewed Codex pin in release mode, stages it as `resources/zero3-codex/codex.exe`, stages required Zero3/Codex/Hermes legal notices, configures packaged mode to use only the bundled reviewed Codex binary, and invokes the NSIS build with automatic publishing disabled.

The Windows Alpha Artifact workflow verifies the packaged Codex with `--version` and a real app-server smoke, verifies required legal resources, and records an installer SHA-256. The #51 pull-request merge candidate already included merged #49 and passed this integrated package gate; final public-release evidence must still come from the exact post-closeout release SHA.

## Retired Zero3 Node desktop direction

Earlier Phase B work routed the Hermes-derived UI through `zero3-pilot-node` for chat, memory, schedules and browser control. That direction is retired.

The old overlay files may remain temporarily for migration archaeology, but `prepare-upstream.mjs` must not apply them:

- `apply-native-bridge.mjs`
- `apply-native-chat.mjs`
- `apply-native-chat-hardening.mjs`
- `apply-memory-bridge.mjs`
- `apply-schedule-bridge.mjs`
- `apply-schedule-lifecycle.mjs`
- `apply-browser-bridge.mjs`

They must not receive new feature work.

## Temporary Hermes compatibility backend

The pinned Hermes Desktop still expects its own backend for unported shell surfaces. `npm run dev` may therefore prepare Hermes' backend **only as compatibility scaffolding**.

That backend is not allowed to own primary conversation semantics, Codex approvals/input, native Codex Item execution, or new Zero3 product state. The compatibility backend can be removed only after the remaining shell dependencies are ported.

## Pinned upstreams

Exact SHAs live in the reviewed repository configuration/manifest; preparation fails closed on pin mismatch.

```text
Codex            94311d447587411789533c47601fd8bc9d81eb48
Hermes Agent     f7c79efbac19ae18e8dee7c79a4e4c0935299b5f
DeepSeek-Harness cd5ef8148158c3a752a658978873241fdf8e2bbc
```

## Commands

```powershell
npm run prepare
npm run typecheck
npm run dev
npm run dist:win
```

`npm run prepare` applies the reviewed Zero3 desktop overlays for the current Codex-native path. `npm run dev` additionally builds/resolves the exact pinned open-source Codex binary when missing and launches the temporary UI compatibility environment. It does not launch Zero3 Node as native runtime authority.

`npm run dist:win` prepares the same reviewed target, builds the pinned Codex release binary, stages the bundled runtime/legal resources and produces the Windows NSIS candidate with publishing disabled.

Before changes:

```powershell
node ../../scripts/check-architecture.mjs
```

## Current follow-up boundary

R3B-R3F are no longer future work. Remaining desktop follow-up includes still-unported shell surfaces, permission/MCP elicitation UX where separately reviewed, eventual removal of the Hermes compatibility-backend boot dependency, and post-alpha executor/collaboration/productization work.

None of those follow-ups permits a second Zero3/Hermes Agent Kernel, generic Renderer Codex proxy, hidden fallback agent loop, tool loop, MCP runtime or approval engine.

## Upstream modification policy

Hermes source is an upstream UI source tree, not the Zero3 core. All overlays remain deterministic and fail closed when the pinned source changes. Do not implement business/runtime logic inside Hermes Agent's Python runtime.

Codex source changes are allowed as deliberate Zero3 secondary-development patches with review, tests and clear ownership. Keeping Codex authoritative is the priority.

## Legacy desktop

`apps/desktop` is the older Rust/Tao/Wry shell. It remains for rollback/history only and is not the target product UI.

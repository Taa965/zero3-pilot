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
Zero3 Codex primary-chat adapter
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

Codex Thread / Turn / Item and app-server notifications are the authoritative model for the migrated primary chat path.

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

R2A deliberately runs primary Codex threads with:

```text
approvalPolicy = never
sandbox = read-only
```

This is a temporary safety boundary until native Codex approval/input UI is connected. Unexpected server-originated requests are denied fail-closed rather than auto-approved. R2A therefore cannot modify the workspace.

Operations not migrated yet — attachments, edit/rewind/regenerate/branch, native archive/delete, steering, rich tool/file/reasoning rendering, approval/input UI and multi-pane Codex parity — do **not** silently fall back into Hermes Runtime for the primary chat. See [`../../docs/CODEX_PRIMARY_CHAT_R2.md`](../../docs/CODEX_PRIMARY_CHAT_R2.md).

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

That backend is not allowed to own primary conversation semantics or new Zero3 product state. R2A's main chat already goes through Codex. The compatibility backend can be removed only after the remaining shell dependencies are ported.

## Pinned upstreams

Exact SHAs live in `scripts/config.mjs`; preparation fails closed on pin mismatch.

```text
upstream/codex            core
upstream/hermes-agent     UI shell
upstream/deepseek-harness capability donor
```

## Commands

```powershell
npm run prepare
npm run typecheck
npm run dev
npm run dist:win
```

`npm run prepare` applies branding/product/localization, the R1A typed Codex transport and the R2A primary-chat adapter. `npm run dev` additionally builds the pinned open-source Codex binary when missing and launches the temporary UI compatibility environment. It does not launch Zero3 Node.

Before changes:

```powershell
node ../../scripts/check-architecture.mjs
```

## Next implementation phase: R2B / R3

Next work is to close feature parity without returning runtime authority to Hermes:

- attachments -> Codex structured `UserInput`;
- reasoning / shell / file-change / MCP / dynamic-tool Item rendering;
- Codex approval and user-input requests -> native Zero3 UI;
- restore workspace-write only after approval routing is live;
- native archive/delete/branch/edit/rollback/steer operations;
- session tiles / multi-pane Codex parity;
- remove the remaining Hermes compatibility-backend boot dependency once no target surface needs it.

## Upstream modification policy

Hermes source is an upstream UI source tree, not the Zero3 core. All overlays remain deterministic and fail closed when the pinned source changes. Do not implement business/runtime logic inside Hermes Agent's Python runtime.

Codex source changes are allowed as deliberate Zero3 secondary-development patches with review, tests and clear ownership. Keeping Codex authoritative is the priority.

## Legacy desktop

`apps/desktop` is the older Rust/Tao/Wry shell. It remains for rollback/history only and is not the target product UI.

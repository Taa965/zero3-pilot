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

Codex Thread / Turn / Item and app-server notifications become the authoritative desktop session/execution model.

## R1A — implemented transport boundary

`apply-codex-transport.mjs` now adds the first Zero3-owned Codex transport directly to the Hermes-derived Electron shell.

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

Electron main owns:

- `codex app-server --stdio` process lifecycle;
- `initialize` -> `initialized` handshake;
- newline-delimited JSON parsing;
- request id correlation and request timeouts;
- bounded stderr and frame sizes;
- Codex notification forwarding;
- forwarding of Codex-originated server requests such as approvals without auto-approving them;
- shutdown with the desktop process.

During `npm run dev`, `run.mjs` resolves the Codex core to the binary built from the exact pinned `upstream/codex` checkout. Host-installed Codex/Claude/Hermes applications do not satisfy the core path; those belong to External Agent Collaboration.

Zero3 also gives its core a separate `CODEX_HOME`, defaulting on Windows to `%LOCALAPPDATA%\Zero3Pilot\codex` unless `ZERO3_CODEX_HOME` is explicitly set.

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

The pinned Hermes Desktop still expects its own backend for parts of the unported UI. `npm run dev` may therefore prepare Hermes' backend **only to keep the UI shell renderable while R2 is unfinished**.

That backend is not allowed to own new Zero3 product state, memory, scheduling, browser/computer workflows, or primary conversation semantics. New core integrations must use `window.zero3Codex`.

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

`npm run prepare` applies branding/product/localization overlays plus the R1A Codex transport. `npm run dev` additionally builds the pinned open-source Codex binary when missing and launches the UI compatibility environment. It does not launch Zero3 Node.

Before changes:

```powershell
node ../../scripts/check-architecture.mjs
```

## Next implementation phase: R2

R2 replaces the primary visible Hermes chat transport with Codex semantics:

- session identity -> Codex Thread;
- composer submit -> `turn/start`;
- assistant streaming -> `item/agentMessage/delta` and related Item notifications;
- Stop -> `turn/interrupt`;
- history/sidebar -> `thread/list`, `thread/read`, `thread/resume`;
- approval UI -> outstanding Codex server requests.

Only after this mapping is stable should the Hermes compatibility backend be removed from the target runtime boot path.

## Upstream modification policy

Hermes source is an upstream UI source tree, not the Zero3 core. All overlays remain deterministic and fail closed when the pinned source changes. Do not implement business/runtime logic inside Hermes Agent's Python runtime.

Codex source changes are allowed as deliberate Zero3 secondary-development patches with review, tests and clear ownership. Keeping Codex authoritative is the priority.

## Legacy desktop

`apps/desktop` is the older Rust/Tao/Wry shell. It remains for rollback/history only and is not the target product UI.

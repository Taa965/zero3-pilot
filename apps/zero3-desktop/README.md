# Zero3 Desktop — Hermes UI shell over Codex core

This directory owns the target Zero3 desktop architecture.

## Role hierarchy

- `upstream/codex` — **core runtime / Agent Kernel**.
- `upstream/hermes-agent` — **Electron + React UI/UX shell source**.
- `upstream/deepseek-harness` — **capability donor/reference**.
- installed Codex/Claude/Hermes apps — **external collaboration/executor targets**, never Zero3's native core.

The architecture constitution is [`../../docs/ARCHITECTURE_CONSTITUTION.md`](../../docs/ARCHITECTURE_CONSTITUTION.md). The current repository architecture summary is [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

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

Codex Thread / Turn / Item state and app-server notifications/server requests are authoritative for migrated primary-chat behavior.

There is deliberately **no** generic Renderer-controlled `call(method, params)` / arbitrary Codex JSON-RPC tunnel, localhost proxy or Zero3 Node bridge for migrated core behavior.

## Implemented Codex-native desktop path

### R1A — transport boundary

Electron main owns the pinned `codex app-server --stdio` child, `initialize -> initialized`, JSONL framing, request correlation/timeouts, bounded server-request forwarding, event projection and process cleanup.

Development mode resolves the core from the exact pinned `upstream/codex` checkout. Host-installed Codex/Claude/Hermes applications do not satisfy the native core path.

### R2A — primary conversation cut

The Hermes-derived visual shell is retained, but the main conversation callbacks use Codex-native semantics:

```text
new chat       -> thread/start
sidebar list   -> thread/list
resume/history -> thread/resume + thread/read
send           -> turn/start
stream         -> Codex Item notifications/deltas
Stop / Esc     -> turn/interrupt
```

Hermes session/message stores are presentation adapters on this path, not runtime authority.

### R2B — native approvals and user input

Selected Codex server requests are presented through Zero3-owned prompt UI:

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/tool/requestUserInput
```

Unsupported request classes remain fail-closed. Approval decisions are mapped only through reviewed Codex response semantics. Prompt state is correlated per Thread and cleared/rejected on terminal/interruption/error paths.

### R3A/R3B — native Item presentation

The presentation adapter covers Codex-native Item families including:

- reasoning;
- command execution;
- file changes;
- MCP tool calls;
- dynamic tool calls;
- plans;
- web search.

Live and restored history project from authoritative Codex Turn/Item data. Presentation reuse of Hermes-derived components does not move execution authority into Hermes Runtime.

### R3C — structured user input

The primary composer supports a validated Codex `UserInput[]` bridge, including supported local-image input. Renderer input is reconstructed/validated at the typed Electron boundary rather than becoming an arbitrary protocol passthrough.

### R3D — native Thread actions

The desktop path includes reviewed Codex-native operations for:

- archive / unarchive;
- permanent delete;
- rename;
- whole-Thread fork;
- active-Turn steer.

### R3E/R3F — authoritative mapping and history

Message/history operations resolve presentation messages against authoritative Codex Thread/Turn/Item identity rather than index/timestamp guesses. Destructive/history-sensitive flows use authoritative paginated history and fail closed when identity/pagination is incomplete or ambiguous.

## Durable Zero3 conversation source (#49)

PR #49 is merged.

Pinned Codex distinguishes AppServer transport from persisted session source. Zero3 explicitly launches the app-server with:

```text
--session-source app-server
```

and lists the matching:

```text
sourceKinds: ['appServer']
```

namespace. The regression smoke creates two non-ephemeral Threads, starts a first Turn on each, restarts app-server with the same `CODEX_HOME`, then requires both original IDs through source-scoped list/read operations.

Older pre-alpha development sessions created before explicit source tagging may have been persisted under Codex's `vscode` source; the first public alpha does not promise automatic migration of those rows.

## Windows alpha packaging (#51)

PR #51 is merged and establishes the current Windows distribution path.

`npm run dist:win`:

- prepares the pinned Hermes-derived Electron/React shell;
- applies the reviewed Codex overlay;
- builds the exact pinned Codex CLI in release mode;
- stages the binary as `resources/zero3-codex/codex.exe`;
- stages reviewed Zero3/Codex/Hermes legal notices;
- configures packaged mode to use only the bundled pinned Codex binary;
- invokes the NSIS package build with automatic publishing disabled.

The Windows Alpha Artifact workflow verifies the packaged Codex binary with `--version` and a real app-server smoke before accepting an artifact candidate.

The #51 pull-request merge candidate already included merged #49 and passed that integrated package gate. The public alpha still requires the final exact release SHA to be rebuilt/revalidated before its checksum is presented as the release checksum.

## Runtime homes and trust boundaries

Zero3 gives its Codex core a Zero3-owned `CODEX_HOME`, defaulting on Windows to `%LOCALAPPDATA%\Zero3Pilot\codex` unless an explicit reviewed development override is used.

Packaged Windows mode must not silently replace the reviewed core with PATH, `@latest`, runtime download or an arbitrary `ZERO3_CODEX_BIN` host override.

Native Codex account/auth handling uses supported Codex APIs; Zero3's Native executor must not read/copy/serialize Codex credential files or tokens.

## Temporary Hermes compatibility backend

The pinned Hermes Desktop may still initialize parts of its backend for unported shell surfaces. That backend is **compatibility scaffolding only**.

It is not allowed to own:

- primary Codex conversation semantics;
- native Codex approvals/input;
- Codex Item execution;
- authoritative Thread history;
- new Zero3 native Agent Kernel behavior.

Migrated core behavior must not silently fall back into Hermes Runtime or legacy Zero3 Node.

## Retired Zero3 Node desktop direction

Earlier development phases routed the desktop through `zero3-pilot-node` for chat/memory/schedules/browser behavior. That direction is retired as native desktop authority.

Historical overlay files may remain for migration provenance, but they must not be reactivated to bypass the Codex-native boundary or receive new target-core feature work.

## Pinned upstreams

Preparation is tied to reviewed upstream SHAs and fails closed on pin drift.

```text
Codex            94311d447587411789533c47601fd8bc9d81eb48
Hermes Agent     f7c79efbac19ae18e8dee7c79a4e4c0935299b5f
DeepSeek-Harness cd5ef8148158c3a752a658978873241fdf8e2bbc
```

## Commands

Development/static preparation:

```powershell
npm run prepare
npm run typecheck
npm run dev
```

Windows package candidate:

```powershell
npm run dist:win
```

Repository architecture guard before changes:

```powershell
node ../../scripts/check-architecture.mjs
```

Specialized Windows/Codex/feature workflows remain the authoritative release evidence; the existence of a command or test file is not itself a PASS.

## Current follow-up boundary

The R3B-R3F desktop parity work referenced by older versions of this README is already merged. Remaining follow-up should focus on still-unported shell surfaces, reviewed permission/MCP elicitation UX where needed, compatibility-backend removal and post-alpha collaboration/productization work.

Those follow-ups must preserve the same authority rule: OpenAI's open-source Codex remains the only native Agent Kernel. Do not implement a second Zero3/Hermes agent loop, tool loop, MCP runtime or approval engine to fill a UI gap.

## Upstream modification policy

Hermes source is an upstream UI source tree, not the Zero3 core. Overlays remain deterministic and must fail closed when pinned source assumptions drift. Do not move Zero3 native runtime/business authority into Hermes Agent's Python runtime.

Codex source changes are allowed only as deliberate reviewed Zero3 secondary-development patches/extensions with provenance, tests and clear ownership.

## Legacy desktop

`apps/desktop` is the older Rust/Tao/Wry shell. It remains for rollback/history/compatibility evidence only and is not the target product UI or the first-alpha Windows distribution path.

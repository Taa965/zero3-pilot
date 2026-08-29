# Zero3 Desktop — Hermes UI shell over Codex core

This directory owns the target Zero3 desktop migration.

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
Zero3 typed preload adapter
        |
Electron main Codex client
        |
codex app-server --stdio
        |
open-source Codex
```

Codex Thread / Turn / Item and app-server notifications must become the authoritative desktop session/execution model.

## R0 architecture reset

Earlier Phase B work routed the Hermes-derived UI through `zero3-pilot-node` for chat, memory, schedules and browser control. That direction is retired.

The files implementing those old overlays may remain temporarily for migration archaeology, but **`prepare-upstream.mjs` must not apply them**:

- `apply-native-bridge.mjs`
- `apply-native-chat.mjs`
- `apply-native-chat-hardening.mjs`
- `apply-memory-bridge.mjs`
- `apply-schedule-bridge.mjs`
- `apply-schedule-lifecycle.mjs`
- `apply-browser-bridge.mjs`

They must not receive new feature work.

R0 keeps only shell-level transformations:

1. product branding;
2. removal of Hermes-specific commercial/distribution surfaces that do not belong to Zero3;
3. Chinese-first localization;
4. provenance/pin validation.

The target desktop launcher no longer builds or starts Zero3 Node.

## Temporary Hermes compatibility backend

The pinned Hermes Desktop currently expects a Hermes backend to boot. Until the Codex app-server transport replaces that dependency, `npm run dev` may prepare/start Hermes' compatibility backend **only to keep the UI shell renderable**.

That compatibility backend is not allowed to own new Zero3 product state, memory, scheduling, browser/computer workflows, or primary conversation semantics.

## Pinned upstreams

Exact SHAs live in `scripts/config.mjs` and preparation fails closed on pin mismatch.

```text
upstream/codex           core
upstream/hermes-agent    UI shell
upstream/deepseek-harness capability donor
```

## Commands

```powershell
npm run prepare
npm run typecheck
npm run dev
npm run dist:win
```

`npm run prepare` applies only the R0 shell overlays. `npm run dev` launches the shell compatibility environment; it does not launch Zero3 Node.

Before changes:

```powershell
node ../../scripts/check-architecture.mjs
```

## Next implementation phase: R1

R1 must introduce a Zero3-owned Codex app-server client with:

- process resolution/lifecycle;
- JSONL request/response correlation;
- `initialize` / `initialized` handshake;
- typed Thread / Turn APIs;
- notification stream;
- interruption and approval routing;
- narrow Electron preload surface.

Only after R1 is stable should the main Hermes chat/session UI be moved from its temporary Hermes transport to Codex.

## Upstream modification policy

Hermes source is an upstream UI source tree, not the Zero3 core. All overlays remain deterministic and fail closed when the pinned source changes. Do not implement business/runtime logic directly inside Hermes Agent's Python runtime.

Codex source changes are allowed only as deliberate Zero3 secondary-development patches with review, tests and clear ownership. Keeping Codex pristine is not more important than keeping Codex authoritative.

## Legacy desktop

`apps/desktop` is the older Rust/Tao/Wry shell. It remains for rollback/history only and is not the target product UI.

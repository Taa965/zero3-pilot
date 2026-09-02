# Zero3 Pilot Architecture

This document describes the **current `main` architecture** of Zero3 Pilot. Historical phase-specific documents remain useful for implementation provenance, but the non-negotiable authority rules live in [`ARCHITECTURE_CONSTITUTION.md`](ARCHITECTURE_CONSTITUTION.md) and this file is the current implementation summary.

## 1. Runtime authority

Zero3 Pilot is a Codex-core desktop application.

**OpenAI's open-source Codex is the authoritative native Agent Kernel/runtime** for:

- Thread / Turn / Item conversation state;
- the primary agent loop and context;
- model/tool execution semantics;
- shell/files and related tool activity;
- approvals and user-input requests;
- MCP and Codex-native execution surfaces;
- interruption/resume and authoritative conversation history.

Zero3 may extend, present or orchestrate that runtime through reviewed boundaries, but it must not introduce a second hidden primary agent loop, tool loop, MCP runtime or approval engine.

## 2. Product topology

```text
                         Zero3 Pilot
                              |
                  Hermes-derived Desktop UI
                   (Electron + React shell)
                              |
                       Zero3 UI Adapter
                              |
                       codex app-server
                              |
               open-source Codex Agent Kernel
                              |
          +-------------------+-------------------+
          |                   |                   |
   Codex-native          Executor/Handoff      Remote Host
    extensions              orchestration       integration
          |                   |                   |
  output/context        Native Codex +       durable host /
    retention          external providers     control plane
          |
  donor-derived ideas
  re-expressed through
  reviewed Zero3 seams
```

### Upstream roles

- `upstream/codex/` — **CORE**, authoritative native Agent Kernel/app-server source.
- `upstream/hermes-agent/` — **UI SHELL SOURCE**, Electron/React desktop UX donor. Remaining Hermes runtime use is compatibility scaffolding only.
- `upstream/deepseek-harness/` — **CAPABILITY DONOR/REFERENCE**, never the default parallel native runtime.

Installed Codex/Claude/Hermes applications may participate as external collaborators/executors. They do not become the native Zero3 kernel.

## 3. Pinned upstream and managed Codex overlay

The reviewed pins currently recorded by the repository are:

```text
Codex            94311d447587411789533c47601fd8bc9d81eb48
Hermes Agent     f7c79efbac19ae18e8dee7c79a4e4c0935299b5f
DeepSeek-Harness cd5ef8148158c3a752a658978873241fdf8e2bbc
```

The Codex gitlink remains pinned. Zero3-specific Codex work is represented by the managed `codex-overlays/` system, which verifies the expected base, rejects unmanaged/unlisted patch drift, applies reviewed extensions/patches in manifest order and supports detached replay against candidate upstream revisions.

The active merged resilience features include:

- **D1 / `zero3-output-retention`** — lossless oversized plain-text tool-result spill/recovery with bounded model projection;
- **D2 / `zero3-context-retention`** — recoverable pruning of oversized historical tool results only in private compaction/model input.

Those features reuse Codex execution/history authority rather than creating a second tool or persistence authority.

See [`UPSTREAM.md`](UPSTREAM.md) for the full pin/overlay policy.

## 4. Target desktop path

The target desktop shell is prepared under `apps/zero3-desktop/` from the pinned Hermes Electron/React source and wired to Codex through Zero3-owned typed boundaries.

### R1A — Codex app-server transport — merged

Electron main owns the pinned `codex app-server --stdio` child, initialization, JSONL framing, request correlation/timeouts, bounded server-request forwarding and process lifecycle. Renderer access is purpose-specific; there is no supported generic Renderer-controlled `method + params` Codex RPC tunnel.

### R2A/R2B — primary chat, approvals and input — merged

The visible primary conversation path maps onto Codex semantics:

```text
new conversation -> thread/start
list/restore      -> thread/list + thread/read/resume
send              -> turn/start
stop              -> turn/interrupt
```

Selected Codex command/file approval and user-input server requests are presented through Zero3 UI and answered through the typed boundary. Unsupported request classes fail closed.

### R3A/R3B — native Item presentation — merged

The presentation adapter covers Codex-native Item families including reasoning, command execution, file changes, MCP tool calls, dynamic tool calls, plans and web search. Projection into Hermes-derived components is presentation-only and does not move execution authority into Hermes.

### R3C — structured user input — merged

The primary composer uses a validated Codex `UserInput[]` bridge, including supported local-image input. Renderer payloads are reconstructed/validated at the reviewed Electron boundary rather than used as an arbitrary protocol passthrough.

### R3D — native Thread actions — merged

Codex-native archive/unarchive/delete/rename/fork and active-Turn steering are implemented through reviewed typed surfaces.

### R3E/R3F — authoritative Turn mapping and paginated history — merged

Message/history-sensitive operations resolve presentation state against authoritative Codex Thread/Turn/Item history. Destructive/history-sensitive flows use authoritative paginated history and fail closed when identity or pagination is incomplete/ambiguous.

## 5. Durable Zero3 conversation source (#49)

[PR #49](https://github.com/Taa965/zero3-pilot/pull/49) is merged and is part of the first-alpha candidate.

Pinned Codex distinguishes AppServer transport from persisted session source. Zero3 explicitly launches its Codex child with `--session-source app-server` and lists `sourceKinds: ['appServer']`, preventing unrelated VS Code Codex history from being treated as Zero3 conversation history.

The release-blocking regression smoke uses normal durable materialization: create two non-ephemeral Threads, start a first Turn on each, restart app-server with the same `CODEX_HOME`, then require both original IDs through AppServer-source list/read operations.

Development sessions created before explicit Zero3 AppServer source tagging may have been persisted under Codex's `vscode` source; the first public alpha does not promise automatic migration of that pre-release state.

## 6. Remote Host architecture

Remote Host allows remotely admitted development tasks to reach a local Zero3/Codex execution host through narrow reviewed boundaries while preserving Codex as execution authority.

Merged H0-H5 invariants include:

- exact task/execution identity binding;
- workspace allow-listing;
- durable task -> Codex mapping and restart recovery;
- crash-safe durable outbox with ack-before-delete;
- strict publication ordering;
- authenticated durable control-plane state;
- sticky leases and fencing generations;
- replay/terminal idempotency and fail-closed identity handling.

The Remote Host/control plane does not expose a generic remote Codex RPC/shell authority and does not become the native Agent Kernel.

See [`REMOTE_HOST_RUNTIME.md`](REMOTE_HOST_RUNTIME.md), [`H4_REMOTE_OUTBOX_DESIGN.md`](H4_REMOTE_OUTBOX_DESIGN.md) and [`H5_REMOTE_CONTROL_PLANE.md`](H5_REMOTE_CONTROL_PLANE.md).

## 7. Executor, Handoff and Failover

Zero3 has a provider-neutral execution orchestration layer **outside** the Codex native Agent Kernel.

- **Codex native kernel** defines native agent execution semantics.
- **Zero3 Executor/Router/Handoff** decides which approved executor/provider is assigned to a Zero3 Task/Execution and how durable workspace authority moves.
- An external provider never becomes the native kernel merely by being selectable.

### R4A — `zero3.pilot.executor.v1` — merged

The frozen provider-neutral contract carries Task/Execution identity, workspace and lease/fencing identity where applicable, executor session/probe/event/failure contracts, normalized Zero3-owned failure policy, Registry/Manager authority and provider-neutral routing surfaces.

### R4E — durable Handoff — merged

The Handoff layer records deterministic Git/workspace checkpoint evidence, uses crash-safe persistent state and enforces an exclusive writer/generation transfer. A new executor cannot become workspace writer merely by starting a process.

### R4F — failover controller — merged

Failover supports ordered candidates, bounded retry, cooldown/circuit-breaker state, recovery-first behavior, context-loss handoff requirements, manual/automatic switching controls, return-to-primary boundaries, duplicate-event idempotency and restart-serializable state. User stop and policy/permission/budget/bad-request classes are not converted into automatic provider switching just to keep work running.

### R4C — Native Codex executor — merged

The Native Codex `Zero3Executor` uses the same pinned `codex app-server` kernel through a controller-owned process. It uses supported account/rate-limit APIs, does not extract/copy Codex credential files, forwards explicit permission decisions, and maps resume-context loss to a typed failure rather than silently starting a replacement Thread.

### R4B — ACP/external executor — deferred from first alpha

[PR #48](https://github.com/Taa965/zero3-pilot/pull/48) remains open and is **not included in `v0.1.0-alpha`**. Its dedicated cross-platform behavior gate has unresolved deny/cancellation and protocol-version classification semantics. It will be replayed/repaired/revalidated post-alpha rather than weakening the first-release boundary.

## 8. Windows package authority (#51)

[PR #51](https://github.com/Taa965/zero3-pilot/pull/51) is merged and establishes the Codex-native Windows packaging path.

The release package:

- builds the exact reviewed pinned Codex source in release mode;
- bundles it as `resources/zero3-codex/codex.exe`;
- requires packaged mode to use that bundled binary rather than PATH, `@latest`, runtime download or arbitrary external override;
- includes required Zero3/OpenAI Codex/Hermes license/NOTICE material;
- builds an NSIS candidate with automatic publication disabled in CI;
- verifies the packaged Codex binary with `--version` and a real app-server JSONL smoke;
- computes an installer SHA-256 for evidence.

The #51 pull-request merge candidate already contained merged #49 and passed the Windows Alpha Artifact gate. That is integrated pre-tag evidence, not a substitute for exact final release-SHA validation.

## 9. Legacy / compatibility components

### `apps/node`

Legacy/extension host for older jobs/schedule/memory/provider paths. It is not the target desktop native runtime authority.

### legacy Rust/Wry desktop

Retained for migration/installer history and compatibility tests. The current product target is the Hermes-derived Electron/React Codex-core desktop path.

### Hermes compatibility backend

Some unported UI surfaces may still require Hermes backend scaffolding. No new target core capability should expand Hermes Runtime authority; migrated core paths must remain Codex-owned.

### historical `zero3-subagents` naming

Historical naming may remain in compatibility crates. External-agent work belongs under the Executor/Collaboration model and must preserve Codex native-kernel authority.

## 10. CI and release invariants

Release evidence is intentionally split across focused gates:

- architecture guard;
- repository Rust/static gates where applicable;
- Windows target-shell prepare/typecheck/build;
- real pinned-Codex CLI/app-server smoke;
- Codex overlay verify/replay;
- R3 structured-input/thread/history gates;
- D1/D2 retention gates;
- Remote Host H-series reliability/control-plane gates;
- R4 Executor/Handoff/Failover/Native Codex gates;
- Windows Alpha Artifact package/bundled-Codex smoke and checksum evidence.

A green legacy/provider test is compatibility evidence, not permission for that component to become the native Agent Kernel.

## 11. Current first-alpha closeout status

PRs #49, #51 and #52 are merged. The first-alpha implementation/documentation blockers are therefore on `main`.

Zero3 Pilot still has **no published GitHub Release/tag**. Before `v0.1.0-alpha` is considered complete, one exact final `main` SHA must receive the required release evidence, including final Windows artifact/checksum verification, and the matching tag/GitHub pre-release must be published and verified.

The remaining open PR #48 is explicitly deferred and is not a first-alpha blocker.

Release criteria are tracked in:

- [`../ROADMAP.md`](../ROADMAP.md);
- [`../CHANGELOG.md`](../CHANGELOG.md);
- [`RELEASE_PROCESS.md`](RELEASE_PROCESS.md);
- [`releases/v0.1.0-alpha.md`](releases/v0.1.0-alpha.md);
- public release-readiness Issue #50.

Until the exact-candidate validation and publication facts exist, release tests not actually run must remain `NOT_RUN` rather than being inferred from older PR artifacts.

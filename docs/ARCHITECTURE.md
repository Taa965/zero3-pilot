# Zero3 Pilot Architecture

This document describes the **current `main` architecture** of Zero3 Pilot. Historical phase-specific details remain in the linked R2/R3/H/D documents and in merged PRs, but this file is the public summary of what currently owns runtime authority and what has actually been merged.

The non-negotiable rules live in [`ARCHITECTURE_CONSTITUTION.md`](ARCHITECTURE_CONSTITUTION.md).

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

Zero3 may extend, present or orchestrate that runtime through reviewed boundaries, but it must not silently introduce a second hidden primary agent loop.

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

The reviewed pins currently recorded by `codex-overlays/manifest.json` are:

```text
Codex            94311d447587411789533c47601fd8bc9d81eb48
Hermes Agent     f7c79efbac19ae18e8dee7c79a4e4c0935299b5f
DeepSeek-Harness cd5ef8148158c3a752a658978873241fdf8e2bbc
```

The upstream Codex gitlink remains pinned. Zero3-specific Codex work is represented by the managed `codex-overlays/` system:

1. verify the exact Codex base SHA;
2. reject unmanaged Codex worktree changes;
3. install explicitly listed Zero3 extensions;
4. apply explicitly listed patches in deterministic manifest order;
5. reject unlisted/missing/unreplayable patches;
6. replay the overlay in a detached candidate Codex worktree to detect upstream drift;
7. run Codex format/build/app-server and architecture gates.

The active merged overlay features are currently:

- **D1 / `zero3-output-retention`** — lossless oversized plain-text tool-result spill/recovery with bounded model projection;
- **D2 / `zero3-context-retention`** — recoverable pruning of oversized historical tool results only in private compaction input.

Those features reuse Codex execution/compaction authority; they do not introduce a second tool or history authority.

See [`UPSTREAM.md`](UPSTREAM.md) for the full overlay/pin policy.

## 4. Target desktop path

The target desktop shell is prepared under `apps/zero3-desktop/` from the pinned Hermes Electron/React source and wired to Codex through a Zero3-owned typed boundary.

### R1A — Codex app-server transport — merged

Electron main owns a `codex app-server --stdio` child and handles:

- explicit pinned Codex executable selection;
- `initialize` / `initialized` lifecycle;
- JSONL framing and request-id correlation;
- notification forwarding;
- bounded server-originated request forwarding;
- child lifecycle and cleanup.

Renderer access is purpose-specific. There is no supported arbitrary Renderer-controlled `method + params` Codex RPC tunnel.

### R2A — primary chat -> Codex Thread/Turn/Item — merged

The visible primary conversation path maps the Hermes-derived presentation shell onto Codex semantics:

- new conversation -> `thread/start`;
- recents/restore -> Codex Thread list/read/resume;
- send -> `turn/start`;
- streaming -> Codex Item notifications/deltas;
- Stop/Esc -> `turn/interrupt`.

Hermes-derived stores are presentation adapters on this path, not runtime authority.

See [`CODEX_PRIMARY_CHAT_R2.md`](CODEX_PRIMARY_CHAT_R2.md).

### R2B — native approval and input — merged

Selected server-originated Codex requests are presented through Zero3-owned UI and answered through the typed server-response surface:

- command execution approval;
- file-change approval;
- user-input requests.

Prompt state is correlated/queued per Thread and unresolved callbacks are cleared/rejected on terminal/interruption/error paths.

Unsupported request classes remain fail-closed until they receive dedicated reviewed UX.

The current conservative baseline keeps `approvalPolicy=on-request` and does not make `workspace-write` the unconditional default sandbox.

### R3A/R3B — native Item presentation — merged

The presentation adapter covers Codex-native Item families including:

- reasoning;
- command execution;
- file change;
- MCP tool calls;
- dynamic tool-call presentation;
- plans;
- web search.

Presentation does not move execution authority into Hermes.

See [`CODEX_MORE_ITEMS_R3B.md`](CODEX_MORE_ITEMS_R3B.md).

### R3C — structured user input — merged

The primary composer supports a validated Codex `UserInput[]` bridge, including supported local-image inputs. Renderer input is reconstructed/validated by the reviewed Electron boundary rather than used as an arbitrary protocol passthrough.

See [`CODEX_STRUCTURED_INPUT_R3C.md`](CODEX_STRUCTURED_INPUT_R3C.md).

### R3D — native Thread actions — merged

Migrated actions include Codex-native:

- archive / unarchive;
- permanent delete;
- rename;
- whole-Thread fork;
- active-Turn steer.

See [`CODEX_THREAD_ACTIONS_R3D.md`](CODEX_THREAD_ACTIONS_R3D.md).

### R3E — authoritative message/Turn mapping — merged

Message-level history operations resolve presentation messages against authoritative Codex Thread/Turn/Item history rather than guessing by index/timestamp.

This provides reviewed boundaries for exact fork/revert/regenerate flows while keeping unsupported ambiguous cases fail-closed.

See [`CODEX_TURN_MAPPING_R3E.md`](CODEX_TURN_MAPPING_R3E.md).

### R3F — authoritative paginated history — merged

Destructive/history-sensitive flows use authoritative paginated Codex history and fail closed on incomplete/invalid pagination conditions.

See [`CODEX_AUTHORITATIVE_HISTORY_R3F.md`](CODEX_AUTHORITATIVE_HISTORY_R3F.md).

## 5. Context/output resilience

### D0 — managed overlay foundation — merged

D0 establishes deterministic extension/patch installation, exact pin checks and detached replay/drift detection.

### D1 — output retention — merged

Oversized plain-text tool results can be stored losslessly outside model context and represented to the model through a bounded projection with an opaque recovery reference.

Recovery tools operate through the installed spill-store contract. Storage/projection behavior is designed not to become tool-execution authority.

### D2 — context retention — merged

D2 prunes only recoverable oversized historical tool results in the **private cloned history used for compaction/model input**.

It does not mutate authoritative persisted Thread/Turn/Item history. D2 reuses D1's spill/recovery authority rather than creating a second persistence system.

## 6. Remote Host architecture

Remote Host allows remotely admitted development tasks to reach a local Zero3/Codex execution host through narrow reviewed boundaries while preserving Codex as execution authority.

### H0-H3 — local host runtime — merged

Key invariants include:

- exact task/execution identity binding;
- local workspace allow-listing;
- durable task -> Codex mapping;
- deterministic user-message identity for crash recovery;
- durable pending-Turn intent;
- authoritative restart recovery;
- fail-closed handling of ambiguous side effects and unsupported Git preconditions.

The Remote Host adapter is intentionally narrow and does not expose a generic remote Codex RPC/shell path.

See [`REMOTE_HOST_RUNTIME.md`](REMOTE_HOST_RUNTIME.md).

### H4/H4.1 — durable ordered outbox — merged

Remote evidence/terminal publication follows a crash-safe rule:

```text
persist committed envelope
        -> drain older committed envelopes in order
        -> publish
        -> durable acceptance/ack
        -> delete local pending envelope
```

Stale lease/fencing outcomes quarantine identity rather than mutating it into a new authority.

See [`H4_REMOTE_OUTBOX_DESIGN.md`](H4_REMOTE_OUTBOX_DESIGN.md).

### H5 — durable control plane — merged

The control plane owns remote task/node admission state, sticky leases, fencing generations, durable accepted mirrors and replay/terminal validation.

It does **not** become Codex execution authority and must not expose shell/files/MCP/Codex generic RPC as a control-plane shortcut.

See [`H5_REMOTE_CONTROL_PLANE.md`](H5_REMOTE_CONTROL_PLANE.md).

## 7. Executor, Handoff and Failover

Zero3 now has a provider-neutral execution orchestration layer outside the Codex native Agent Kernel.

The distinction is important:

- **Codex native kernel** defines native agent execution semantics;
- **Zero3 Executor/Router/Handoff** decides which approved executor/provider is assigned to a Zero3 Task/Execution and how durable work authority moves between providers;
- an external provider never becomes the native kernel merely by being selectable.

### R4A — `zero3.pilot.executor.v1` — merged

The frozen provider-neutral contract carries:

- Task / Execution identity;
- workspace and optional lease/fencing identity;
- executor session/probe/event/failure contracts;
- normalized Zero3-owned failure taxonomy/policy;
- Registry/Manager authority with one active binding per task/execution;
- provider-neutral routing surfaces.

Raw provider-private exceptions/types are not supposed to become shared policy authority.

### R4E — durable Handoff — merged

The Handoff layer records deterministic Git/workspace checkpoint evidence, uses crash-safe persistent state and enforces an exclusive writer/generation transfer.

A new executor cannot become workspace writer merely by starting a process; it must satisfy the Handoff acceptance/verification contract.

### R4F — failover controller — merged

The Zero3-owned failover controller implements:

- ordered candidates;
- bounded retry;
- provider cooldown/circuit-breaker state;
- recovery-first decisions;
- context-loss handoff requirements;
- manual/automatic switching controls;
- return-to-primary at defined boundaries;
- duplicate-event idempotency and restart-serializable state.

User stop and policy/permission/budget/bad-request classes are not converted into automatic provider switching just to keep work running.

### R4C — Native Codex executor — merged

A real Native Codex `Zero3Executor` uses the same pinned open-source `codex app-server --stdio` kernel through a controller-owned child process.

Important boundaries include:

- explicit per-executor Codex home selection;
- supported `account/read` / rate-limit probing rather than credential-file parsing;
- no `auth.json` token extraction/copy/serialization;
- explicit permission decision forwarding;
- resume failure -> typed context loss rather than silently starting a replacement Thread.

### R4B — ACP/external executor — open, not merged

[PR #48](https://github.com/Taa965/zero3-pilot/pull/48) is the formal ACP external-executor implementation and is **not part of the merged `main` capability until merged**.

Older audit/POC PRs for R4B/R4C are historical exploration and must not be treated as the authoritative implementation when a formal merged path exists.

## 8. First-alpha closeout and remaining reliability work

[PR #49](https://github.com/Taa965/zero3-pilot/pull/49) is merged. Zero3 now explicitly launches pinned Codex with `--session-source app-server`, lists the matching `sourceKinds: ['appServer']` namespace, and carries a real first-Turn cold-restart persistence smoke for two durable Threads.

[PR #51](https://github.com/Taa965/zero3-pilot/pull/51) is merged. The Windows alpha packaging path builds the exact reviewed Codex pin, bundles `resources/zero3-codex/codex.exe`, carries required legal notices, fails closed against arbitrary packaged-runtime substitution, builds an NSIS candidate and verifies the packaged binary with a real app-server smoke plus installer SHA-256 generation.

[PR #52](https://github.com/Taa965/zero3-pilot/pull/52) merged the public release-document closeout. The #51 pull-request merge candidate already contained merged #49 and passed the integrated Windows Alpha Artifact gate; that is pre-tag evidence, not a substitute for final exact-release-SHA validation.

The remaining open [PR #48](https://github.com/Taa965/zero3-pilot/pull/48) is explicitly deferred from `v0.1.0-alpha` because its ACP behavior semantics remain red; it is not a first-alpha blocker.

Remote Host -> Executor Manager/Handoff/Failover integration remains follow-up work; H5 remote-control authority and the R4 execution contracts must be connected without weakening either set of invariants.

## 9. Legacy / compatibility components

The repository still contains older components that remain useful as compatibility evidence or future extension sources.

### `apps/node`

Legacy/extension host for older jobs/schedule/memory/provider paths. It is not the target desktop native runtime authority.

### legacy Rust/Wry desktop

Retained for migration/installer history and compatibility tests. New target UI/runtime work belongs in the Hermes-derived Codex-core desktop path.

### Hermes compatibility backend

Some unported UI surfaces may still require Hermes backend scaffolding during development. No new target core capability should be implemented by expanding Hermes Runtime authority.

### old `zero3-subagents` naming

Historical naming may remain in compatibility crates. External agent work belongs under the Executor/Collaboration model and must preserve Codex native-kernel authority.

## 10. CI invariants

The repository uses multiple independent gates rather than one “everything passed” script.

Core/public evidence includes:

- architecture guard;
- Rust format/Clippy/build/tests;
- Windows target-shell prepare/typecheck/build;
- real pinned-Codex CLI/app-server JSONL smoke;
- Codex overlay verify/replay;
- R3 structured-input/thread/history gates;
- D1/D2 retention gates;
- Remote Host H-series reliability/control-plane gates;
- R4 Executor/Handoff/Failover/Native Codex gates;
- Windows Alpha Artifact package/bundled-Codex smoke and checksum evidence for the release candidate.

Legacy/provider smokes may remain green while the target architecture evolves. Their success proves compatibility of those components, not ownership of the native Agent Kernel.

The local `scripts/dev-check.sh` covers the practical repository-level core checks; specialized Windows/Codex/feature gates remain authoritative in GitHub Actions.

## 11. Current release status

Zero3 Pilot has **no published GitHub Release yet** and remains pre-release.

The first planned release is `v0.1.0-alpha`. PRs #49, #51 and #52 are merged, but the exact final `main` candidate still requires the release evidence defined by the release process, including final Windows artifact/checksum verification and matching tag/GitHub pre-release publication.

Release criteria are tracked in:

- [`../ROADMAP.md`](../ROADMAP.md);
- [`../CHANGELOG.md`](../CHANGELOG.md);
- [`RELEASE_PROCESS.md`](RELEASE_PROCESS.md);
- [`releases/v0.1.0-alpha.md`](releases/v0.1.0-alpha.md);
- public release-readiness Issue #50.

Public documentation should describe merged `main` capability and clearly label open PR/POC work as unmerged. Evidence not actually executed on the exact release candidate must remain `NOT_RUN` rather than being inferred from older PR artifacts.

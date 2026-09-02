# Zero3 Pilot Roadmap

Zero3 Pilot is in active pre-release development. This roadmap describes the public product direction and separates capabilities already merged to `main` from work that is still under review.

The governing rule is unchanged: **open-source Codex remains the authoritative native Agent Kernel/runtime.** New features must extend that runtime or integrate through reviewed boundaries rather than creating a second hidden agent core.

## Already on `main`

### Codex-native desktop path

The primary desktop path has progressed through R1A-R3F:

- typed `codex app-server --stdio` lifecycle and IPC boundary;
- Codex Thread / Turn / Item-backed primary chat and restore;
- native command/file approvals and `request_user_input` handling;
- reasoning, command execution, file-change, MCP, dynamic-tool, plan and web-search presentation;
- structured user input including supported local-image inputs;
- native thread archive/unarchive/delete/rename/fork and active-turn steer;
- authoritative Item -> Turn mapping for history mutation boundaries;
- authoritative paginated Codex history for destructive-history operations.

### Codex integration resilience

- deterministic pinned-Codex overlay/replay infrastructure (D0);
- lossless oversized tool-output spill/recovery with bounded model projection (D1);
- recoverable pruning of oversized historical tool results in compaction input without mutating authoritative history (D2).

### Remote Host and control-plane reliability

- Remote Host H0-H3 local runtime over the narrow Codex Thread/Turn boundary;
- crash-safe durable outbox and strict publication ordering (H4/H4.1);
- durable authenticated Remote Host control plane with task/node persistence, leases, fencing and replay/terminal validation (H5).

### Executor and handoff foundation

- stable `zero3.pilot.executor.v1` provider-neutral Executor contract (R4A);
- durable, fail-closed Git/workspace handoff protocol (R4E);
- automatic failover policy with retry/cooldown/circuit-breaker and recovery-first semantics (R4F);
- Native Codex `Zero3Executor` backed by the pinned Codex app-server, with explicit permission forwarding and credential-file isolation rules (R4C).

## Active work before the first public alpha

### Release blocker: durable primary-session restart

[PR #49](https://github.com/Taa965/zero3-pilot/pull/49) fixes AppServer Thread discovery after restart and adds a real pinned-Codex persistence smoke. This should be resolved before the first alpha tag because durable conversation restoration is a basic desktop-agent expectation.

### External executor runtime

[PR #48](https://github.com/Taa965/zero3-pilot/pull/48) is the formal R4B ACP external-executor implementation. It is useful for the first alpha but is not allowed to delay a Codex-native alpha indefinitely: if its final integration gates are not clean, it can ship in the next pre-release instead.

Older audit/POC PRs must be closed or clearly marked superseded once their formal implementations have landed. Open history should not make contributors guess which branch is authoritative.

### Public alpha productization

Before `v0.1.0-alpha` is published:

- all release-blocking CI and architecture gates must be green on the tag candidate;
- the current Windows target desktop path must have a documented reproducible build path;
- known limitations must be explicit rather than hidden behind roadmap language;
- release notes and changelog must match the exact tagged SHA;
- no known critical security-boundary regression may remain open;
- public screenshots or a short demo should be added once they can be captured from the real target desktop build;
- stale/superseded draft PRs should be cleaned up so the repository presents one current implementation path.

Draft release notes live at [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md).

## After `v0.1.0-alpha`

### R4 / collaboration completion

- finish and integrate the external-agent executor boundary;
- connect Remote Host task execution to the frozen Executor Manager / Handoff / Failover contracts without weakening H5 lease/fencing/outbox invariants;
- expose executor selection, failover and handoff evidence in the desktop UI;
- continue to keep external Codex/Claude/Hermes applications as collaborators, not alternate native kernels.

### Productization

- provider-neutral self-host packaging;
- secure pairing/rotation/revocation flow;
- reproducible Windows distribution for the Codex-native target shell;
- onboarding and diagnostics for Codex pin/runtime/auth compatibility;
- release/update channel that preserves upstream provenance and security boundaries.

### Codex-native extensions

Migrate or attach useful Zero3 capabilities through reviewed Codex extension seams, including:

- scheduler / automation;
- project memory;
- browser and computer-use providers;
- messaging/channel ingress;
- workflows and higher-level task orchestration.

### Capability-donor work

DeepSeek-Harness and other projects remain capability donors/reference sources. Any adopted capability must receive:

1. license/provenance review;
2. an explicit Codex-native integration location;
3. architecture and security review;
4. deterministic tests/benchmarks where applicable.

## Non-goals

Zero3 Pilot will not improve apparent feature count by:

- introducing a second hidden primary agent loop beside Codex;
- copying credentials or parsing Codex auth files to bypass supported account APIs;
- exposing a generic Renderer-controlled Codex JSON-RPC tunnel;
- silently falling back to Hermes Runtime or legacy Zero3 Node for migrated core operations;
- claiming broad adoption, production readiness or release status before public evidence exists.

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`SECURITY.md`](SECURITY.md) for the detailed authority and security boundaries.

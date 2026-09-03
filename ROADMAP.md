# Zero3 Pilot Roadmap

Zero3 Pilot is in active pre-1.0 development. The first public release line is `v0.1.0-alpha`; this roadmap separates that frozen baseline from post-alpha work.

The governing rule is unchanged: **open-source Codex remains the authoritative native Agent Kernel/runtime.** New features must extend that runtime or integrate through reviewed boundaries rather than creating a second hidden agent core.

## `v0.1.0-alpha` baseline

### Codex-native desktop path

The primary desktop path progressed through R1A-R3F:

- typed `codex app-server --stdio` lifecycle and IPC boundary;
- Codex Thread / Turn / Item-backed primary chat and restore;
- native command/file approvals and `request_user_input` handling;
- reasoning, command execution, file-change, MCP, dynamic-tool, plan and web-search presentation;
- structured user input including supported local-image inputs;
- native thread archive/unarchive/delete/rename/fork and active-turn steer;
- authoritative Item -> Turn mapping for history mutation boundaries;
- authoritative paginated Codex history for destructive-history operations.

### Durable Zero3 AppServer conversation identity (#49)

[PR #49](https://github.com/Taa965/zero3-pilot/pull/49) is merged.

Zero3 explicitly launches the pinned Codex child with `--session-source app-server` and lists the matching `sourceKinds: ['appServer']` namespace. The release regression smoke creates two non-ephemeral Threads, materializes a first Turn on each, restarts app-server with the same `CODEX_HOME`, then requires both original IDs to remain listable and readable.

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

### Codex-native Windows packaging (#51)

[PR #51](https://github.com/Taa965/zero3-pilot/pull/51) is merged.

The Windows release path:

- builds the exact reviewed pinned Codex source in release mode rather than resolving an arbitrary installed CLI;
- carries `codex.exe` under `resources/zero3-codex/codex.exe`;
- requires packaged mode to use the bundled binary rather than PATH, `@latest`, runtime download or an arbitrary host override;
- carries required Zero3, OpenAI Codex and Hermes license/NOTICE material;
- produces an NSIS artifact with publishing disabled inside the build gate;
- exercises `--version` and a real app-server JSONL smoke against the packaged Codex binary.

### Final Alpha release hygiene (#54)

[PR #54](https://github.com/Taa965/zero3-pilot/pull/54) is merged.

It repaired the public desktop-orchestrator `codex:verify` / `codex:replay` commands and changed the historical `zero3-web` deployment workflow to manual-only. Moving `main` no longer automatically deploys the retired web/control prototype.

Every #54 PR workflow completed successfully, including CI with Ubuntu Clippy, Codex Core/Overlay, D1/D2, R3C-R3F, H0-H5 and Windows Alpha Artifact.

The release owner explicitly waived an additional local Windows exact-main rerun after #54. That waiver is recorded as `WAIVED_BY_RELEASE_OWNER`, not as PASS. The public Windows binary remains evidence-bound through the tag-triggered Windows Alpha Artifact workflow.

## Explicitly deferred from `v0.1.0-alpha`

### R4B ACP external executor

[PR #48](https://github.com/Taa965/zero3-pilot/pull/48) is the formal ACP external-executor runtime, but it is **not part of the first public alpha**.

The decision is evidence-driven:

- the branch predates the merged Native Codex R4C path and requires replay/rebase onto the authoritative stack;
- its dedicated R4B behavior suite exposed incorrect deny/cancellation and protocol-version-classification semantics;
- the provider path is therefore deferred rather than weakening the first-alpha gate.

## After `v0.1.0-alpha`

### Collaboration / delivery control-plane completion

- repair/rebase/revalidate the formal ACP external-agent executor (#48), including deny/cancellation and protocol-version classification semantics;
- connect Remote Host task execution to the frozen Executor Manager / Handoff / Failover contracts without weakening H5 lease/fencing/outbox invariants;
- expose executor selection, failover and handoff evidence in the desktop UI;
- build higher-level software-delivery orchestration on top of the existing Executor/Handoff/Failover contracts while keeping Codex as the sole native Agent Kernel;
- continue to keep external Codex/Claude/Hermes applications as collaborators, not alternate native kernels.

### Productization

- code-signing and release/update-channel hardening for Windows distribution;
- secure pairing/rotation/revocation flow;
- onboarding and diagnostics for Codex pin/runtime/auth compatibility;
- remove remaining Hermes compatibility-backend assumptions as UI surfaces are migrated;
- CI concurrency/caching improvements that preserve release-gate strength while cancelling superseded PR runs.

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
- claiming production readiness or broad adoption without evidence;
- merging a provider integration whose own cross-platform behavior contract is red merely to increase release scope.

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`CHANGELOG.md`](CHANGELOG.md) and [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md).

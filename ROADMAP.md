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

### Release blocker: durable primary-session restart (#49)

[PR #49](https://github.com/Taa965/zero3-pilot/pull/49) addresses durable Zero3 conversation discovery across app-server restart.

Pinned Codex separates the AppServer transport from the persisted session source. The `codex app-server` command defaults `--session-source` to `vscode`; Zero3 therefore must explicitly launch its child with `--session-source app-server`. The matching Zero3 list boundary requests `sourceKinds: ['appServer']`, which maps to the pinned Codex `Mcp` session source rather than mixing unrelated VS Code Codex history into the desktop sidebar.

The corrected credential-free regression smoke mirrors the real Zero3 launch arguments, creates two non-ephemeral Threads, starts a first Turn on each so Codex materializes normal durable conversation history, restarts app-server with the same `CODEX_HOME`, and requires both original IDs to remain listable and readable in the AppServer source namespace.

#49 remains a blocker until that exact real smoke and its surrounding required gates are green.

### Release blocker: Codex-native Windows artifact (#51)

[PR #51](https://github.com/Taa965/zero3-pilot/pull/51) establishes the first distributable Windows path for the Codex-native target shell.

The release package is required to:

- build the exact reviewed pinned Codex source for Windows rather than resolve an arbitrary installed CLI;
- carry that `codex.exe` under application resources;
- use the bundled binary in packaged mode instead of PATH, `@latest`, runtime download or arbitrary host override;
- carry Zero3, OpenAI Codex and Hermes license/NOTICE material required by the packaged inputs;
- produce a real NSIS artifact;
- exercise `--version` and a real app-server JSONL smoke against the binary inside the package;
- record a SHA-256 for the actual installer artifact.

A green standalone #51 run proves the packaging mechanism, but the final release candidate must be revalidated after #49 is merged so one exact candidate contains both durable AppServer source identity and bundled pinned Codex distribution.

### Public alpha productization

Before `v0.1.0-alpha` is published:

- all release-blocking CI and architecture gates must be green on the exact tag candidate;
- #49 and #51 must be merged/revalidated together rather than treated as independent release evidence;
- the Windows target desktop path must produce a documented reproducible real artifact;
- public installation/deployment docs must describe the current Electron + bundled-Codex architecture, not legacy Wry/Node/Inno paths;
- known limitations must be explicit rather than hidden behind roadmap language;
- release notes and changelog must match the exact tagged SHA;
- no known critical security-boundary regression may remain open;
- public screenshots or a short demo should be added only if captured from the real target desktop build;
- stale/superseded draft PRs and historical architecture docs should be clearly marked so the repository presents one current implementation path.

Draft release notes live at [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md).

## Explicitly deferred from `v0.1.0-alpha`

### R4B ACP external executor

[PR #48](https://github.com/Taa965/zero3-pilot/pull/48) is the formal ACP external-executor runtime, but it is **not part of the first public alpha**.

The decision is evidence-driven:

- the branch predates the merged Native Codex R4C path and currently requires replay/rebase onto the authoritative `main` stack;
- its dedicated R4B workflow passes architecture guards and strict TypeScript checks but fails ACP behavior tests on both Ubuntu and Windows;
- the observed failures include a deny path ending as `succeeded` instead of `cancelled`, and an ACP protocol-version mismatch being classified as `unavailable` instead of `unsupported`.

Those are contract/semantics issues, not cosmetic CI noise. R4B will be repaired, replayed onto current `main`, and revalidated in a later pre-release rather than weakening the first-alpha gate.

Older audit/POC PRs should be closed or clearly marked superseded once their formal implementation path exists. Open history should not make contributors guess which branch is authoritative.

## After `v0.1.0-alpha`

### R4 / collaboration completion

- repair/rebase/revalidate the formal ACP external-agent executor (#48), including deny/cancellation and protocol-version classification semantics;
- connect Remote Host task execution to the frozen Executor Manager / Handoff / Failover contracts without weakening H5 lease/fencing/outbox invariants;
- expose executor selection, failover and handoff evidence in the desktop UI;
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
- claiming broad adoption, production readiness or release status before public evidence exists;
- merging a provider integration whose own cross-platform behavior contract is red merely to increase first-release scope.

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`SECURITY.md`](SECURITY.md) for the detailed authority and security boundaries.

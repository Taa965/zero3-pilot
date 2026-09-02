# Changelog

All notable public-facing changes to Zero3 Pilot will be recorded here.

Zero3 Pilot has not published a GitHub Release yet. The first planned public tag is `v0.1.0-alpha`; until that tag exists, everything below remains **pre-release** and the exact release contents may change.

## [0.1.0-alpha] - Unreleased

### Added

- Codex-core architecture constitution: open-source Codex is the authoritative native Agent Kernel/runtime; Hermes is the desktop UI shell source; DeepSeek-Harness is a capability donor.
- Typed Electron boundary for a pinned `codex app-server --stdio` child without a generic Renderer-controlled JSON-RPC proxy.
- Codex Thread / Turn / Item-backed primary desktop conversation flow, streaming, interruption and restore.
- Native Codex command/file approval and user-input prompts with unsupported request classes kept fail-closed.
- Desktop presentation for reasoning, command execution, file changes, MCP tool calls, dynamic tools, plans and web-search Items.
- Structured Codex user-input bridge and supported local-image input path.
- Native Codex thread archive/unarchive/delete/rename/fork, active-turn steering, authoritative Item-to-Turn mapping and paginated history operations.
- Deterministic Codex overlay/replay infrastructure against an exact reviewed upstream Codex pin.
- Lossless oversized tool-output spill/recovery and bounded model projection (D1).
- Recoverable historical tool-result pruning for compaction input without mutating authoritative history (D2).
- Remote Host local runtime, durable outbox, strict publication ordering and durable authenticated control plane with lease/fencing/replay protections (H0-H5).
- Provider-neutral `zero3.pilot.executor.v1` contract and Executor Manager foundation (R4A).
- Crash-safe, fail-closed Git/workspace handoff protocol (R4E).
- Automatic executor failover controller with retry, cooldown, circuit-breaker and recovery-first behavior (R4F).
- Native Codex `Zero3Executor` using the pinned app-server path, explicit permission forwarding and supported account/rate-limit APIs rather than credential-file parsing (R4C).
- Public `SECURITY.md`, private vulnerability-reporting path, `CONTRIBUTING.md`, governance/release documentation, PR/issue templates and extensive architecture/CI gates.

### Release blockers — not counted as shipped until merged

- Durable Zero3 AppServer-source conversation discovery and restart persistence: [PR #49](https://github.com/Taa965/zero3-pilot/pull/49). Pinned Codex defaults `codex app-server` session identity to `vscode`; the candidate fix explicitly launches `--session-source app-server`, filters the matching `sourceKinds: ['appServer']` namespace, and verifies two first-Turn durable Threads across an app-server cold restart with the same `CODEX_HOME`. It is not included until that exact real smoke and required surrounding gates pass.
- Codex-native Windows distribution: [PR #51](https://github.com/Taa965/zero3-pilot/pull/51). The candidate builds the exact reviewed Codex pin for Windows, bundles `codex.exe` into application resources, carries required Zero3/Codex/Hermes legal notices, disallows arbitrary external Codex substitution in packaged mode, builds an NSIS artifact and verifies the bundled binary with a real app-server smoke. It is not included until the Windows Alpha Artifact gate passes and the packaging path is revalidated on a combined candidate that also contains #49.

### Deferred from this alpha

- Formal ACP external-executor runtime: [PR #48](https://github.com/Taa965/zero3-pilot/pull/48). Its current dedicated workflow fails behavior tests on Ubuntu and Windows, including deny -> `succeeded` instead of `cancelled` and protocol-version mismatch -> `unavailable` instead of `unsupported`. It also requires replay/rebase onto the post-R4C stack. It will be repaired and revalidated in a later pre-release rather than waived into `v0.1.0-alpha`.
- Remote Host -> Executor Manager/Handoff/Failover integration remains follow-up work; audit history is tracked separately from merged runtime features.

### Known pre-release limitations

- No GitHub Release/tag has been published yet.
- The project is not production-ready and does not claim broad external adoption.
- Parts of the Hermes-derived backend may still exist as compatibility scaffolding for unported UI surfaces; new/migrated core runtime behavior must use Codex-owned boundaries.
- Conversations created by development builds before explicit Zero3 AppServer source tagging may have been stored under Codex's `vscode` source. The first public alpha does not promise automatic migration of those pre-release sessions because importing all `vscode` rows could mix unrelated VS Code Codex history into Zero3.
- ACP external-agent execution is intentionally not part of the `v0.1.0-alpha` scope.
- The Windows alpha candidate is expected to be unsigned unless the final release evidence explicitly records a signing step; Windows SmartScreen or an unknown-publisher warning may therefore appear.
- Release-quality screenshots/demo and the final Windows installer checksum must come from the exact combined release candidate, not from a standalone blocker branch.

### Security / architecture invariants

- Codex remains the sole native Agent Kernel/runtime authority.
- Unsupported permission/request classes fail closed.
- Migrated core operations do not silently fall back to Hermes Runtime or legacy Zero3 Node.
- Codex authentication material is not copied or parsed from credential files by the Native executor.
- External executors do not gain Handoff/Router/task authority merely by being providers.
- Provider integrations with incorrect deny/failure semantics are deferred rather than treated as release-ready.
- A packaged Windows build must use the reviewed bundled Codex pin rather than PATH, `@latest`, runtime download or an arbitrary host override.

See [`ROADMAP.md`](ROADMAP.md) and [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md) for the release-readiness plan and draft release narrative.

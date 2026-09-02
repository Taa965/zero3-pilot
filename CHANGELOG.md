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
- Durable Zero3 AppServer-source conversation identity and cold-restart discovery/read verification: Zero3 explicitly launches pinned Codex with `--session-source app-server`, lists `sourceKinds: ['appServer']`, and verifies two first-Turn durable Threads across an app-server restart ([PR #49](https://github.com/Taa965/zero3-pilot/pull/49)).
- Deterministic Codex overlay/replay infrastructure against an exact reviewed upstream Codex pin.
- Lossless oversized tool-output spill/recovery and bounded model projection (D1).
- Recoverable historical tool-result pruning for compaction input without mutating authoritative history (D2).
- Remote Host local runtime, durable outbox, strict publication ordering and durable authenticated control plane with lease/fencing/replay protections (H0-H5).
- Provider-neutral `zero3.pilot.executor.v1` contract and Executor Manager foundation (R4A).
- Crash-safe, fail-closed Git/workspace handoff protocol (R4E).
- Automatic executor failover controller with retry, cooldown, circuit-breaker and recovery-first behavior (R4F).
- Native Codex `Zero3Executor` using the pinned app-server path, explicit permission forwarding and supported account/rate-limit APIs rather than credential-file parsing (R4C).
- Codex-native Windows packaging that builds the exact reviewed pin, bundles `resources/zero3-codex/codex.exe`, carries required legal notices, rejects arbitrary packaged-runtime substitution, produces an NSIS candidate and verifies the packaged binary with a real app-server smoke ([PR #51](https://github.com/Taa965/zero3-pilot/pull/51)).
- Public `SECURITY.md`, private vulnerability-reporting path, `CONTRIBUTING.md`, governance/release documentation, PR/issue templates and extensive architecture/CI gates.

### Pre-release validation evidence

- The #51 pull-request merge candidate included the already-merged #49 tree and passed the Windows Alpha Artifact gate, including package build, packaged `codex.exe --version`, real bundled app-server smoke, legal-resource checks, NSIS output and SHA-256 generation.
- That integrated PR evidence is not the final public-release checksum. The exact documentation-closeout/release SHA still requires its own final release evidence before the tag is published.

### Remaining release closeout

- Merge the final documentation closeout so user-facing instructions describe the merged Electron/NSIS/bundled-Codex architecture rather than legacy release paths.
- Bind the required architecture, Codex, Windows target-shell and feature gates to the exact final candidate.
- Produce the exact-candidate Windows installer/checksum evidence, confirm pins/provenance/NOTICE obligations, and publish the matching `v0.1.0-alpha` tag/GitHub pre-release.

### Deferred from this alpha

- Formal ACP external-executor runtime: [PR #48](https://github.com/Taa965/zero3-pilot/pull/48). Its current dedicated workflow fails behavior tests on Ubuntu and Windows, including deny -> `succeeded` instead of `cancelled` and protocol-version mismatch -> `unavailable` instead of `unsupported`. It also requires replay/rebase onto the post-R4C stack. It will be repaired and revalidated in a later pre-release rather than waived into `v0.1.0-alpha`.
- Remote Host -> Executor Manager/Handoff/Failover integration remains follow-up work; audit history is tracked separately from merged runtime features.

### Known pre-release limitations

- No GitHub Release/tag has been published yet.
- The project is not production-ready and does not claim broad external adoption.
- Parts of the Hermes-derived backend may still exist as compatibility scaffolding for unported UI surfaces; new/migrated core runtime behavior must use Codex-owned boundaries.
- Conversations created by development builds before explicit Zero3 AppServer source tagging may have been stored under Codex's `vscode` source. The first public alpha does not promise automatic migration of those pre-release sessions because importing all `vscode` rows could mix unrelated VS Code Codex history into Zero3.
- ACP external-agent execution is intentionally not part of the `v0.1.0-alpha` scope.
- The Windows alpha is expected to be unsigned unless the final release evidence explicitly records a signing step; Windows SmartScreen or an unknown-publisher warning may therefore appear.
- Release-quality screenshots/demo and the final Windows installer checksum must come from the exact release candidate, not from an older PR artifact.

### Security / architecture invariants

- Codex remains the sole native Agent Kernel/runtime authority.
- Unsupported permission/request classes fail closed.
- Migrated core operations do not silently fall back to Hermes Runtime or legacy Zero3 Node.
- Codex authentication material is not copied or parsed from credential files by the Native executor.
- External executors do not gain Handoff/Router/task authority merely by being providers.
- Provider integrations with incorrect deny/failure semantics are deferred rather than treated as release-ready.
- A packaged Windows build must use the reviewed bundled Codex pin rather than PATH, `@latest`, runtime download or an arbitrary host override.

See [`ROADMAP.md`](ROADMAP.md) and [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md) for the release-readiness plan and draft release narrative.

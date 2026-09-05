# Changelog

All notable public-facing changes to Zero3 Pilot are recorded here.

## [0.1.0-alpha] - 2026-09-03

First public Codex-native development baseline for the Zero3 Pilot desktop application.

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
- Codex-native Windows packaging that builds the exact reviewed pin, bundles `resources/zero3-codex/codex.exe`, carries required legal notices, rejects arbitrary packaged-runtime substitution, produces an NSIS package and verifies the packaged binary with a real app-server smoke ([PR #51](https://github.com/Taa965/zero3-pilot/pull/51)).
- Release-hygiene closeout that repairs the public `codex:verify` / `codex:replay` npm entrypoints and makes the historical `zero3-web` deployment workflow manual-only instead of deploying on every `main` push ([PR #54](https://github.com/Taa965/zero3-pilot/pull/54)).
- Public `SECURITY.md`, private vulnerability-reporting path, `CONTRIBUTING.md`, governance/release documentation, PR/issue templates and extensive architecture/CI gates.

### Validation / release evidence

- A full independent Windows acceptance run on candidate `961c04c66431a5e92e56e6887722ba9ed859f566` passed the Codex-native runtime/package gates, including the packaged Codex app-server smoke and #49 cold-restart persistence proof.
- PR #54 then passed every triggered repository gate: CI (including Ubuntu Clippy), Codex Core Smoke, Codex Overlay Foundation, D1, D2, R3C-R3F, H0-H5 and Windows Alpha Artifact.
- The #54 Windows Alpha Artifact produced `Zero3Pilot-0.1.0-alpha-win-x64.exe` (185,183,120 bytes) with pre-tag validation SHA-256 `3EAD2DED013EFCFC2F3BC80945352AB7061B75B907818434FE5ED22BA3C5EDB6`.
- The additional post-#54 local Windows exact-main rerun was explicitly `WAIVED_BY_RELEASE_OWNER`; it is not represented as PASS. Publication still uses the tag-triggered Windows Alpha Artifact workflow so the distributed binary can be traced to the exact tag candidate.
- The public installer checksum belongs in the GitHub Release record produced from the exact tag workflow. This changelog does not predeclare a checksum for an artifact that has not yet been produced from the tag.

### Deferred from this alpha

- Formal ACP external-executor runtime: [PR #48](https://github.com/Taa965/zero3-pilot/pull/48). Its dedicated behavior tests expose deny/cancellation and protocol-version-classification problems and it requires replay/rebase onto the post-R4C stack. It is deferred to a later pre-release rather than waived into `v0.1.0-alpha`.
- Remote Host -> Executor Manager/Handoff/Failover integration remains follow-up work; audit history is tracked separately from merged runtime features.

### Known limitations

- This is an alpha, not a production-ready release, and no broad external adoption is claimed.
- Parts of the Hermes-derived backend may still exist as compatibility scaffolding for unported UI surfaces; new/migrated core runtime behavior must use Codex-owned boundaries.
- Conversations created by development builds before explicit Zero3 AppServer source tagging may have been stored under Codex's `vscode` source. This alpha does not promise automatic migration of those sessions because importing all `vscode` rows could mix unrelated VS Code Codex history into Zero3.
- ACP external-agent execution is intentionally not part of `v0.1.0-alpha`.
- The Windows alpha is unsigned; Windows SmartScreen or an unknown-publisher warning may therefore appear. Verify the installer checksum from the GitHub Release record before running it.

### Security / architecture invariants

- Codex remains the sole native Agent Kernel/runtime authority.
- Unsupported permission/request classes fail closed.
- Migrated core operations do not silently fall back to Hermes Runtime or legacy Zero3 Node.
- Codex authentication material is not copied or parsed from credential files by the Native executor.
- External executors do not gain Handoff/Router/task authority merely by being providers.
- Provider integrations with incorrect deny/failure semantics are deferred rather than treated as release-ready.
- A packaged Windows build must use the reviewed bundled Codex pin rather than PATH, `@latest`, runtime download or an arbitrary host override.
- The historical `zero3-web` deployment path is manual-only and is not the desktop release model.

See [`ROADMAP.md`](ROADMAP.md) and [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md) for the release baseline and detailed release narrative.

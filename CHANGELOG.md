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
- Public `SECURITY.md`, private vulnerability-reporting path, `CONTRIBUTING.md`, PR/issue templates and extensive architecture/CI gates.

### In progress / not included until merged

- Durable AppServer conversation discovery and restart persistence fix: [PR #49](https://github.com/Taa965/zero3-pilot/pull/49).
- Formal ACP external-executor runtime: [PR #48](https://github.com/Taa965/zero3-pilot/pull/48).
- Remote Host -> Executor Manager/Handoff/Failover integration remains follow-up work; audit history is tracked separately from merged runtime features.

### Known pre-release limitations

- No GitHub Release/tag has been published yet.
- The project is not production-ready and does not claim broad external adoption.
- Parts of the Hermes-derived backend may still exist as compatibility scaffolding for unported UI surfaces; new/migrated core runtime behavior must use Codex-owned boundaries.
- External-agent collaboration is not part of the release baseline until its formal implementation is merged and revalidated.
- Release-quality screenshots/demo and a final Codex-native Windows distribution still need to be produced from the real release candidate.

### Security / architecture invariants

- Codex remains the sole native Agent Kernel/runtime authority.
- Unsupported permission/request classes fail closed.
- Migrated core operations do not silently fall back to Hermes Runtime or legacy Zero3 Node.
- Codex authentication material is not copied or parsed from credential files by the Native executor.
- External executors do not gain Handoff/Router/task authority merely by being providers.

See [`ROADMAP.md`](ROADMAP.md) and [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md) for the release-readiness plan and draft release narrative.

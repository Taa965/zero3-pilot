# INTEGRATION_REQUEST — zero3-context-retention

Feature: `zero3-context-retention`
Workstream: D2 Context Retention / Tool Result Pruner
Owner: S3

## Dependency gate now satisfied

D1 PR #33 freezes its recovery contract at:

`e53c8b4d00c69faf70956907e7e55563b963bb23`

D2B now consumes that contract through `codex-zero3-output-retention::SpillStore`; S3 does not define a second `SpillRef`, physical spill root, or recovery implementation.

## Shared integration requested from S0/S1

1. Register `zero3-context-retention` in `codex-overlays/manifest.json` with the reviewed extension destination under `codex-rs/ext/zero3/`.
2. Register `010-context-retention-compaction-projection.patch` as the D2 core patch. D0's frozen patch order already places `output-retention` before `context-pruning`; preserve that order because the D2 patch extends the D1-added `ToolLifecycleContributor` seam.
3. Add the installed package `codex-zero3-context-retention` to the generated/pinned Codex workspace and workspace dependency table.
4. Ensure `codex-zero3-output-retention` is available as a workspace dependency of D2.
5. Install D2 in app-server only after D1 and pass `output_retention.store()` into D2 so both extensions use the same host-owned SpillStore.
6. Apply the compaction projection helper to every pinned Codex compaction input path: local Responses summarization, remote `/responses/compact`, and remote compaction V2.
7. Preserve Codex's existing remote fit-to-window fallback as authority. D2 may retain an already-visible D1 locator when fallback replaces an output, but may not cause fallback truncation.

## Authority boundary

- OpenAI Codex remains the sole Agent Kernel and compaction authority.
- D1 remains spill/persistence/recovery authority.
- D2 only transforms private cloned model input for compaction after verifying a D1 recovery locator.
- Authoritative Thread/Turn/Item history is never rewritten by D2.
- Approval, Sandbox, provider selection, tool execution success/failure, and telemetry remain owned by Codex.
- Storage/projection errors fail open by leaving the current model projection unchanged.

## Validation required before merge

- D1 → D2 patch-chain preflight.
- Managed overlay prepare + verify + detached replay.
- `cargo fmt --check` for the generated Codex worktree.
- D1 and D2 extension tests.
- Remote recovery-locator fallback tests.
- Combined `codex-app-server` compile check.
- Pinned Codex CLI build and real app-server JSONL smoke.
- Synthetic 100/20 benchmark and real Codex/model-token 100/20 benchmark.
- Existing architecture and Remote Host regression gates.

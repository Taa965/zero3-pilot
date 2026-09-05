# D2B Compaction Integration Design

Status: **implemented in Draft form against D1 contract-freeze head `e53c8b4d00c69faf70956907e7e55563b963bb23`; combined overlay compile/runtime verification still required**.

## Authority boundary

OpenAI Codex remains the only compaction engine. D2 does not replace manual compaction, TokenBudget compaction, remote compaction, remote compaction V2, local summarization, provider selection, approval, sandboxing, tool execution, or spill persistence/recovery authority.

## Pinned targets

Codex SHA: `94311d447587411789533c47601fd8bc9d81eb48`.

D1 contract freeze: `e53c8b4d00c69faf70956907e7e55563b963bb23` / PR #33.

The pinned Codex tree has three distinct compaction request paths that clone authoritative history before constructing model-visible input. D2B covers all three with one helper:

| Official compaction path | D2 call site |
| --- | --- |
| local Responses summarization | `codex-rs/core/src/compact.rs::run_compact_task_inner_impl`, immediately after `sess.clone_history()` and before synthesized compaction input |
| remote `/responses/compact` | `codex-rs/core/src/compact_remote_request.rs::run_remote_compact_attempt`, immediately after `sess.clone_history()` and before Codex fit-to-window fallback / trace capture |
| remote compaction V2 | `codex-rs/core/src/compact_remote_v2_attempt.rs::run_remote_compact_v2_attempt`, immediately after `sess.clone_history()` and before Codex fit-to-window fallback / trace capture |

The patch introduces only one Core helper, `project_compaction_history`, and one typed extension seam, `ToolLifecycleContributor::on_compaction_history_item`.

## Why a minimal Core seam is required

At the pinned SHA, `ConversationHistorySnapshot` is read-only and `ResponseItemInjector` is additive same-turn steering. Neither can transform the private cloned `ContextManager` used to build a compaction request.

D2B therefore adds a narrowly scoped model-projection hook rather than linking `codex-core` directly to the D2 crate. The hook receives one `ResponseItem` plus read-only thread/turn identity and may return a replacement **only for the clone**. Core preserves `ResponseItemEnvelope` metadata and never writes the replacement to authoritative history.

Contributor errors fail open to the current cloned item.

## D1-backed recoverability gate

D2B consumes D1 rather than inventing a competing recovery type/store:

1. D2 extension receives the same `Arc<dyn SpillStore>` held by the installed D1 extension.
2. Oversized plain-text `FunctionCallOutput` / `CustomToolCallOutput` items are candidates.
3. D2 finds `zero3-spill://v1/...` locator tokens without depending on the rest of D1's notice wording.
4. A locator-looking string is **not sufficient**. D2 calls D1 `SpillStore::read_source` and requires the stored thread/call identity to match the history item, plus turn identity when available.
5. Only after this sidecar verification succeeds does D2 invoke the deterministic pruning engine.
6. D2 verifies the recovery locator is still model-visible in the pruned projection; otherwise it no-ops.
7. Missing sidecar, storage error, fake locator, cross-thread/cross-call mismatch, structured output, missing call id, or below-threshold content all fail closed.

D2 does not read the full spill merely to prove recoverability; the small D1 metadata sidecar is sufficient.

## Model projection behavior

```text
Codex compaction request
        ↓
Codex clones authoritative history
        ↓
Core typed model-projection seam (same helper in local/remote/v2)
        ↓
D2 contributor
  ├─ measure plain-text Tool Result
  ├─ find D1 locator candidate
  ├─ verify D1 sidecar identity via shared SpillStore
  ├─ deterministic Unicode-scalar head/middle/tail prune
  └─ verify locator survived projection
        ↓
local: existing prompt construction
remote/v2: existing Codex fit-to-window fallback, then trace/prompt construction
        ↓
existing Codex compaction implementation unchanged
```

The transform applies only to the model-visible cloned history. It does not mutate authoritative Thread/Turn/Item history, persisted rollout history, tool execution results, Approval state, Sandbox state, provider selection, or D1 storage.

## Remote fit-to-window fallback

Pinned Codex's remote fallback can replace an entire Tool Result with a fixed truncation sentence. That would erase an otherwise valid D1 recovery locator after D2 projection.

The D2 patch therefore makes one bounded compatibility adjustment to the existing fallback payload renderer:

- the fallback still decides **when**, **which**, and **how many** outputs to rewrite;
- the existing token fit loop and order are unchanged;
- if the pre-fallback text contains a D1 locator token, only that bounded locator token is appended to Codex's existing truncation sentence;
- presence of the locator never causes an additional truncation and is not treated as proof of recoverability by the D2 pruner;
- without a locator, the fallback payload is byte-for-byte the existing fixed message.

This keeps Codex as the fallback authority while preventing the fallback itself from deleting D1's recovery entrance.

## Provenance and accounting

D2 engine records:

- original Unicode scalar count;
- emitted scalar count including the prune marker;
- original middle-span scalars removed;
- net scalars saved;
- marker count;
- policy version.

The D2 extension emits structured debug provenance for a successful projection. It does not rewrite authoritative session token accounting.

Remote `trace_input_history` remains captured after D2 projection and after any Codex-owned fallback rewrite, so traces represent the history actually sent to compaction.

The 100/20 acceptance benchmark must still use real Codex/model token accounting after combined integration; D2A's `chars/4` value remains planning-only.

## Patch inventory

`010-context-retention-compaction-projection.patch` touches only:

- `codex-rs/ext/extension-api/src/contributors.rs`
- `codex-rs/ext/extension-api/src/lib.rs`
- `codex-rs/core/src/compact.rs`
- `codex-rs/core/src/compact_remote.rs`
- `codex-rs/core/src/compact_remote_request.rs`
- `codex-rs/core/src/compact_remote_v2_attempt.rs`

It assumes D1's output-retention patch has already extended `ToolLifecycleContributor`, matching D0's frozen feature order `output-retention` → `context-pruning`.

## Required verification before activation

- combined D1+D2 patch replay / `git apply --check` succeeds;
- `cargo test -p codex-zero3-context-retention` succeeds after overlay installation;
- D1 tests remain green;
- local, remote and remote-V2 compaction compile and exercise the same projection helper;
- fake locator / absent sidecar / identity mismatch no-op tests pass;
- tool call/result pairing and history-envelope metadata remain unchanged;
- authoritative Codex history remains unchanged;
- D1 locator survives D2 pruning and remote fallback rewriting;
- Unicode scalar-safe boundaries and deterministic provenance tests pass;
- trace input matches the actual compaction input;
- summary/compaction call count does not increase in the 100/20 benchmark;
- answer accuracy does not regress when `read_spill` / `grep_spill` are available;
- resume/fork resolves the same D1 locator through the persistent host-owned store.

## Integration request

Final manifest registration, workspace membership/dependencies, shared extension-install order, common architecture guard and common CI remain S0/S1-owned. See `codex-overlays/ext/zero3-context-retention/INTEGRATION_REQUEST.md`.

# D2B Compaction Integration Proposal

Status: **proposal only — blocked on D1 Output Retention contract freeze**.

## Authority boundary

OpenAI Codex remains the only compaction engine. D2 does not replace manual compaction, TokenBudget compaction, remote compaction, remote compaction V2, local summarization, provider selection, approval, sandboxing, or tool-result authority.

## Pinned target

- Codex SHA: `94311d447587411789533c47601fd8bc9d81eb48`
- Target file: `codex-rs/core/src/compact.rs`
- Target path: `run_compact_task_inner_impl`
- Existing seam: immediately after `let mut history = sess.clone_history().await;` and before the synthesized compaction input is appended and `history.for_prompt(...)` is built.

## Proposed behavior

```text
Context pressure / compaction request
        ↓
clone authoritative Codex history
        ↓
Zero3 deterministic historical Tool Result projection pruning
        ↓
re-measure projected history
        ↓
if compaction is still required
        ↓
existing Codex compaction path unchanged
```

The transform applies only to the **model-visible cloned history** used for compaction. It must not mutate the authoritative Thread/Turn/Item history and must not change tool execution results.

## D1 dependency

D2 must consume the D1-frozen output-retention projection contract. In particular:

- D2 will not define a `SpillRef`.
- D2's generic `RecoveryRef` parameter must be adapted to D1's authoritative recovery-reference type.
- If a historical tool result has a complete D1 spill/recovery reference, pruning must preserve it exactly.
- If no complete recovery artifact exists, S0 must decide whether the projection is eligible for destructive middle removal. D2 will not silently invent recovery semantics.

## Minimal patch shape after contract freeze

The expected Core patch should only:

1. call a typed Zero3 context-retention adapter on cloned history;
2. receive a transformed model projection plus diagnostics/provenance;
3. use the transformed clone for compaction prompt construction;
4. leave the original session history untouched;
5. fail open to the unmodified cloned history if the optional projection optimizer cannot safely transform an item.

No generic RPC, Node runtime, DeepSeek runtime, or alternate Agent Loop is allowed.

## Required verification before activation

- tool call/result pairing unchanged;
- original Codex history remains byte-for-byte authoritative;
- D1 recovery reference survives prune/resume/fork;
- Unicode scalar-safe boundaries;
- rich block ordering preserved;
- repeated projection is deterministic and convergent;
- summary call count does not increase in the 100/20 benchmark;
- answer accuracy does not regress when D1 recovery tools are available;
- Codex manual/TokenBudget/remote/local compaction tests remain green.

## Integration request

The final patch registration, workspace member registration, extension registration, manifest ordering, common architecture guard, and common CI wiring are shared S0/S1-owned files and must be handled through an `INTEGRATION_REQUEST` after D1 contract freeze.

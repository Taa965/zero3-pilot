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
5. In the shared extension-registry wiring, install D1 first and retain its returned extension handle, then install D2 with the **same** store:

```text
output_retention = codex_zero3_output_retention::install(...)
codex_zero3_context_retention::install(
    ...,
    output_retention.store(),
    PruneConfig::default(),
)
```

6. Do not create a second D2 spill root/store and do not pass a filesystem path into model context.
7. Add D2 crate tests and combined D1+D2 overlay replay to common CI.
8. Add/adjust the common architecture guard only as needed to enforce that D2's hook is model-projection-only and that OpenAI Codex remains authoritative.

## Core patch rationale

At Codex pin `94311d447587411789533c47601fd8bc9d81eb48`, the public extension API can read history but cannot transform the private cloned `ContextManager` used for compaction input. The S3 patch therefore adds one typed `on_compaction_history_item` model-projection hook to the D1-extended `ToolLifecycleContributor` and calls one shared helper from all three official compaction paths:

- local Responses summarization;
- remote `/responses/compact`;
- remote compaction V2.

The hook operates only on a cloned history item. History-envelope metadata is preserved by Core, contributor errors fail open, and no replacement compaction/runtime/RPC authority is introduced.

## D1 recovery verification used by D2

D2 does **not** trust a locator-looking substring by itself. For an oversized plain-text historical Tool Result it:

1. finds `zero3-spill://v1/...` candidates without binding to the rest of D1's notice wording;
2. calls the shared D1 `SpillStore::read_source`;
3. requires the stored `thread_id` and `call_id` to match the current history item, plus `turn_id` when the history envelope has one;
4. prunes only after that verification succeeds;
5. verifies the recovery locator remains model-visible after pruning;
6. otherwise leaves the item unchanged.

## Expected shared files

Exact shared paths remain S0/S1-owned, but integration will likely touch:

- `codex-overlays/manifest.json`;
- generated Codex root workspace membership/dependencies;
- shared Zero3 extension-registry installation;
- shared overlay/architecture guard;
- common CI workflow.

S3 does **not** authorize itself to edit those shared files directly.

## Required verification after combined overlay installation

- `cargo test -p codex-zero3-context-retention`;
- D1 crate tests remain green;
- `git apply --check` / overlay replay succeeds with D1 patch before D2 patch;
- pinned Codex compile/build remains green;
- local, remote and remote-V2 compaction paths all exercise the same projection helper;
- authoritative history and history-envelope metadata remain unchanged;
- tool call/result pairing remains unchanged;
- a fake locator, missing sidecar, cross-thread/cross-call sidecar or D1 storage read failure causes D2 to no-op;
- a valid D1 recovery locator survives D2 pruning;
- existing remote fit-to-window fallback remains Codex-owned and unchanged;
- real Codex token accounting plus compaction/summary call counts are collected on the 100/20 benchmark;
- answer accuracy does not regress when D1 recovery tools are available;
- resume/fork can still resolve the same D1 locator through the host-owned persistent store.

## Authority boundary

No new Agent Loop, Runtime, generic RPC, Approval path, Sandbox authority, persistence authority, or replacement compaction engine is permitted. OpenAI Codex remains the sole Agent Kernel and compaction authority; D1 remains the sole owner of spill persistence/recovery.

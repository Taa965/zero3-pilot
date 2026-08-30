# Output Retention / Spill — S2 integration request

Status: D1 implementation branch `feat/d1-output-retention-spill`.

Pinned inputs:

- Bootstrap: `956788f3810eaa0e4eda5c8de73ecd086699ee49`
- OpenAI Codex: `94311d447587411789533c47601fd8bc9d81eb48`
- DeepSeek-Harness donor: `cd5ef8148158c3a752a658978873241fdf8e2bbc`

## What S2 owns

The implementation lives only in:

- `codex-overlays/ext/zero3-output-retention/**`
- `codex-overlays/patches/output-retention/**`
- `codex-overlays/tests/output-retention/**`
- `docs/development/OUTPUT_RETENTION*.md`

S2 intentionally does **not** edit `codex-overlays/manifest.json`, root Cargo workspace membership, the public overlay apply engine, shared extension installation wiring, Approval, or Sandbox.

## INTEGRATION_REQUEST to S0/S1

1. Add `codex-overlays/ext/zero3-output-retention/` to the generated Codex extension copy/install plan and workspace membership as `codex-rs/ext/zero3/output-retention/`.
2. Add `codex-overlays/patches/output-retention/010-output-retention-tool-result-projection.patch` to the shared manifest after foundation patches.
3. Install `codex_zero3_output_retention::install(...)` in the shared Codex extension-registry construction with a host-owned `LocalSpillStore` root and `OutputRetentionConfig`.
4. The spill root must be persistent across thread resume/fork, per-user private under the desktop/runtime data root, and must not be exposed directly to the model. The model receives only `zero3-spill://v1/<opaque-id>` locators.
5. Add the D1 Windows/Linux CI invocation once shared overlay CI is integrated, including both `verify-output-retention.mjs` and `verify-desktop-projection.mjs`.

## Seam contract

The Core patch is deliberately narrow:

- extends existing `ToolLifecycleContributor` with `on_tool_result`;
- runs only after successful execution and PostToolUse handling;
- receives immutable thread/turn/call/tool identity plus the current model projection;
- can return a replacement `ResponseInputItem` only;
- the original `ToolOutput` remains execution/hook/telemetry authority;
- contributor errors fail open to the current Codex projection;
- Code Mode result authority is unchanged;
- Approval and Sandbox code paths are untouched.

`ToolOutput::complete_text_output()` defaults to `None`. Output types opt in only when they can prove they hold a complete plain-text value before model-context truncation. Multimodal/encrypted results, generic outputs with unknown provenance, ApplyPatch's already formatted emitter result, and unified-exec snapshots that report collector-side omitted bytes do not opt in. This prevents a partial log or an already truncated preview from being mislabeled as a complete spill.

## Retention behavior

For eligible oversized text:

1. persist the exact UTF-8 text first;
2. retain bounded UTF-8-safe head/tail text;
3. include the recovery notice inside the same byte cap;
4. emit an opaque locator and `read_spill` / `grep_spill` guidance;
5. on storage/projection failure keep Codex's existing model-visible result and tool success unchanged.

The Zero3 projection never exceeds the smaller of its configured cap and Codex's already-generated text projection, so D1 cannot increase model-context consumption. Recovery tool responses also respect Codex's host response budget after JSON serialization; a requested byte count never forces a partial UTF-8 scalar past that hard cap.

## D1C desktop projection decision

No new desktop execution authority or generic `functionCallOutput` renderer is required.

The existing Zero3 R3A/R3B desktop projection already keeps UI/replay evidence separate from model context:

- `commandExecution` cards read the app-server Item's `aggregatedOutput`;
- `dynamicToolCall` cards preserve structured `contentItems` and their text projection;
- ordinary opaque/encrypted `functionCallOutput` remains fail-closed instead of being dumped into chat.

D1 therefore keeps the desktop on this Item-derived path and adds `codex-overlays/tests/output-retention/verify-desktop-projection.mjs` as the regression contract. The model-visible spill notice is not promoted into a second renderer. Full-output UI stays sourced from authoritative Codex Items; `read_spill` / `grep_spill` provide model recovery from the durable artifact when the model projection is bounded.

## Donor provenance

DeepSeek-Harness `packages/spill/spill-policy/src/index.ts` was used as an **algorithm/design donor**, not as runtime code. Retained behaviors are full-text save before projection, exact UTF-8 byte budgeting, head/tail retention, notice reservation, opaque retrieval reference, read-loop avoidance, and fail-open storage errors. The implementation is native Rust against the pinned Codex extension contracts; DeepSeek-Harness runtime is not started or embedded.

## Known boundary

If an upstream executor has already discarded bytes before constructing its `ToolOutput`, D1 cannot reconstruct them. In particular, `ExecCommandToolOutput` exposes `complete_text_output()` only when its existing `output_omitted_bytes` is `None`. ApplyPatch currently receives the formatted return of `ToolEmitter.finish()`, so it deliberately keeps the trait default `None` rather than claiming that already bounded string is authoritative. The D1 acceptance test for 1 MiB uses a complete plain-text ToolOutput and verifies exact byte-for-byte recovery through SpillStore.

# Donor Provenance — zero3-context-retention

- Feature: `zero3-context-retention`
- Zero3 workstream: D2 Tool Result Pruner / Context Retention
- Donor repository: `deepseek-ai/deepseek-harness`
- Donor SHA: `cd5ef8148158c3a752a658978873241fdf8e2bbc`
- Derivation mode: **algorithm-derived**
- Zero3 license: Apache-2.0
- Donor license at pinned source: MIT

## Reviewed donor sources

- `packages/compaction/compaction-tool-result-pruner/src/index.ts`
- `packages/compaction/compaction-tool-result-pruner/src/config.ts`
- `packages/compaction/compaction-tool-result-pruner/tests/tool-result-pruner.spec.ts`

## Ideas retained

- deterministic head/middle/tail pruning;
- Unicode scalar/code-point safe text slicing;
- rich/non-text block order preservation;
- exactly one visible prune marker for the removed logical middle span;
- provenance that records before/after size;
- deterministic replay/convergence as a required invariant.

## Deliberate Zero3 differences

- No DeepSeek-Harness Session/Event runtime is ported or started.
- No DeepSeek token-meter service is ported.
- No donor shadow-event protocol is copied into Codex history.
- Codex Thread/Turn/Item remains authoritative.
- Codex compaction remains authoritative.
- D2 uses a generic opaque `RecoveryRef` parameter instead of defining `SpillRef`; D1 owns the recovery-reference contract.
- D2A is a pure library. D2B may only transform a model-visible cloned history projection after the D1 contract is frozen.

## Copyright / code-port note

The implementation is algorithm-derived rather than a direct source copy. It was rewritten in Rust against Zero3's frozen architecture boundaries. No donor runtime code or package structure is vendored.

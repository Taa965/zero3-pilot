# Context Retention Benchmark

This harness implements the S3 D2 benchmark shape from the multi-session plan.

## Scenario

- 100 historical Tool Results
- 20 oversized results at 100,000 Unicode scalar values each
- 80 normal results at 1,024 scalar values each
- one deterministic middle fact per result
- default planning context budget: 128,000 tokens

Run:

```bash
node benchmarks/context-retention/run.mjs
```

Optional answer scoring:

```bash
node benchmarks/context-retention/run.mjs \
  --baseline-answers=baseline-answers.json \
  --zero3-answers=zero3-answers.json \
  --output=artifacts/context-retention-report.json
```

Answer files are JSON maps from `tool-N` to the recovered `ZERO3_MIDDLE_FACT_NNN` value.

## Metrics

The report always records:

- characters before/after;
- deterministic planning token estimate before/after;
- whether the estimate crosses the configured context budget;
- number of results pruned.

The following fields intentionally remain `null` until a pinned Codex runtime run supplies real observations:

- compaction calls;
- summary model calls.

Answer accuracy is marked `runtime-observation-required` unless answer files are supplied.

## Why accuracy is not faked

For oversized results the answer key is deliberately placed in the removed middle region. A preview-only pruner cannot truthfully claim that fact remains model-visible. The intended Zero3 behavior is that D1 preserves the full original output and exposes its frozen recovery reference; D2 then shrinks only the model projection while keeping that reference. Therefore final accuracy validation belongs to the D1 + D2B integrated runtime benchmark.

## Current deterministic planning result

With the default policy (`8192 / 4096 / 1024`) and 128k planning budget, the harness currently yields:

```text
baseline estimated tokens: 520480
zero3 estimated tokens:     46275
estimated delta:           -474205
oversized pruned:                20
baseline compaction required:  true
zero3 compaction required:     false
```

`estimatedTokens = ceil(UnicodeScalarCount / 4)` is only a stable comparison heuristic. Merge acceptance must use Codex/model token accounting and real compaction/summary counters.

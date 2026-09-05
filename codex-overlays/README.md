# Zero3 Codex Overlays

`codex-overlays/` is the reviewed source of truth for Zero3-maintained Codex extensions and the smallest justified Codex Core patches.

## Authority boundary

- OpenAI Codex remains the single Agent Kernel and runtime authority.
- Hermes remains a desktop UI/UX donor and shell.
- DeepSeek-Harness remains a capability donor only; its runtime is never started by this overlay system.
- Overlay application may change a prepared `upstream/codex` worktree, but the repository gitlink stays pinned to the exact reviewed Codex commit.

## Frozen layout

```text
codex-overlays/
├── manifest.json
├── manifest.schema.json
├── provenance.schema.json
├── ext/
├── patches/
│   ├── foundation/
│   ├── output-retention/
│   ├── context-pruning/
│   ├── lsp/
│   ├── external-agent/
│   ├── team/
│   ├── jobs/
│   └── workflow/
└── tests/
    └── foundation/
```

Feature extension sources use `codex-overlays/ext/zero3-<feature>/` and install only under `codex-rs/ext/zero3/<feature>/` in the prepared pinned Codex tree.

Patch files use `<NNN>-<feature>-<slug>.patch`, for example `010-foundation-extension-registry.patch`. Patch ordering is declared by `manifest.json`; directory iteration order is never authoritative.

## Ownership

- S0/S1 own `manifest.json`, both schemas, patch ordering, the public apply engine, base-SHA guard, common architecture guard, CI and `patches/foundation/**`.
- S2 owns output-retention implementation paths.
- S3 owns context-pruning implementation paths and benchmarks.
- S4 owns LSP implementation paths.
- Later waves reuse the same ownership map for external-agent, jobs, team and workflow as declared in the manifest.

Feature sessions must not edit shared integration files directly. If registration or shared integration is required, submit an `INTEGRATION_REQUEST` to S0/S1.

## Extension-first rule

A Codex Core patch is allowed only when the pinned extension API cannot express the required behavior. Each patch must record why an extension-only implementation is insufficient, target files/functions, donor provenance when applicable, replay tests and upstream-drift risk.

## Donor provenance

Every donor-derived feature records:

- donor repository and exact SHA;
- derivation mode: `design-derived`, `algorithm-derived`, or `code-port`;
- source files when known;
- license notes;
- behavior differences and verification evidence.

Direct code ports require preserved copyright/license notices in addition to the manifest metadata.

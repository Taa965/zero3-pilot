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

## Patch hunk discipline

The apply engine is deliberately fail-closed: a patch must either apply
cleanly to the current tree or reverse cleanly, which is how the engine proves
that an already-prepared tree is still the reviewed one. That contract breaks
when a later feature edits or abuts an earlier feature's added lines, because
the earlier patch can then no longer reverse:

```text
patch 010-output-retention-tool-result-projection
neither applies nor reverses cleanly
```

Every patch must therefore satisfy one rule: **an added line may never fall
inside another patch's context window.** Concretely:

- a later feature anchors on pinned Codex source, never on an earlier Zero3
  patch's added lines; keep at least four lines of distance when a later hunk
  has to sit near an earlier one;
- shared integration lists (workspace `members`, dependency tables) are
  appended by the later feature instead of being interleaved into the earlier
  feature's entry;
- when two features genuinely need adjacent code, the earlier patch owns the
  final spelling of the shared line (for example the `output_retention`
  binding that D2 consumes) rather than the later patch rewriting it.

`codex-overlays/tests/foundation/reviewed-stack-replay.test.mjs` enforces the
contract against a detached worktree of the pinned Codex commit: the reviewed
stack must apply once and report every patch as `already-applied` on the next
prepare.

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

# Upstream strategy: openai/codex

Zero3 Pilot builds **on** OpenAI Codex. Open-source Codex is the single authoritative Agent Kernel and runtime authority for Thread / Turn / Context / Agent Loop / Tool / Shell / Files / MCP / Approval / Git / Worktree and execution state.

## Remotes and immutable pins

```bash
git remote add upstream https://github.com/openai/codex.git
git fetch upstream
```

`origin` is `Taa965/zero3-pilot`. `upstream` is read-only tracking of `openai/codex` — never push to it.

Codex source enters this repository as the git submodule `upstream/codex`, pinned to one reviewed commit. Feature PRs must not change that gitlink or the matching pin in `apps/zero3-desktop/scripts/config.mjs` / `codex-overlays/manifest.json`.

A pin bump is a separate upstream-sync change:

```bash
git fetch upstream
cd upstream/codex
git fetch origin
git checkout <new-sha>
cd ../..
git add upstream/codex
git commit -m "chore(upstream): bump codex to <new-sha>"
```

There is no merge or rebase of `upstream/main` into Zero3 Pilot's `main`.

## Zero3 Codex overlay model

The repository gitlink stays pristine at the reviewed Codex SHA. Zero3-specific Codex changes are represented outside the submodule in `codex-overlays/` and are applied only to a prepared local/CI Codex worktree.

The deterministic path is:

1. initialize `upstream/codex`;
2. verify its exact base SHA against both `config.mjs` and `codex-overlays/manifest.json`;
3. reject unmanaged Codex worktree changes;
4. copy explicitly listed `zero3-*` extension sources to `codex-rs/ext/zero3/**`;
5. apply explicitly listed patches in manifest feature order and numeric patch-id order;
6. fail if an unlisted `.patch` exists, a listed patch is missing, a patch neither applies nor reverses cleanly, or a destination differs from reviewed source;
7. run architecture guards, replay tests, Codex fmt/check/build and app-server smoke in CI.

Commands:

```bash
node apps/zero3-desktop/scripts/prepare-codex-upstream.mjs
node scripts/codex-overlay.mjs verify
node scripts/codex-overlay.mjs replay
node scripts/codex-overlay.mjs replay <candidate-codex-sha>
node scripts/codex-overlay.mjs reset
```

`replay <candidate-codex-sha>` is the upstream-drift detector: it creates a detached temporary Codex worktree at the candidate SHA and replays the same reviewed overlay without changing Zero3's pinned gitlink.

## Extension-first rule

Zero3 may add Codex-native extensions under the overlay system. A Core patch is permitted only when the pinned Codex extension API cannot express the required behavior.

Every Core patch entry must document:

1. the missing extension point (`extension_gap`);
2. the exact feature and patch file;
3. donor provenance when behavior or code is derived externally;
4. replay/CI evidence;
5. upstream merge/drift risk in the feature PR.

Never hard-code Zero3 business logic into Codex Core merely to avoid an abstraction. Prefer a Codex extension/service/hook whenever one exists.

## Where Zero3-owned code lives

- Product/business capabilities: `zero3/`, `skills/`, Zero3-owned crates/apps and Codex extensions.
- Codex extension/patch source of truth: `codex-overlays/**`.
- Hermes UI-shell transformations: `apps/zero3-desktop/scripts/apply-*.mjs` and reviewed generated shell files.
- DeepSeek-Harness capability provenance: `docs/donors/DEEPSEEK_HARNESS.md` plus per-feature manifest entries.

Hermes and DeepSeek-Harness are donors/collaborators only; neither may become the authoritative Agent Kernel.

## Patch ownership and multi-session rule

S0/S1 own `codex-overlays/manifest.json`, schemas, common apply/replay engine, base-SHA guard, shared patch ordering, common architecture guard and CI. Feature sessions own only their declared feature directories. When a feature needs shared registration or manifest activation it submits an `INTEGRATION_REQUEST` to S0/S1 rather than editing shared integration files concurrently.

The Bootstrap contract commit for a coordinated multi-session wave is recorded by that wave's integration plan and is the required branch base for its feature branches. Historical S0/S1/S2 naming describes integration ownership during those waves; it does not create permanent runtime authority outside the architecture constitution.

## Current modification log

The current reviewed Codex pin remains:

`94311d447587411789533c47601fd8bc9d81eb48`

The managed overlay is no longer infrastructure-only. The merged modification history currently includes:

- **D0 — overlay foundation:** deterministic manifest, exact pin verification, managed extension copy/patch ordering, unmanaged-worktree guards and detached replay/drift detection;
- **D1 — output retention:** Codex-native lossless spill/recovery for oversized plain-text tool results with bounded model projection and typed recovery tools;
- **D2 — context retention:** deterministic pruning of recoverable oversized historical tool results only in Codex's private compaction input, without mutating authoritative Thread/Turn/Item history.

The exact active extensions/patches are defined by `codex-overlays/manifest.json`; this prose log is explanatory only and must not override the manifest.

Any future Codex pin bump or Core patch must remain separately reviewable and must pass overlay replay plus the relevant Codex/app-server gates before merge.

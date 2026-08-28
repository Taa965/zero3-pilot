# Contributing

## Before touching `upstream/codex`

Read [`docs/UPSTREAM.md`](docs/UPSTREAM.md) first. It is a submodule pinned
to a specific `openai/codex` commit — changes there need a documented
justification (why no extension point covers it, upstream merge risk,
whether it can become a hook/trait/plugin instead).

## Code

- Rust, 2021 edition, workspace in the repo root. Run
  `scripts/dev-check.sh` before pushing — it's what CI runs.
- New extension surfaces go in `crates/` as their own crate with a trait
  seam (see `crates/zero3-providers` for the pattern), not hard-coded into
  an existing crate.
- Side-effecting actions must route through
  `zero3_core::permission::PolicyEngine` — do not let a provider or plugin
  self-approve.

## Third-party code

If you copy, adapt, or closely follow code from another project (Codex,
DeepSeek Harness, Open Computer Use, xCodex, OpenCodex, iPolloWork, or
anything else):

- Confirm its license first. `OpenCodex` in particular has an unconfirmed
  AGPL flag noted in `docs/ARCHITECTURE.md` — do not copy from it without
  checking.
- Keep the original copyright/license notice attached to the copied file or
  its header, even if you also apply Apache-2.0 to the surrounding project.

## Commit / PR

- Small, focused PRs. One extension surface or fix per PR.
- Note in the PR description which module (`docs/ARCHITECTURE.md` table)
  it changes, and whether it moves something from "placeholder" to "real."

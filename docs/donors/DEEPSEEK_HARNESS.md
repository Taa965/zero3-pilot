# DeepSeek-Harness donor provenance

DeepSeek-Harness is a **capability donor** for Zero3 Pilot. It is not an Agent Kernel, runtime authority, provider runtime, or process that Zero3 Desktop starts alongside Codex.

## Pinned donor

- Repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- Zero3 submodule: `upstream/deepseek-harness`
- Reviewed SHA: `cd5ef8148158c3a752a658978873241fdf8e2bbc`
- License at the reviewed SHA: MIT

The donor pin is immutable inside feature PRs. A pin bump is a separate reviewed upstream-sync change.

## Capability seams relevant to the Zero3 roadmap

The reviewed donor exposes explicit seams that are useful as design/algorithm references without transferring runtime authority:

| Zero3 workstream | Donor seam / package family | Default derivation mode |
| --- | --- | --- |
| D1 output retention | `spill`, `spill-local`, `spill-policy` | design-derived / algorithm-derived |
| D2 context pruning | `compaction-tool-result-pruner` | algorithm-derived |
| D3 LSP | `lsp`, `lsp-stdio`, `tool-lsp` | design-derived / algorithm-derived |
| later team work | `experimental-agent-team` | design-derived |
| later background work | `jobs`, `jobs-local`, `tool-jobs` | design-derived |
| later workflow work | `workflow`, `workflow-worker-thread`, `tool-workflow` | design-derived |

This table is a provenance map, not permission to copy those packages into Zero3 wholesale. Codex remains the integration target and must use Codex-native extension/service boundaries where they exist.

## Required per-feature provenance

Every activated extension or patch that derives behavior from DeepSeek-Harness must add donor metadata to `codex-overlays/manifest.json`:

- `repo`: canonical donor repository;
- `sha`: the exact reviewed donor SHA above;
- `mode`: `design-derived`, `algorithm-derived`, or `code-port`;
- `source_files`: exact donor files used as evidence;
- `license`: license carried by the donor source;
- optional notes explaining behavior changes made for Codex.

For `code-port`, preserve the upstream copyright and MIT permission notice in the copied/substantially-derived source as required by the license. Design/algorithm derivations should still record the exact source files so later audits can distinguish inspiration from direct copying.

## Runtime boundary

The overlay foundation must never:

- launch `upstream/deepseek-harness` as a second agent runtime;
- route Zero3 Thread / Turn / Context / Tool / Approval / Git / Worktree authority through the donor;
- expose a generic donor RPC surface to the renderer;
- make DeepSeek-Harness state authoritative over Codex state.

If a donor capability cannot be represented through a Codex extension, the feature PR must document the missing Codex extension point before proposing a narrow Core patch.

## D0 status

D0 establishes only the provenance schema, pin checks, patch/extension ordering, replay tooling, architecture guards and CI. It does **not** port DeepSeek-Harness implementation code and it does not activate D1/D2/D3 feature patches.

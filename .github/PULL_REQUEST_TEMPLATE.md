## Summary

<!-- What problem does this solve? What user-visible/runtime behavior changes? -->

## Change type

- [ ] Runtime implementation / fix
- [ ] Architecture / integration boundary
- [ ] Tests / CI / reliability
- [ ] Documentation / release preparation
- [ ] Audit / POC only (not a merged capability claim)

## Authority / architecture impact

Which area does this change? See `docs/ARCHITECTURE_CONSTITUTION.md` and `docs/ARCHITECTURE.md`.

- [ ] Codex native runtime / app-server boundary
- [ ] Desktop presentation / typed IPC
- [ ] Codex overlay / extension
- [ ] Remote Host / control plane
- [ ] Executor / Handoff / Router
- [ ] Legacy/extension-only path
- [ ] No runtime authority change

Explain any authority change or why there is none:

## Upstream / provenance

Does this touch the pinned Codex source, Codex overlay, Hermes-derived shell, DeepSeek-Harness-derived capability, or other third-party code?

- [ ] No
- [ ] Yes — license/provenance and `docs/UPSTREAM.md` obligations are addressed

If the Codex gitlink/pin changes, explain why this is an isolated reviewed upstream-sync change.

## Security-sensitive changes

Check all that apply:

- [ ] Approval / sandbox / permission behavior
- [ ] Credential / authentication behavior
- [ ] Remote Host auth / lease / fencing / replay
- [ ] Executor / failover / Handoff writer authority
- [ ] Shell / filesystem / browser / computer-use side effects
- [ ] None

Describe fail-closed behavior and threat-boundary impact when applicable.

## Verification

List the exact commands, tests and GitHub Actions gates that validate this change. Do not mark a mocked/audit-only check as proof of real runtime behavior.

- [ ] `scripts/dev-check.sh` or equivalent core checks are addressed
- [ ] Required specialized Linux/Windows/Codex/feature gates are identified
- [ ] New behavior has regression coverage where practical
- [ ] Known limitations / deferred work are stated

## Release / docs impact

- [ ] `README.md`, architecture docs, `ROADMAP.md` or `CHANGELOG.md` updated if public capability/release status changes
- [ ] Not needed — no public capability/release-status change

## Supersedes / dependencies

<!-- Link stacked, superseded, blocking or follow-up PRs/issues. Make the authoritative implementation path clear. -->

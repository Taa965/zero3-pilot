# Zero3 Pilot Release Process

This document defines the minimum evidence required before Zero3 Pilot presents a Git tag/GitHub Release as public software.

Zero3 Pilot is currently pre-1.0. The first planned public milestone is `v0.1.0-alpha`.

## Principles

1. **Release the exact tree that was reviewed.** Release notes, upstream pins and validation evidence must correspond to the tagged SHA.
2. **Do not turn documentation into evidence.** A draft checklist or mocked test is not proof that a runtime path works.
3. **Codex runtime authority is a release gate.** A build that violates the architecture constitution is not releasable even if it appears functional.
4. **Fail closed on security uncertainty.** A high-risk pre-release feature may be deferred/disabled instead of weakening approval, credential, fencing or handoff boundaries.
5. **A smaller truthful alpha is better than a larger ambiguous one.** Optional integrations can move to the next pre-release rather than keeping the project permanently unreleased.

## Versioning before 1.0

Use semantic-version-style pre-release tags:

- `v0.1.0-alpha` — first public Codex-native development baseline;
- `v0.1.x-alpha.N` — corrective/iterative alpha when needed;
- `v0.2.0-alpha` — meaningful new pre-release capability set;
- `beta` only after installation/update/recovery/security behavior is stable enough for broader testing.

The exact scheme may evolve before 1.0, but a published tag must never be silently repointed to unrelated code.

## 1. Define the release candidate

Choose an exact `main` SHA and freeze the intended feature set.

For each open PR, explicitly decide one of:

- **blocker** — must be resolved before the tag;
- **include if green** — may merge before freeze but does not block the release indefinitely;
- **defer** — moves to a later pre-release.

For `v0.1.0-alpha`, the current roadmap treats durable AppServer conversation restart/persistence (#49) as a blocker and ACP external execution (#48) as optional if its final integration gates are clean.

After the feature freeze, avoid unrelated feature merges until the candidate has either shipped or been abandoned/re-cut.

## 2. Verify repository state

Before tagging:

- architecture constitution and common architecture guard agree with the code;
- `README.md`, `ROADMAP.md` and `CHANGELOG.md` describe only merged capability;
- superseded audit/POC PRs are closed or clearly marked so the authoritative path is obvious;
- `SECURITY.md`, `CONTRIBUTING.md` and `GOVERNANCE.md` are current;
- upstream submodule pins and overlay manifest/config pins agree;
- third-party `LICENSE`/`NOTICE`/provenance requirements are satisfied;
- no release document claims an artifact or validation that does not exist.

## 3. Required validation evidence

The exact candidate must satisfy every gate relevant to its contents.

At minimum for the first Codex-native alpha:

- repository architecture guard;
- Rust format, Clippy, build and tests for the workspace paths that remain part of the tree;
- Windows target-shell prepare/typecheck/build gate;
- Codex overlay verify/replay gate;
- real pinned-Codex CLI/app-server smoke;
- required R3/D/H/R4 milestone gates for features present in the tag;
- Remote Host reliability/control-plane gates if Remote Host is included;
- Native Executor/Handoff/Failover gates if those paths are included;
- session restart/persistence proof if #49 is part of the release candidate.

A known red release-blocking job cannot be waived merely because another platform/mock passes.

## 4. Security review

Review release-sensitive changes against [`../SECURITY.md`](../SECURITY.md):

- no generic Renderer-controlled Codex RPC path;
- no unexpected legacy-runtime fallback on migrated core behavior;
- approval/permission classes remain explicit/fail-closed;
- no credential-file/token extraction shortcut;
- Remote Host authentication/lease/fencing/replay invariants remain intact;
- Handoff writer/generation/checkpoint authority remains intact;
- external providers cannot forge task/router/handoff authority.

Known critical/high-impact boundary regressions must be fixed or the affected feature removed/deferred before release.

## 5. Build and user-facing evidence

For a desktop pre-release, provide one of:

- a reproducible packaged Windows artifact produced from the exact candidate; or
- if packaging is deliberately deferred, an explicit developer-build path that is tested and labeled as such.

When screenshots/demo are published, capture them from the real target build. Do not use mockups as evidence of shipped functionality without labeling them as design-only.

## 6. Finalize changelog and release notes

Update:

- [`../CHANGELOG.md`](../CHANGELOG.md) with the release date and exact scope;
- the version-specific draft under `docs/releases/` so open/deferred items are no longer described ambiguously;
- `README.md` status/links if the repository is no longer “no published release”.

Release notes should include:

- what the release is;
- key merged capabilities;
- architecture/security guarantees relevant to users;
- known limitations;
- upgrade/install/developer-build instructions where applicable;
- exact deferred features when users might otherwise assume they are present.

## 7. Tag and publish

Create the annotated/signed tag according to the maintainer's available signing setup, push the tag, and create a GitHub Release referencing the exact tag.

Attach only artifacts that can be traced to that candidate SHA. Record checksums when distributing binary artifacts directly.

Pre-release versions should be marked as **pre-release** in GitHub.

## 8. Post-release verification

After publication:

- verify the GitHub Release resolves to the intended tag/SHA;
- verify attached artifact names/checksums/downloads;
- verify README/Changelog links resolve correctly;
- open follow-up issues for deferred known limitations instead of silently editing the historical release claim;
- route security reports through the private advisory process.

If the release artifact is materially unsafe or incorrect, prefer a new corrective tag or withdrawing the artifact over silently replacing binaries under an existing tag.

## First-alpha checklist

The working checklist for `v0.1.0-alpha` is mirrored in [`releases/v0.1.0-alpha.md`](releases/v0.1.0-alpha.md) and should be tracked by a public release-readiness issue.

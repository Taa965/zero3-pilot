# Zero3 Pilot Governance

Zero3 Pilot is currently a small, maintainer-led open-source project in active pre-release development. This document makes the current decision and maintenance model explicit rather than implying a larger organization or community structure that does not yet exist.

## Current maintainer

The current primary maintainer and repository owner is GitHub user [`Taa965`](https://github.com/Taa965).

At this stage, the primary maintainer is responsible for:

- final merge/release decisions;
- architecture and runtime-authority consistency;
- upstream Codex pin/overlay policy;
- security triage and coordinated fixes;
- release readiness and changelog accuracy;
- deciding when experimental/audit work becomes an authoritative implementation.

This is a statement of the project's present governance, not a claim that every line of code was authored manually by one person or that outside contributions are absent/undesired.

## Technical constitution

Maintainer authority does not override the repository's published technical invariants.

[`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md) is the governing technical contract for native runtime authority. In particular, open-source Codex remains the authoritative native Agent Kernel/runtime unless that constitution is deliberately changed through a public architecture decision.

Security-sensitive decisions are additionally constrained by [`SECURITY.md`](SECURITY.md).

## How decisions are made

For ordinary changes:

1. a focused PR describes the problem, authority impact, security impact and validation evidence;
2. required automated gates run;
3. review checks the change against the architecture/security contracts;
4. the maintainer merges only the authoritative implementation path;
5. public capability/release documentation is updated when the merged behavior changes materially.

For major architecture changes, prefer a public issue/PR discussion and an explicit update to the architecture constitution/design documents rather than a silent implementation shortcut.

## Experimental and parallel work

Zero3 Pilot uses parallel branches/PRs for audits, POCs and staged implementation. Those branches are evidence and working history, not automatically product authority.

A draft/audit/POC PR must not be presented as a merged capability. When a formal implementation supersedes earlier exploration, the relationship should be linked clearly and obsolete PRs should eventually be closed or marked superseded.

## Contributions

External contributions, reviews and issue reports are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

As the contributor community grows, governance can evolve to include additional maintainers, code owners or area owners. Such roles should be granted based on sustained relevant contribution/review responsibility and recorded publicly rather than implied informally.

## Security decisions

Security vulnerabilities should not be debated in a public issue before a coordinated fix. Use the private reporting path in [`SECURITY.md`](SECURITY.md).

If a safe fix requires temporarily disabling a pre-release feature, fail-closed behavior takes priority over preserving feature availability.

## Releases

A release is a maintainer decision backed by an exact tag, required CI/security evidence and release notes that match the tagged tree. Draft documents or successful development branches are not releases.

See [`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md), [`CHANGELOG.md`](CHANGELOG.md) and [`ROADMAP.md`](ROADMAP.md).

## Governance changes

This document may evolve as the project gains contributors or reaches stable releases. Material governance changes should be made through a normal public repository change so contributors can see who holds which responsibilities and why.

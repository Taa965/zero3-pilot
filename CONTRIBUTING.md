# Contributing to Zero3 Pilot

Zero3 Pilot is an active pre-release project. Contributions are welcome, but the repository deliberately favors explicit authority boundaries and reproducible integration over adding features through shortcuts.

Before making a substantial change, read:

- [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md) — non-negotiable runtime authority rules;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current implementation/migration structure;
- [`docs/UPSTREAM.md`](docs/UPSTREAM.md) — pinned Codex and overlay policy;
- [`SECURITY.md`](SECURITY.md) — security-sensitive boundaries;
- [`ROADMAP.md`](ROADMAP.md) — current release priorities.

## Development setup

Clone with submodules so the reviewed upstream sources are available:

```bash
git clone --recurse-submodules https://github.com/Taa965/zero3-pilot.git
cd zero3-pilot
```

Run the local core pre-push gate:

```bash
./scripts/dev-check.sh
```

That gate checks the core architecture invariant plus Rust format, Clippy warnings, workspace build and tests. Specialized Codex, Windows target-shell, Remote Host, overlay and milestone-specific gates remain authoritative in GitHub Actions.

For the target desktop orchestration path:

```powershell
cd apps/zero3-desktop
npm run prepare
npm run typecheck
npm run dev
```

Do not interpret a passing legacy Node/Wry/provider test as permission to move target-runtime authority back into that path.

## Architecture rules

### Codex remains the native Agent Kernel

Open-source Codex is the authoritative native runtime for Thread / Turn / Item state, the primary agent loop, tool execution, approvals, shell/files, MCP and related execution semantics.

A contribution must not introduce a second hidden primary agent loop merely because it is easier to integrate.

### Keep the Renderer boundary narrow

Do not expose an arbitrary `method + params` Codex JSON-RPC tunnel to the Renderer. Add named typed surfaces for reviewed capabilities.

### Fail closed at permission boundaries

Unsupported server requests, permission modes or external-provider capabilities must fail closed until there is dedicated reviewed handling.

Providers/external executors must not self-approve or acquire Task/Router/Handoff authority simply because they can execute work.

### Preserve identity and durability semantics

Changes to Remote Host, Handoff, Executor or recovery code must preserve the existing identity boundaries relevant to that component: task/execution identity, Thread/Turn identity, generation/checkpoint identity, lease/fencing identity and durable replay/terminal semantics.

Do not silently create a replacement session/context after a resume failure unless an explicit product contract authorizes that behavior.

## Before touching `upstream/codex`

Read [`docs/UPSTREAM.md`](docs/UPSTREAM.md) first.

`upstream/codex` is pinned to a reviewed commit. Normal feature PRs must not casually move the gitlink. Zero3-specific Codex behavior belongs in the managed overlay/extension system unless a documented extension gap requires a narrow Core patch.

A Codex Core patch must document:

1. the extension gap;
2. why an extension/hook/service cannot express the change;
3. affected overlay/patch files;
4. provenance/licensing when behavior is donor-derived;
5. replay/CI evidence and upstream-drift risk.

A Codex pin bump should be an isolated upstream-sync change, not hidden inside a product feature PR.

## Code areas

The repository currently contains several implementation languages and authority levels:

- Rust workspace code under `crates/` and legacy/extension apps;
- Electron/React/TypeScript/JavaScript target-desktop adapters and orchestration;
- `codex-overlays/` for managed Codex-native extension/patch integration;
- `apps/zero3-desktop/executor-runtime/` for provider-neutral Executor, Native Codex executor, Handoff and Router/failover work;
- Remote Host/control-plane code and deployment/productization contracts;
- pinned upstream submodules that must retain their own license/provenance rules.

Prefer a small change in the correct authority layer over a large cross-layer shortcut.

## Third-party code and capability donors

Before copying, adapting or closely following another project:

- confirm the source license and compatibility with the destination;
- preserve required copyright/license notices;
- document donor provenance where the repository policy requires it;
- decide whether the behavior belongs in a Codex extension, a Zero3 tool/provider, an executor adapter or presentation code;
- never use donor code as a reason to start an unreviewed parallel long-lived Agent Kernel.

When license status is unclear, stop and resolve it before importing code.

## Pull requests

Prefer small, focused PRs. One authority boundary, integration surface or fix per PR is easier to review and safer to merge.

A good PR should state:

- the problem and user-visible effect;
- the architecture/module it changes;
- whether it touches the Codex pin, Codex overlay/Core, approval/sandbox behavior, credentials, Remote Host, Executor/Handoff/Router authority or deployment surfaces;
- the exact tests/gates that validate the change;
- known limitations and follow-up work;
- whether the change is runtime implementation, audit/POC, documentation, or release preparation.

Do not describe an audit/POC branch as a merged production capability. If a PR supersedes an older implementation/audit PR, link it clearly so the authoritative path is obvious.

## Security changes

Do not put suspected vulnerabilities or real credentials in public issues/PRs. Follow [`SECURITY.md`](SECURITY.md) and use GitHub private vulnerability reporting.

Changes involving approvals, credential handling, external executors, Remote Host authentication/fencing, Handoff writer authority or replay of side effects deserve explicit security review in the PR description.

## Documentation and releases

Public documentation should match the actual merged tree. When a feature materially changes project capability or release readiness, update the relevant architecture document and, when appropriate, [`CHANGELOG.md`](CHANGELOG.md) or [`ROADMAP.md`](ROADMAP.md).

A draft release document is not a release. Only a real tag/GitHub Release backed by the required evidence should be presented as published software.

Thanks for helping make the Codex integration more reviewable, reproducible and secure.

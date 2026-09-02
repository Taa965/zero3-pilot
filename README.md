# Zero3 Pilot

[![CI](https://github.com/Taa965/zero3-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Taa965/zero3-pilot/actions/workflows/ci.yml)
[![Codex Core Smoke](https://github.com/Taa965/zero3-pilot/actions/workflows/codex-core-smoke.yml/badge.svg)](https://github.com/Taa965/zero3-pilot/actions/workflows/codex-core-smoke.yml)

**An Apache-2.0 desktop agent project built around OpenAI's open-source Codex app-server as the authoritative native Agent Kernel/runtime.**

Zero3 Pilot explores what a Codex-native desktop agent can look like when Codex remains in control of Threads, Turns, Items, tool execution, approvals, shell/files, MCP and the primary agent loop, while Zero3 adds a desktop product layer, explicit security boundaries, durability/recovery work, Remote Host infrastructure and controlled executor/handoff orchestration.

> **Status: active development / pre-release.** Zero3 Pilot is not production-ready and does not claim broad external adoption. No GitHub Release has been published yet. The first planned public milestone is [`v0.1.0-alpha`](docs/releases/v0.1.0-alpha.md).

## Why this project exists

Embedding an agent runtime into a desktop product requires more than calling a model. A serious integration has to handle runtime lifecycle, protocol compatibility, durable sessions, streaming events, approvals, user input, tool/file/shell presentation, permission boundaries, context pressure, remote execution reliability, upstream drift and release regressions.

Zero3 Pilot makes those concerns explicit and testable around the open-source Codex app-server rather than hiding them behind a second competing agent runtime.

The project is intended to provide a practical implementation/reference surface for:

- Codex app-server lifecycle and JSONL protocol integration;
- mapping Codex Thread / Turn / Item primitives into a desktop UX;
- fail-closed approval, input and permission handling;
- deterministic development against a pinned open-source Codex revision;
- real-protocol CI smokes that catch integration regressions;
- recoverable context/output management around long-running agent work;
- Remote Host durability, leases/fencing and crash-safe evidence delivery;
- executor selection/handoff/failover without moving native Agent Kernel authority away from Codex.

## What is already on `main`

The repository is young, but the current `main` is beyond a transport-only prototype. The table below intentionally lists only merged work; deferred work is shown separately.

| Area | Current merged baseline | Evidence |
| --- | --- | --- |
| Codex desktop path | Typed app-server transport; Thread/Turn/Item primary chat; native approval/input; tool/reasoning presentation; structured input; native thread actions; authoritative Turn mapping/history | [R1A-R3F PR history](https://github.com/Taa965/zero3-pilot/pulls?q=is%3Apr+is%3Amerged+R3) |
| Session persistence | Explicit Zero3 AppServer session-source identity plus real first-Turn cold-restart discovery/read verification | [PR #49](https://github.com/Taa965/zero3-pilot/pull/49) |
| Codex integration resilience | Deterministic overlay/replay infrastructure; lossless oversized tool-output spill/recovery (D1); recoverable compaction-input pruning without authoritative-history mutation (D2) | [PR #30](https://github.com/Taa965/zero3-pilot/pull/30), [#33](https://github.com/Taa965/zero3-pilot/pull/33), [#31](https://github.com/Taa965/zero3-pilot/pull/31) |
| Remote Host | Narrow Codex-backed host runtime, crash-safe durable outbox, strict publication ordering, durable authenticated control plane with leases/fencing/replay/terminal validation | [PR #36](https://github.com/Taa965/zero3-pilot/pull/36), [#37](https://github.com/Taa965/zero3-pilot/pull/37), [#38](https://github.com/Taa965/zero3-pilot/pull/38), [#39](https://github.com/Taa965/zero3-pilot/pull/39) |
| Executor control | Provider-neutral Executor contract, durable Git/workspace handoff, automatic failover controller, Native Codex executor | [PR #44](https://github.com/Taa965/zero3-pilot/pull/44), [#45](https://github.com/Taa965/zero3-pilot/pull/45), [#46](https://github.com/Taa965/zero3-pilot/pull/46), [#47](https://github.com/Taa965/zero3-pilot/pull/47) |
| Windows alpha packaging | Exact reviewed pinned Codex release build, bundled `resources/zero3-codex/codex.exe`, packaged-runtime fail-closed resolver, legal notices, NSIS artifact gate and real bundled app-server smoke | [PR #51](https://github.com/Taa965/zero3-pilot/pull/51) |
| Public maintenance/security | Architecture constitution, contribution rules, governance, release process, security policy/private reporting, issue/PR templates, Linux + Windows and feature-specific CI gates | [`CONTRIBUTING.md`](CONTRIBUTING.md), [`GOVERNANCE.md`](GOVERNANCE.md), [`SECURITY.md`](SECURITY.md), [workflows](.github/workflows) |

### First-alpha closeout status

The two implementation blockers tracked for the first alpha are now merged:

- [PR #49](https://github.com/Taa965/zero3-pilot/pull/49) — Zero3 explicitly launches Codex with `--session-source app-server`, lists the matching `sourceKinds: ['appServer']` namespace, and verifies two first-Turn durable Threads across an app-server cold restart with the same `CODEX_HOME`.
- [PR #51](https://github.com/Taa965/zero3-pilot/pull/51) — the Windows packaging path builds the exact reviewed Codex pin, bundles it under application resources, carries required legal notices, refuses arbitrary packaged-runtime substitution, produces an NSIS installer, and verifies the packaged binary with a real app-server smoke.

The #51 pull-request merge candidate already combined the merged #49 tree with #51 and passed the Windows Alpha Artifact workflow. That is useful integrated pre-tag evidence, but it is **not** substituted for final evidence on the exact release SHA.

Before `v0.1.0-alpha` is presented as published software, the final documentation-closeout tree still needs its exact-candidate release gates, Windows artifact/checksum evidence, tag and GitHub pre-release publication. Until those facts exist, the repository remains pre-release and no installer/checksum is presented here as the final public release artifact.

### Explicitly deferred from the first alpha

- [PR #48](https://github.com/Taa965/zero3-pilot/pull/48) — formal ACP external-executor runtime. It is **not** part of `v0.1.0-alpha`: its dedicated behavior suite currently fails on both Ubuntu and Windows (including deny -> `succeeded` instead of `cancelled`, and protocol-version mismatch -> `unavailable` instead of `unsupported`) and the branch needs replay/rebase onto the post-R4C stack. It will be repaired and revalidated in a later pre-release rather than waived into the first alpha.

See [`ROADMAP.md`](ROADMAP.md) for release criteria and the post-alpha direction.

## Architecture

The roles are intentionally asymmetric:

- **Open-source Codex = the only core Agent Kernel / runtime authority.** In the current product architecture it is the authoritative native Agent Kernel/runtime.
- **Hermes Agent = desktop UI/UX shell source.** Remaining runtime use is compatibility scaffolding for unported surfaces, not a second Zero3 core.
- **DeepSeek-Harness = capability donor/reference.** Useful capabilities may be audited and re-expressed through Codex-native extension seams.
- **Installed Codex / Claude / Hermes applications = external collaborators.** They may participate through reviewed executor/collaboration boundaries but do not define the Zero3 native runtime.

```text
                    Zero3 Pilot
                         |
              Hermes-derived Desktop UI
              (Electron + React shell)
                         |
                  Zero3 UI Adapter
                         |
                  codex app-server
                         |
          open-source Codex Agent Kernel
                         |
          +--------------+--------------+
          |                             |
   Zero3 extensions              Executor / Collaboration
  tools/MCP/hooks/etc.                    |
          |                    +----------+----------+
          |                    |          |          |
 DeepSeek-derived        Native Codex  external    Remote Host
 capabilities             executor     agents      integration
```

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md) for non-negotiable authority rules and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the current implementation summary.

## Reproducible Codex integration

`upstream/codex` is pinned to a reviewed source revision. Zero3-owned Codex extensions/patches are represented through the managed overlay system instead of silently editing the submodule baseline.

The repository provides:

- exact pin verification;
- unmanaged-worktree and unlisted-patch guards;
- deterministic manifest-ordered overlay application;
- detached replay against candidate upstream Codex SHAs for drift detection;
- architecture guards around runtime authority;
- real pinned-Codex build/app-server protocol smoke coverage.

See [`docs/UPSTREAM.md`](docs/UPSTREAM.md) for the full policy.

## CI and maintenance evidence

Zero3 Pilot uses small, focused PRs and explicit integration gates. Current workflows include:

- Linux Rust format/lint/build/test checks;
- Windows preparation/typecheck/build of the Hermes-derived Codex-core target shell;
- a **real Codex Core Smoke** that builds the pinned open-source Codex CLI and exercises `codex app-server` JSONL flow;
- a **Windows Alpha Artifact** gate that builds the packaged pinned Codex runtime, checks legal resources, performs a real bundled-binary app-server smoke and uploads the NSIS candidate;
- milestone-specific R3/D/H/R4 architecture and behavior gates;
- Remote Host durability and control-plane smokes;
- Codex overlay verify/replay gates;
- legacy/extension smokes that are explicitly prevented from redefining the target Agent Kernel.

This repository treats a green legacy test as compatibility evidence, not permission for a legacy runtime to become the product core. Conversely, a provider integration whose dedicated semantic gate is red is deferred rather than counted as release-ready functionality.

## Repository layout

```text
zero3-pilot/
├─ upstream/codex/              # CORE: pinned open-source Codex source
├─ upstream/hermes-agent/       # UI/UX shell source
├─ upstream/deepseek-harness/   # capability donor/reference
├─ codex-overlays/              # reviewed Codex-native extensions/patch chain
├─ apps/zero3-desktop/          # Zero3-owned target desktop orchestration/adapters
├─ apps/zero3-desktop/executor-runtime/
│  ├─ native/                   # Native Codex executor
│  ├─ handoff/                  # durable workspace/Git handoff
│  └─ router/                   # failover controller
├─ apps/node/                   # legacy/extension host; NOT native runtime authority
├─ docs/                        # architecture, migration, audits and upstream notes
├─ ROADMAP.md                   # public release/product direction
├─ CHANGELOG.md                 # public pre-release/release history
└─ .github/workflows/           # CI and integration gates
```

## Quick start for contributors

Clone with the pinned upstream sources:

```bash
git clone --recurse-submodules https://github.com/Taa965/zero3-pilot.git
cd zero3-pilot
```

Run the core local pre-push gate:

```bash
./scripts/dev-check.sh
```

That gate includes the architecture guard plus Rust format, Clippy, build and tests. Specialized Windows, Codex and feature-specific gates remain authoritative in GitHub Actions.

For the target desktop shell:

```powershell
cd apps/zero3-desktop
npm run prepare
npm run typecheck
npm run dev
```

`npm run dev` builds/resolves the pinned open-source Codex CLI when needed and points the desktop path at that exact binary. During migration, parts of the Hermes backend may still boot only to support UI surfaces that have not yet been ported; new or migrated Zero3 core capabilities must use Codex-owned/reviewed boundaries.

The Windows packaging implementation is merged, but the public alpha installer is not considered shipped until the exact release candidate passes the final release gates and a GitHub pre-release is published. See [`docs/WINDOWS_INSTALL.md`](docs/WINDOWS_INSTALL.md).

## Releases and roadmap

- [`ROADMAP.md`](ROADMAP.md) — what is merged, what remains before the first alpha, what is explicitly deferred and what comes after it.
- [`CHANGELOG.md`](CHANGELOG.md) — public pre-release/release history.
- [`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md) — evidence required before a tag is presented as a release.
- [`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md) — draft first-alpha release notes and release checklist.

The repository deliberately does **not** label the draft as a real release until a tag/artifact exists and the exact candidate has passed the required gates.

## Contributing

Contributions and technical review are welcome while the project is still early.

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing the pinned Codex source or introducing third-party-derived code. In particular:

- prefer small, focused PRs;
- preserve Codex as the native runtime authority;
- route side-effecting behavior through reviewed permission/authority boundaries;
- document upstream-code provenance and license obligations;
- do not present mocks, audit branches or planned features as merged runtime capability.

## Governance

Zero3 Pilot is currently a small maintainer-led project. [`GOVERNANCE.md`](GOVERNANCE.md) records the current maintainer responsibilities and decision process without implying a larger organization than actually exists.

## Security

Zero3 Pilot is designed to operate across sensitive local-machine surfaces such as shell, filesystem, browser/computer automation, Remote Host control and external-agent dispatch. Security boundaries are therefore first-class architecture even during pre-release development.

Please follow [`SECURITY.md`](SECURITY.md) and use GitHub private vulnerability reporting for suspected security issues.

## Project independence and upstream notices

- Zero3 Pilot is an independent, unofficial open-source project. It is **not** an OpenAI product.
- Codex is a project/trademark of OpenAI; Zero3's native agent core is based on the open-source Codex repository pinned under `upstream/codex`.
- Hermes Agent UI/UX code and DeepSeek-Harness are governed by their respective upstream licenses.
- Every third-party dependency remains subject to its own license; see [`NOTICE`](NOTICE) and [`docs/UPSTREAM.md`](docs/UPSTREAM.md).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

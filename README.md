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

The repository is young, but the current `main` is beyond a transport-only prototype. The table below intentionally lists only merged work; open PRs are shown separately.

| Area | Current merged baseline | Evidence |
| --- | --- | --- |
| Codex desktop path | Typed app-server transport; Thread/Turn/Item primary chat; native approval/input; tool/reasoning presentation; structured input; native thread actions; authoritative Turn mapping/history | [R1A-R3F PR history](https://github.com/Taa965/zero3-pilot/pulls?q=is%3Apr+is%3Amerged+R3) |
| Codex integration resilience | Deterministic overlay/replay infrastructure; lossless oversized tool-output spill/recovery (D1); recoverable compaction-input pruning without authoritative-history mutation (D2) | [PR #30](https://github.com/Taa965/zero3-pilot/pull/30), [#33](https://github.com/Taa965/zero3-pilot/pull/33), [#31](https://github.com/Taa965/zero3-pilot/pull/31) |
| Remote Host | Narrow Codex-backed host runtime, crash-safe durable outbox, strict publication ordering, durable authenticated control plane with leases/fencing/replay/terminal validation | [PR #36](https://github.com/Taa965/zero3-pilot/pull/36), [#37](https://github.com/Taa965/zero3-pilot/pull/37), [#38](https://github.com/Taa965/zero3-pilot/pull/38), [#39](https://github.com/Taa965/zero3-pilot/pull/39) |
| Executor control | Provider-neutral Executor contract, durable Git/workspace handoff, automatic failover controller, Native Codex executor | [PR #44](https://github.com/Taa965/zero3-pilot/pull/44), [#45](https://github.com/Taa965/zero3-pilot/pull/45), [#46](https://github.com/Taa965/zero3-pilot/pull/46), [#47](https://github.com/Taa965/zero3-pilot/pull/47) |
| Public maintenance/security | Architecture constitution, contribution rules, security policy/private reporting, issue/PR templates, Linux + Windows and feature-specific CI gates | [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), [workflows](.github/workflows) |

### Active work, not yet part of the merged baseline

- [PR #49](https://github.com/Taa965/zero3-pilot/pull/49) — durable AppServer conversation discovery after restart plus a real pinned-Codex persistence smoke. This is treated as a blocker for the first public alpha.
- [PR #48](https://github.com/Taa965/zero3-pilot/pull/48) — formal ACP external-executor runtime. It may enter the first alpha if final integration gates are clean; otherwise it can ship in the next pre-release.

See [`ROADMAP.md`](ROADMAP.md) for release criteria and the post-alpha direction.

## Architecture

The roles are intentionally asymmetric:

- **Open-source Codex = authoritative native Agent Kernel/runtime.**
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

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md) for non-negotiable authority rules and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for detailed implementation history.

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
- milestone-specific R3/D/H/R4 architecture and behavior gates;
- Remote Host durability and control-plane smokes;
- Codex overlay verify/replay gates;
- legacy/extension smokes that are explicitly prevented from redefining the target Agent Kernel.

This repository treats a green legacy test as compatibility evidence, not permission for a legacy runtime to become the product core.

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

Run the architecture guard before feature work:

```bash
node scripts/check-architecture.mjs
```

Existing Rust compatibility/extension code is covered by:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --all-targets
cargo test --workspace
```

For the target desktop shell:

```powershell
cd apps/zero3-desktop
npm run prepare
npm run typecheck
npm run dev
```

`npm run dev` builds/resolves the pinned open-source Codex CLI when needed and points the desktop path at that exact binary. During migration, parts of the Hermes backend may still boot only to support UI surfaces that have not yet been ported; new or migrated Zero3 core capabilities must use Codex-owned/reviewed boundaries.

## Releases and roadmap

- [`ROADMAP.md`](ROADMAP.md) — what is merged, what blocks the first alpha and what comes after it.
- [`CHANGELOG.md`](CHANGELOG.md) — public pre-release/release history.
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

# Zero3 Pilot

**An early-stage, Apache-2.0 desktop agent project built around OpenAI's open-source Codex app-server as the authoritative agent runtime.**

Zero3 Pilot explores what a Codex-native desktop agent can look like when the open-source Codex runtime remains in control of Threads, Turns, Items, tool execution, approvals, shell/files, MCP and the primary agent loop, while the desktop layer adds explicit UX, security boundaries and multi-agent collaboration.

> **Project status:** active development / pre-release. Zero3 Pilot is not yet production-ready. The repository is public early so architecture, security and integration decisions can be reviewed as the project evolves.

## Why this project exists

Embedding an agent runtime into a desktop product requires more than calling a model. A real integration has to handle runtime lifecycle, protocol compatibility, durable sessions, streaming events, approval and user-input requests, tool/file/shell presentation, permission boundaries, upstream changes and release regressions.

Zero3 Pilot makes those integration concerns explicit and testable around the open-source Codex app-server rather than hiding them behind a second competing agent runtime.

The project is intended to provide a practical reference surface for:

- Codex app-server lifecycle and JSONL protocol integration;
- mapping Codex Thread / Turn / Item primitives into a desktop UX;
- fail-closed approval, input and permission handling;
- reproducible development against a pinned open-source Codex revision;
- real-protocol smoke tests that catch Codex integration regressions;
- future collaboration with external Codex, Claude, Hermes and other agent applications without replacing Codex as the native kernel.

## Architecture

The architectural roles are intentionally asymmetric:

- **Open-source Codex = the only native Agent Kernel / runtime authority.**
- **Hermes Agent = desktop UI/UX shell source.** Its runtime is temporary compatibility scaffolding during migration, not a second Zero3 core.
- **DeepSeek-Harness = capability donor/reference.** Useful capabilities may be audited and re-expressed through Codex-native extension seams.
- **Installed Codex / Claude / Hermes applications = external collaborators.** They may participate through a formal collaboration layer but do not define Zero3 runtime authority.

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
   Zero3 extensions              Multi-Agent Collaboration
  tools/MCP/hooks/etc.                    |
          |                    +----------+----------+
          |                    |          |          |
 DeepSeek-derived         Codex app   Claude app   Hermes/others
 capabilities              external     external     external
```

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md) for the non-negotiable architecture rules and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the current migration state.

## Implemented integration foundations

The repository already contains the core boundaries needed for a real Codex-native desktop integration:

- Electron main owns a `codex app-server --stdio` child process;
- development resolves/builds the Codex binary from the exact pinned `upstream/codex` source instead of silently relying on an arbitrary host-installed agent;
- `initialize` / `initialized`, JSONL request correlation, lifecycle supervision, notifications and server-originated requests are handled through a typed boundary;
- renderer access is purpose-specific instead of exposing a generic arbitrary JSON-RPC tunnel;
- primary chat/session behavior is being mapped onto Codex Thread / Turn / Item semantics;
- native approval and user-input UX is implemented with fail-closed handling for unsupported request classes;
- the default sandbox remains conservative while permission and execution UX evolves;
- Codex reasoning, command execution, file changes and MCP activity have dedicated desktop presentation paths;
- architecture guards prevent legacy compatibility components from silently becoming the primary runtime again.

The detailed source-of-truth for completed and in-progress migration work is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Maintainer and CI workflow

Zero3 Pilot is maintained with small, focused changes and explicit integration gates.

Key repository practices include:

- focused PRs with architecture-impact notes;
- an architecture guard before feature work;
- pinned upstream Codex source for deterministic integration;
- Rust formatting, lint, build and test gates for compatibility/extension code;
- dedicated GitHub Actions workflows for Codex integration milestones;
- a real pinned-Codex app-server smoke that builds the configured Codex source and exercises the JSONL protocol instead of only mocking the boundary;
- a public security policy and private vulnerability-reporting path.

The dedicated Codex Core Smoke currently builds the pinned open-source Codex CLI and exercises a real `codex app-server` handshake in CI.

## Repository layout

```text
zero3-pilot/
├─ upstream/codex/              # CORE: pinned open-source Codex source
├─ upstream/hermes-agent/       # UI/UX shell source
├─ upstream/deepseek-harness/   # capability donor/reference
├─ apps/zero3-desktop/          # Zero3-owned desktop overlay + Codex adapter
├─ crates/zero3-subagents/      # legacy name; external-agent collaboration adapters
├─ apps/node/                   # legacy/extension host; NOT core runtime authority
├─ docs/                        # architecture, migration, audits and upstream notes
└─ .github/workflows/           # CI and Codex integration gates
```

## Quick start for contributors

Clone with submodules so the pinned upstream sources are available:

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

`npm run dev` builds the pinned open-source Codex CLI when needed, points Electron at that exact binary and gives Zero3 an isolated Codex home. During migration, parts of the Hermes backend may still boot only to support UI surfaces that have not yet been ported; new Zero3 runtime capabilities must use the Codex-owned boundary.

## Roadmap

The active roadmap is organized around preserving Codex runtime authority while expanding the desktop product:

1. complete native Thread / Turn / Item desktop parity;
2. finish execution, permission, attachment and thread-management UX;
3. formalize external-agent collaboration and handoff;
4. attach scheduler, memory, browser/computer, messaging and workflows through Codex-native extension seams;
5. audit and selectively absorb useful third-party capabilities without creating parallel long-lived agent runtimes;
6. publish reproducible pre-release builds once the desktop path meets the required integration and security gates.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the detailed phase breakdown.

## Contributing

Contributions and technical review are welcome while the project is still early.

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing the pinned Codex source or introducing third-party-derived code. In particular:

- prefer small, focused PRs;
- preserve Codex as the native runtime authority;
- route side-effecting behavior through the project permission boundary;
- document upstream-code provenance and license obligations.

## Security

Zero3 Pilot is designed to eventually operate across sensitive local-machine surfaces such as shell, filesystem, browser/computer automation and external-agent dispatch. Security boundaries are therefore treated as first-class architecture even during pre-release development.

Please follow [`SECURITY.md`](SECURITY.md) and use GitHub private vulnerability reporting for suspected security issues.

## Upstream and project independence

- Zero3 Pilot is an independent, unofficial open-source project. It is **not** an OpenAI product.
- Codex is a project/trademark of OpenAI; Zero3's native agent core is based on the open-source Codex repository pinned under `upstream/codex`.
- Hermes Agent UI/UX code and DeepSeek-Harness are governed by their respective upstream licenses.
- Every third-party dependency remains subject to its own license; see [`docs/UPSTREAM.md`](docs/UPSTREAM.md) before importing upstream code.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

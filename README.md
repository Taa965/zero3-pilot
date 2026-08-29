# Zero3 Pilot

**A Codex-core desktop agent application: OpenAI's open-source Codex is the Agent Kernel, Hermes Agent provides the desktop UI shell, and DeepSeek-Harness is a capability donor.**

## Product definition

Zero3 Pilot is a deep secondary development of the open-source `openai/codex` project.

The architectural roles are intentionally asymmetric:

- **Open-source Codex = the only core Agent Kernel / runtime authority.** Threads, turns, context, tool execution, approvals, shell, files, MCP, Git/worktree and the primary agent loop belong to Codex.
- **Hermes Agent = desktop UI/UX shell.** Zero3 reuses the pinned Electron + React desktop experience, but Hermes runtime/gateway is not a Zero3 product core. During migration it may exist only as a temporary compatibility backend needed to render/test the upstream shell.
- **DeepSeek-Harness = capability donor.** Useful ideas and implementations are studied, re-expressed and integrated into Codex/Zero3. DeepSeek-Harness must not become a parallel long-lived runtime.
- **Installed Codex / Claude / Hermes applications = external collaborators.** Zero3 may inspect, instruct, continue, hand off, review or take over their unfinished work through the Multi-Agent Collaboration module. They are workers controlled by Zero3, never the core that defines Zero3.

The invariant is simple:

```text
Hermes-derived Electron/React UI
              |
              v
      Zero3 Codex Adapter
              |
              v
   open-source Codex app-server
       (authoritative core)
              |
       Zero3 extensions

External Codex/Claude/Hermes apps
              ^
              |
    Multi-Agent Collaboration
```

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md) for the non-negotiable architecture rules and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the migration layout.

## Current migration status

The repository contains code from an earlier architecture that made `zero3-pilot-node` the local runtime authority and routed Codex/Claude/Hermes through a worker registry. That code is now **legacy/extension-host code, not the target core architecture**.

The architecture-reset work has the following order:

1. Detach the Hermes-derived desktop shell from Zero3 Node as its product core.
2. Make pinned open-source `codex app-server` the authoritative desktop transport.
3. Map Hermes chat/session/tool/approval UI onto Codex Thread / Turn / Item / approval events.
4. Reclassify existing Codex/Claude/Hermes CLI adapters as External Agent Collaboration adapters.
5. Move scheduler, memory, browser/computer automation and other Zero3 features behind Codex-native tools/MCP/extensions instead of a competing Agent Kernel.
6. Selectively absorb DeepSeek-Harness capabilities into the Codex/Zero3 core and extension layer.

Until a migration step is complete, compatibility code may remain buildable for rollback and evidence, but it must not be extended as a competing core runtime.

## Repository layout

```text
zero3-pilot/
├─ upstream/codex/              # CORE: pinned open-source Codex source
├─ upstream/hermes-agent/       # UI/UX shell source
├─ upstream/deepseek-harness/   # capability donor/reference
├─ apps/zero3-desktop/          # Zero3-owned Hermes UI overlay + Codex adapter migration
├─ crates/zero3-subagents/      # legacy name; External Agent Collaboration adapters
├─ apps/node/                   # legacy/extension host; NOT Zero3 core authority
└─ docs/                        # architecture constitution, migration and audits
```

## Development

The architecture guard must pass before feature work:

```bash
node scripts/check-architecture.mjs
```

Existing Rust compatibility/extension code remains covered by:

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

During the R0 reset, `npm run dev` may still start Hermes' compatibility backend because the upstream UI currently expects it. That backend is temporary scaffolding only; new Zero3 product capabilities must target Codex app-server.

## Notices

- Zero3 Pilot is an independent, unofficial project. It is **not** an OpenAI product.
- Codex is a project/trademark of OpenAI; Zero3's core is based on the open-source Codex repository pinned under `upstream/codex`.
- Hermes Agent UI/UX code and DeepSeek-Harness are governed by their respective upstream licenses.
- Every third-party dependency remains subject to its own license; see [`docs/UPSTREAM.md`](docs/UPSTREAM.md) and `CONTRIBUTING.md` before importing upstream code.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

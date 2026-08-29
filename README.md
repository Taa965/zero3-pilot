# Zero3 Pilot

**A Codex-core desktop agent application: OpenAI's open-source Codex is the Agent Kernel, Hermes Agent provides the desktop UI shell, and DeepSeek-Harness is a capability donor.**

## Product definition

Zero3 Pilot is a deep secondary development of the open-source `openai/codex` project.

The architectural roles are intentionally asymmetric:

- **Open-source Codex = the only core Agent Kernel / runtime authority.** Threads, turns, context, tool execution, approvals, shell, files, MCP, Git/worktree and the primary agent loop belong to Codex.
- **Hermes Agent = desktop UI/UX shell.** Zero3 reuses the pinned Electron + React desktop experience, but Hermes runtime/gateway is not a Zero3 product core. During migration it may exist only as temporary compatibility scaffolding needed by unported UI.
- **DeepSeek-Harness = capability donor.** Useful ideas and implementations are studied, re-expressed and integrated into Codex/Zero3. DeepSeek-Harness must not become a parallel long-lived runtime.
- **Installed Codex / Claude / Hermes applications = external collaborators.** Zero3 may inspect, instruct, continue, hand off, review or take over their unfinished work through Multi-Agent Collaboration. They are workers controlled by Zero3, never the core that defines Zero3.

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

See [`docs/ARCHITECTURE_CONSTITUTION.md`](docs/ARCHITECTURE_CONSTITUTION.md) for the non-negotiable rules and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the migration layout.

## Current migration status

R0 removed the incorrect target architecture that made `zero3-pilot-node` the desktop runtime authority.

**R1A now establishes the first Zero3-owned Codex core boundary:**

- Electron main owns a `codex app-server --stdio` child;
- development resolves/builds that `codex` binary from the exact pinned `upstream/codex` source tree instead of silently using a host-installed Agent;
- `initialize` / `initialized`, JSONL correlation, lifecycle supervision and server-originated request forwarding are implemented;
- Renderer access is purpose-specific: `thread/start`, `thread/resume`, `thread/list`, `thread/read`, `turn/start`, `turn/interrupt`, event subscription and responses to outstanding Codex server requests;
- no generic Renderer-controlled JSON-RPC method proxy is exposed;
- the old Zero3 Node chat/memory/schedule/browser bridges remain disabled on the target desktop path.

R1A does **not** yet mean the visible Hermes chat UI is backed by Codex. The existing Hermes backend remains temporary UI scaffolding until R2 maps the primary chat/session UI onto Codex Thread / Turn / Item events.

Migration order:

1. **R0 — complete:** architecture reset and guard.
2. **R1A — current:** typed Codex app-server lifecycle/transport boundary.
3. **R2 — next:** map Hermes chat/session/stream/Stop/restore UI to Codex.
4. R3: Codex tool/file/shell/approval/MCP execution UX.
5. R4: formal External Agent Collaboration with inspect/continue/handoff/takeover.
6. R5: attach scheduler, memory, browser/computer, messaging and workflows through Codex-native extension seams.
7. R6: selectively absorb DeepSeek-Harness capabilities.

Legacy Node/Wry/provider code remains buildable as migration evidence, but it must not evolve into a competing Agent Kernel.

## Repository layout

```text
zero3-pilot/
├─ upstream/codex/              # CORE: pinned open-source Codex source
├─ upstream/hermes-agent/       # UI/UX shell source
├─ upstream/deepseek-harness/   # capability donor/reference
├─ apps/zero3-desktop/          # Zero3-owned Hermes UI overlay + Codex adapter
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

`npm run dev` builds the pinned open-source Codex CLI when necessary, points Electron at that exact binary, and gives the core an isolated Zero3 Codex home. Hermes' backend may still boot only so unported Hermes UI can render; new Zero3 runtime capabilities must use the `zero3Codex` transport instead.

## Notices

- Zero3 Pilot is an independent, unofficial project. It is **not** an OpenAI product.
- Codex is a project/trademark of OpenAI; Zero3's core is based on the open-source Codex repository pinned under `upstream/codex`.
- Hermes Agent UI/UX code and DeepSeek-Harness are governed by their respective upstream licenses.
- Every third-party dependency remains subject to its own license; see [`docs/UPSTREAM.md`](docs/UPSTREAM.md) and `CONTRIBUTING.md` before importing upstream code.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

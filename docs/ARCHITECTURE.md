# Architecture (Phase 1)

Zero3 Pilot is a personal computer agent platform built on the open-source
Codex runtime — not "a Codex fork with some extra tools." See
[`docs/UPSTREAM.md`](UPSTREAM.md) for how it stays syncable with
`openai/codex`.

```
zero3-pilot/
├─ upstream/codex/      # git submodule, pinned to openai/codex — untouched
├─ crates/               # Rust workspace: the actual extension code
│  ├─ zero3-core/        # event log, job, subagent, plugin, permission seams
│  ├─ zero3-providers/   # ComputerProvider / BrowserProvider traits + stubs
│  ├─ zero3-scheduler/   # job queue (in-memory placeholder)
│  └─ zero3-memory/      # MemoryStore trait (placeholder)
├─ apps/
│  ├─ web/               # control server; ships GET /health
│  └─ desktop/           # desktop shell — not started
├─ zero3/                # conceptual module map -> crate locations (README)
├─ mcp/                  # Zero3's own MCP servers (none yet)
├─ skills/                # packaged task instructions (none yet)
├─ scripts/               # dev tooling (dev-check.sh mirrors CI)
├─ deployment/            # systemd/nginx templates + atomic deploy.sh (not wired to a host yet)
└─ docs/
```

## Provider model

`ComputerProvider` and `BrowserProvider` (in `crates/zero3-providers`) are
traits, not concrete backends. Phase 1 ships only an `Unimplemented*`
placeholder for each so the workspace compiles and the seam is real before
any backend is wired in.

Planned first backend for Computer Use: integrate with
[`iFurySt/open-codex-computer-use`](https://github.com/iFurySt/open-codex-computer-use)
rather than reimplementing Windows UI Automation from scratch — it already
has a Go runtime + PowerShell UIA bridge for Windows and MCP wiring for
Codex/Claude/Hermes. The trait boundary means it can later be swapped for a
native `WindowsUiaProvider` or a vision-model fallback without touching
callers.

```
Codex
  ↓ MCP / plugin
Open Computer Use   <-- crates/zero3-providers::ComputerProvider impl (planned)
  ↓
Windows UI Automation
```

## Permission model

`crates/zero3-core::permission` defines four levels — `ReadOnly`,
`Standard`, `Elevated`, `FullControl` — and a `PolicyEngine` trait every
provider must route side-effecting actions through
(`DefaultPolicy`: allow if granted ≥ required, else require approval if
reversible, else deny). No provider is permitted to self-approve; this is
the seam that later becomes the "统一 approval / policy 层" from the project
brief.

## What's a placeholder vs. real in Phase 1

| Piece | Phase 1 state |
|---|---|
| Event schema, job/subagent/plugin traits, permission model | Real (compiles, has a test) |
| Scheduler | Real in-memory queue, no persistence, no cron |
| Memory | Trait only, no backend |
| Computer / Browser providers | Trait + `Unimplemented*` stub only |
| `apps/web` `/health` | Real, used by deployment verification once a host exists |
| `apps/desktop` | Not started |
| `mcp/`, `skills/` | Empty, directories reserved |
| Deployment to a real host | Deliberately deferred — see `docs/DEPLOYMENT.md` |

## Ideas absorbed from prior art (not yet implemented)

- **DeepSeek Harness**: capability-seam plugin lifecycle, event log,
  background jobs, subagent provider, profiles — re-expressed as Rust
  traits in `zero3-core` rather than embedding its Node/Cordis runtime.
- **xCodex**: hooks, background terminals, subagent roadmap, MCP loading —
  reference for how `mcp/` and a future `hooks/` should be shaped.
- **OpenCodex** (verify license before reusing any code — flagged AGPL,
  unconfirmed): app server / web gateway / desktop shell / remote access
  layering informs `apps/web` + `apps/desktop` split.
- **iPolloWork**: multi-engine workspace, unified plugin/skill/scheduler
  boundaries — informs keeping `zero3-scheduler` and plugin loading decoupled
  from any one backend (Codex/DSH/Claude/Hermes).

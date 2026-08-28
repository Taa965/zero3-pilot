# Architecture (Phase 1 + Phase 2 in progress)

Zero3 Pilot is a personal computer agent platform built on the open-source
Codex runtime — not "a Codex fork with some extra tools." See
[`docs/UPSTREAM.md`](UPSTREAM.md) for how it stays syncable with
`openai/codex`.

```
zero3-pilot/
├─ upstream/codex/      # git submodule, pinned to openai/codex — untouched
├─ crates/               # Rust workspace: the actual extension code
│  ├─ zero3-core/        # event schema, job/subagent/plugin traits, permission seam
│  ├─ zero3-store/       # Event Store v1: append-only JSONL, replay, session/job correlation
│  ├─ zero3-scheduler/   # Job Manager v1: queued/running/succeeded/failed/cancelled
│  ├─ zero3-providers/   # ProviderRegistry + ComputerProvider/BrowserProvider + OpenComputerUseAdapter
│  ├─ zero3-subagents/   # SubagentRegistry over Codex/Claude/Hermes (all placeholder workers so far)
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

`ComputerProvider` and `BrowserProvider` (in `crates/zero3-providers`) both
extend a shared `Provider` supertrait (`name`, `capabilities`,
`health_check`), so `ProviderRegistry<T>` works identically for either
kind: register, list, `select(capability)` (first match by name, `None` if
nobody qualifies), `health_check`/`health_check_all`. Each trait still has
its own `Unimplemented*` placeholder that fails loudly (never a silent
`Ok`) so the seam is exercised before a real backend is registered.

First real Computer Use backend: `OpenComputerUseAdapter`, integrating with
[`iFurySt/open-codex-computer-use`](https://github.com/iFurySt/open-codex-computer-use)
rather than reimplementing Windows UI Automation from scratch. It speaks a
minimal line-delimited JSON protocol over a configured child process's
stdio (one `ComputerAction` in, one `ComputerActionResult` out), so it
already works end-to-end against a test double
(`src/bin/fake_ocu.rs`/`fake_ocu_hang.rs`, exercised in
`tests/open_computer_use.rs`) and just needs the real OCU binary's path
once it's installed — no code change. `health_check` reuses the same
`execute` path (a `Screenshot` call) rather than a separate contract. A
timeout (`with_timeout`, default 10s) plus `kill_on_drop` on the child
process guarantee a hung backend fails the call instead of leaking a
process or blocking forever.

```
Codex
  ↓ MCP / plugin
OpenComputerUseAdapter   <-- crates/zero3-providers::ComputerProvider impl
  ↓ line-delimited JSON over stdio
Open Computer Use (iFurySt) binary
  ↓
Windows UI Automation
```

Still to come: a native `WindowsUiaProvider` and a vision-model fallback
provider, registered alongside `OpenComputerUseAdapter` in the same
registry so callers can `select()` by capability without caring which one
answers.

## Event Store + Job Manager

`zero3-store::EventStore` is the append-only, persistent, replayable log:
every write goes to the end of a JSONL file and is `fsync`'d before the
call returns, so a crash can only ever lose the last unflushed record. A
fresh `EventStore::open` on the same path sees everything a previous
process wrote — `replay()`, `replay_session(id)`, and `replay_job(id)`
reconstruct history in original order.

`zero3-scheduler::JobManager` is the state machine on top of it:
`queued -> running -> {succeeded, failed}`, or `{queued, running} ->
cancelled`. Every transition is recorded through an injected
`Arc<dyn EventLog>` (normally an `EventStore`) *before* the in-memory
status changes, so the durable log and the in-memory view can't drift out
of sync on a partial failure. An invalid transition (e.g. cancelling a job
that already succeeded) is rejected with `JobManagerError::InvalidTransition`
rather than silently accepted — see
`crates/zero3-scheduler/src/lib.rs`'s `cannot_cancel_a_terminal_job` test.

`JobManager` v1 does not yet rebuild its in-memory index from
`EventStore::replay` on startup — that boundary is intentional and
documented by `event_store_integration.rs`'s
`job_history_is_durable_across_a_restart` test (the *log* survives a
restart; the *live* `JobManager` doesn't yet reconstruct itself from it).
That's the natural next increment once something needs it.

## Subagent registry

`zero3-subagents::SubagentRegistry` registers `Arc<dyn SubagentWorker>` by
`worker.name()` and dispatches by name (`registry.dispatch("codex",
task)`), so a caller never depends on which concrete backend runs a task.
`CodexWorker`/`ClaudeWorker`/`HermesWorker` are registered under the
contract today as `Unimplemented`-style placeholders (return a clear "not
wired up" error, never a silent no-op) — the contract is uniform now, the
backends land later.

## Permission model

`crates/zero3-core::permission` defines four levels — `ReadOnly`,
`Standard`, `Elevated`, `FullControl` — and a `PolicyEngine` trait every
provider must route side-effecting actions through
(`DefaultPolicy`: allow if granted ≥ required, else require approval if
reversible, else deny). No provider is permitted to self-approve; this is
the seam that later becomes the "统一 approval / policy 层" from the project
brief.

## What's a placeholder vs. real

| Piece | State |
|---|---|
| Event schema, job/subagent/plugin traits, permission model | Real, tested (incl. security-boundary tests for permission escalation and job-state rejection) |
| Event Store | Real: append-only JSONL, `fsync`'d, replay + session/job filtering, survives a restart |
| Job Manager | Real: full queued/running/succeeded/failed/cancelled state machine, event-logged; does not yet rebuild its index from replay on startup |
| Provider Registry | Real: register/list/select-by-capability/health-check for any `Provider` |
| Computer provider | `OpenComputerUseAdapter` real (subprocess protocol, tested against a fake binary); real OCU binary integration and `WindowsUiaProvider`/vision fallback not yet built |
| Browser provider | Trait + `Unimplemented*` stub only |
| Subagent registry | Real (register/list/dispatch by name); Codex/Claude/Hermes workers are placeholders |
| Memory | Trait only, no backend |
| `apps/web` `/health` | Real, verified by deployment (exact-SHA match, not just 200) |
| `apps/desktop` | Not started |
| `mcp/`, `skills/` | Empty, directories reserved |
| Deployment | Live on the shared AWS Lightsail host, isolated as `zero3pilot` — see `docs/DEPLOYMENT.md` |

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

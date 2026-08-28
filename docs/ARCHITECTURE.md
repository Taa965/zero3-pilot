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
rather than reimplementing Windows UI Automation from scratch. **Verified
against upstream source, not assumed** (see
`crates/zero3-providers/src/open_computer_use.rs`'s module docs for the
exact files checked): every platform runtime is invoked as `<binary> mcp`
and speaks **standard MCP over stdio** — JSON-RPC 2.0, one message per
line, `initialize` -> `notifications/initialized` -> `tools/list` /
`tools/call`. An earlier version of this adapter assumed a custom
line-delimited action/result protocol instead; that was wrong and has
been replaced. The real tool surface requires an `app` argument (app name
or bundle id) on every action-performing tool, which is why
`ComputerAction`'s variants all carry `app: String` now.

Because a JSON-RPC session is stateful (the handshake happens once), the
adapter keeps a **persistent child process** across calls — spawned
lazily, matched request/response by JSON-RPC `id`, and torn down cleanly
by `shutdown()` (closes stdin, waits briefly, force-kills as a fallback —
`Child::wait()` on Windows was observed *not* reacting promptly to a
closed stdin pipe even though the same binary exits in ~200ms given the
same EOF over a plain shell pipe, hence the short bounded grace period
rather than trusting a graceful exit indefinitely) or `kill_on_drop` if
the adapter itself is dropped. Tested end-to-end against a compiled
protocol-compliant test double (`src/bin/fake_ocu.rs`/`fake_ocu_hang.rs`,
exercised in `tests/open_computer_use.rs`): process starts, handshake
succeeds, capabilities enumerate via a real `tools/list` round-trip, each
`ComputerAction` maps to the correct real tool + arguments, shutdown is
clean, and a hung backend times out rather than blocking forever.

```
Codex
  ↓ MCP / plugin
OpenComputerUseAdapter   <-- crates/zero3-providers::ComputerProvider impl
  ↓ MCP over stdio (JSON-RPC 2.0)
open-computer-use <binary> mcp
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
cancelled`. **Durable-first, enforced under one lock hold**: every
mutating call (`create`/`start`/`complete`/`fail`/`cancel`) validates the
transition, appends the event, and *only after `EventLog::append`
returns `Ok`* mutates the in-memory `JobRecord` — all under the same
`jobs` mutex acquisition, so there's no window where a concurrent reader
could observe a state change that later turns out not to have been
logged. If the log write fails, `status`/`output`/`error`/`updated_at`
are left exactly as they were; see the `*_does_not_advance_*_when_the_log_write_fails`
failure-injection tests (`crates/zero3-scheduler/src/lib.rs`) that
inject a log that always errors and assert nothing in the record moved.
An invalid transition (e.g. cancelling a job that already succeeded) is
rejected with `JobManagerError::InvalidTransition` rather than silently
accepted — see the `cannot_cancel_a_terminal_job` test.

`EventKind::JobQueued` carries `kind`/`payload`, and `JobCompleted`
carries `output`, so the event stream is a complete source of truth, not
just a count of transitions. `created_at`/`updated_at` are copied from
each event's own `Event.at`, not a second independent `Utc::now()` call,
so a record built live and one rebuilt from the log agree to the
nanosecond rather than merely being close (a real bug caught by a
failure-injection test during the first hardening pass).

**Recovery is strict by default, and "strict" means semantic, not just
physical.** `JobManager::from_events`/`recover` replay every event through
the exact same state-machine rules the live methods enforce — an orphan
transition (no prior `JobQueued`), a duplicate `JobQueued`, or an event
illegal for the job's current status (e.g. `JobCompleted` without a prior
`JobStarted`, `JobCancelled` from a terminal state) is
`Err(JobManagerError::CorruptHistory(..))`, never silently skipped or
ignored — see `crates/zero3-scheduler/src/lib.rs`'s
`*_is_corrupt_history` tests. When the log genuinely is intact,
`from_events`/`recover` rebuild every field of every job —
`id`/`kind`/`payload`/`status`/`output`/`error`/`session_id`/
`created_at`/`updated_at` — purely from it;
`crates/zero3-scheduler/tests/event_store_integration.rs` proves this
against a real `EventStore` file: manager A creates jobs across every
terminal outcome, is dropped, and manager B recovers from the reopened
file with every `JobRecord` field matching manager A's original.

The event log distinguishes a physically crash-torn tail from real
corruption, and the distinction is **physical, not positional**:
`EventStore::replay_recoverable()` only treats the very last record as a
possible crash tail when the *file itself* doesn't end in `\n` — a
newline-terminated last line that fails to parse is a complete write of
bad content, not a crash tail, and is still fatal (an earlier version of
this got that wrong, treating any invalid last non-empty line as
salvageable regardless of termination; fixed and covered by
`recoverable_replay_treats_a_terminated_invalid_last_line_as_fatal_not_a_tail`).
Corruption anywhere before the last line is always fatal in both
`replay()` and `replay_recoverable()`; nothing is silently skipped.

That tolerance is wired into `JobManager` as an explicit opt-in, never a
default: `RecoveryMode::Strict` (what plain `recover()` uses) rejects any
log that isn't physically intact to the last byte;
`RecoveryMode::RecoverCrashTail`
(`JobManager::recover_with_mode(log, RecoveryMode::RecoverCrashTail)`)
tolerates a physically torn tail and recovers everything before it — but
always returns the `Option<TruncatedTail>` diagnostic alongside the
manager, and still runs the exact same semantic state-machine validation
described above (a physically-salvageable log with a semantically illegal
prefix is still rejected).
`crash_tail_recovery_salvages_durable_jobs_and_reports_exactly_one_torn_tail`
exercises this end to end against a real `EventStore` file: durable jobs
survive a simulated crash mid-write, strict recovery rejects the file
outright, and crash-tail recovery salvages every durable job
field-for-field while surfacing exactly one tail diagnostic.

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
| Job Manager | Real: full state machine, durable-first (failure-injection tested), strict-by-default recovery with an explicit crash-tail opt-in (`RecoveryMode`) — semantic corruption in the log is always rejected, never salvaged silently |
| Provider Registry | Real: register/list/select-by-capability/health-check for any `Provider` |
| Computer provider | `OpenComputerUseAdapter` real, verified-real MCP/JSON-RPC protocol (not assumed — checked against upstream source), tested against a protocol-compliant fake binary; a genuine real-binary smoke test and `WindowsUiaProvider`/vision fallback not yet built |
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

# Zero3 Pilot Architecture

Zero3 Pilot is a local-first personal computer agent built around the upstream open-source Codex runtime. Upstream Codex stays pinned and untouched under `upstream/codex`; Zero3 Pilot adds its own provider, persistence, scheduler, subagent, memory, local Node, desktop, and deployment layers around it.

## Product shape

```text
Windows Desktop (zero3-pilot.exe)
        |
        | localhost / native WebView2
        v
Local Pilot Node (zero3-pilot-node.exe, 127.0.0.1:8790)
        |
        +-- JobManager + append-only EventStore
        +-- PersistentScheduler (SQLite)
        +-- Personal/Operational Memory (SQLite)
        +-- Codex / Claude / Hermes workers
        +-- BrowserProvider -> Chromium CDP
        +-- ComputerProvider -> Open Computer Use MCP -> Windows UIA
        +-- shared approval / permission policy

Cloud control surface (zero3-web)
        |
        +-- deployed independently on AWS
        +-- exact-SHA release health verification
```

The local Node is the runtime authority for personal-computer operations. The desktop shell is a native Windows host for the local UI; it reuses an already healthy Node when one exists, otherwise starts its sibling `zero3-pilot-node.exe` and only owns/terminates that child.

## Repository layout

```text
zero3-pilot/
├─ upstream/codex/
│  └─ pinned upstream openai/codex submodule; Zero3 code does not patch it
├─ crates/
│  ├─ zero3-core/
│  │  ├─ event / job / subagent / plugin contracts
│  │  └─ shared permission and approval seam
│  ├─ zero3-store/
│  │  └─ fsync'd append-only JSONL event store with strict/recoverable replay
│  ├─ zero3-scheduler/
│  │  ├─ durable-first JobManager state machine
│  │  └─ SQLite persistent schedules
│  ├─ zero3-providers/
│  │  ├─ provider registry
│  │  ├─ real Chromium CDP BrowserProvider
│  │  └─ real Open Computer Use MCP ComputerProvider
│  ├─ zero3-subagents/
│  │  └─ real bounded CLI adapters for Codex / Claude / Hermes
│  └─ zero3-memory/
│     └─ scoped SQLite operational/personal memory with approval gate
├─ apps/
│  ├─ node/
│  │  ├─ loopback-only local runtime API
│  │  └─ integrated local control UI
│  ├─ desktop/
│  │  └─ Windows Tao + Wry/WebView2 shell
│  └─ web/
│     └─ cloud control/health server used by strict deployment verification
├─ deployment/
│  └─ isolated atomic AWS deployment for zero3-web
└─ .github/workflows/
   ├─ ci.yml
   └─ deploy.yml
```

## Runtime invariants

### Event Store and jobs

`zero3-store::EventStore` is append-only JSONL. Durable writes are flushed and synchronized before success is returned. Strict replay rejects malformed history. Recoverable replay only tolerates a physically torn final record and always surfaces a `TruncatedTail` diagnostic.

`zero3-scheduler::JobManager` is durable-first: state transitions are recorded before the in-memory `JobRecord` advances. Replay applies the same legal state transitions as live execution; orphan events, duplicate queue events, and illegal transitions are corruption rather than silently ignored data.

### Persistent scheduler

`PersistentScheduler` stores schedules in SQLite/WAL. It supports one-shot, fixed interval, and daily UTC schedules. Due occurrences enqueue normal durable jobs. The stable `(schedule_id, scheduled_for)` pair is carried in the payload so downstream execution can deduplicate at-least-once delivery.

### Memory

`SqliteMemoryStore` persists scoped operational and personal records. Operational memory may be written by the runtime. Personal memory is rejected at the storage boundary unless the record carries explicit approval. Scopes are global, session, or thread.

## Providers

### Browser

`CdpBrowserProvider` uses `chromiumoxide` and keeps CDP types behind the provider contract. Managed mode launches Chromium with an isolated temporary profile; attach mode connects to an explicitly supplied CDP endpoint and does not kill the user's browser on close.

Supported actions include launch/connect/close, tabs, open/navigate, semantic snapshot/query, click/type/key/scroll/wait, screenshot, and evaluate. Semantic element refs are preferred over coordinate automation. CI runs a real installed Chromium smoke test.

### Computer use

`OpenComputerUseAdapter` integrates the current `open-computer-use` runtime through standard MCP JSON-RPC over stdio. It performs initialize -> initialized -> tools/list / tools/call on a persistent child process and has bounded shutdown/kill fallback.

`ComputerAction` uses the transport contract `{"action": "snake_case", ...}`. `list_apps` and app-state reads are read-only; click/type/key actions are side effects and pass through the shared policy gate. CI installs the real OCU package on Windows, opens real Notepad, performs the MCP handshake, and executes a UIA smoke test.

## Subagents

`SubagentRegistry` dispatches workers by stable name. The concrete workers are thin bounded process adapters and do not embed duplicate agent runtimes:

- Codex: `codex exec --json`
- Claude: `claude -p --output-format json`
- Hermes: `hermes -z`

Each adapter owns cwd/env/timeout/exit-code handling and bounded stdout/stderr capture. Missing executables and non-zero exits fail loudly.

## Local Pilot Node

`apps/node` binds to loopback only (default `127.0.0.1:8790`). It is the local integration point for:

- health/status
- background jobs and results
- Codex/Claude/Hermes submissions
- browser actions
- computer actions
- persistent schedules
- memory CRUD/search

Browser-origin checks block drive-by web pages from issuing localhost mutations. Native/CLI local clients without an Origin header remain supported. Side-effecting browser/computer/subagent/scheduler operations are evaluated by the shared `DefaultPolicy`; a provider cannot self-approve.

The embedded UI exposes runtime status, agents, jobs, browser automation, computer control including `list_apps`, scheduler automation, and scoped memory.

## Windows desktop

`apps/desktop` builds `zero3-pilot.exe` with the Windows GUI subsystem. It creates a Tao window and a real Wry/WebView2 instance pointed at the local Node.

Startup behavior:

1. Probe local Node health.
2. If healthy, reuse it.
3. Otherwise resolve/start sibling `zero3-pilot-node.exe`.
4. Wait for health before creating the UI.
5. On exit, terminate only a Node child the desktop itself started.

CI builds the real Windows Node/Desktop, starts the Node, verifies `/health` and `/api/v1/status`, creates the real WebView2 desktop, waits for the smoke timer to close it, and checks the GUI process exit code.

## Permission model

`zero3-core::permission` defines `ReadOnly < Standard < Elevated < FullControl`. `DefaultPolicy` allows sufficient grants, requires explicit approval for reversible operations above the current grant, and denies under-granted irreversible operations. Providers and the local Node share this seam rather than implementing independent approval rules.

## Cloud deployment boundary

`apps/web` remains a separate server-side control/health surface. It is deployed on the shared AWS host under the dedicated `zero3pilot` service account and isolated filesystem/service paths. It does not grant the local desktop runtime remote shell authority.

Pushes to `main` use one strict workflow chain:

```text
test (fmt + clippy + build + workspace tests)
  -> release build
  -> atomic deploy exact GITHUB_SHA
  -> external localhost health check whose git_sha must equal that SHA
```

A failed upstream job cannot reach deploy. Releases are exact-SHA and rollback-capable.

## CI evidence

PR CI contains four independent gates:

1. Linux `fmt / clippy -D warnings / build / workspace tests`.
2. Real Chromium BrowserProvider smoke.
3. Real Windows Open Computer Use + Notepad/UIA smoke.
4. Windows product smoke: Node build/start/API plus native Wry/WebView2 desktop creation and clean exit.

The purpose of the platform-specific smoke tests is to prevent a cross-platform compile from being mistaken for proof that browser/UI automation or the Windows desktop actually works.

## Upstream policy

Zero3 Pilot absorbs useful architecture ideas from other projects but keeps `openai/codex` upstream clean. New personal-assistant capabilities live in Zero3-owned crates/apps and communicate through explicit seams rather than modifying the Codex source tree or introducing a second agent runtime.

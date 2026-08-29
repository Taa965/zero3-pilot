# Zero3 Pilot Architecture

Zero3 Pilot is a Codex-core desktop application. The non-negotiable role contract lives in [`ARCHITECTURE_CONSTITUTION.md`](ARCHITECTURE_CONSTITUTION.md).

## Target product shape

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

## Runtime authority

`upstream/codex` is the source of truth for the primary agent runtime. Zero3 uses Codex app-server's native Thread / Turn / Item model instead of inventing parallel conversation/job abstractions for the core path.

Relevant Codex primitives include:

- Thread — durable conversation/session identity;
- Turn — one agent execution turn;
- Item — user message, agent output, reasoning, shell command, file edit, tool activity, etc.;
- streaming notifications — including item/turn progress and agent-message deltas;
- server-originated approval/input requests;
- interruption, resume, list and read APIs.

## Upstream roles

```text
upstream/codex/
  CORE — authoritative agent runtime and app-server protocol

upstream/hermes-agent/
  UI SHELL — Electron/React desktop UX source

upstream/deepseek-harness/
  CAPABILITY DONOR — audited source of ideas/implementations to port
```

All three remain pinned for deterministic development, but they are not peers in runtime authority.

## Architecture drift that was retired

The repository still contains buildable code from an earlier shape:

```text
legacy Rust/Wry Desktop or retired Hermes overlays
                    |
             Zero3 Pilot Node
                    |
       +------------+------------+
       |            |            |
 CodexWorker   ClaudeWorker  HermesWorker
       |
 jobs / scheduler / memory / browser / computer
```

That implementation is now **legacy/extension infrastructure**. R0 removed it from the target desktop boot/runtime path and introduced an architecture guard so passing legacy tests cannot redefine the product core.

## Desktop architecture

### R1A transport boundary

```text
Hermes React UI
    |
window.zero3Codex
    |
typed Electron preload IPC
    |
Electron main Zero3CodexAppServer
    |
`codex app-server --stdio`
    |
pinned open-source Codex
```

R1A is implemented by `apps/zero3-desktop/scripts/apply-codex-transport.mjs`.

Electron main owns the Codex child and performs:

1. launch of the explicitly configured pinned Codex binary;
2. `initialize` request and `initialized` notification;
3. JSONL framing and request-id correlation;
4. bounded request timeouts, stdout frames, stderr tail and pending server requests;
5. forwarding Codex notifications to Renderer;
6. forwarding Codex-originated requests without automatically approving them;
7. process cleanup when the desktop quits.

The Renderer is intentionally limited to the following contract:

```text
status
start
thread/start
thread/resume
thread/list
thread/read
turn/start
turn/interrupt
respond to an already-outstanding Codex server request
subscribe to Codex events
```

There is no Renderer-controlled arbitrary `method + params` JSON-RPC tunnel. Adding a new Codex capability requires adding a named typed IPC surface and review.

### R2A primary-chat boundary

The primary visible chat now uses `apps/zero3-desktop/scripts/apply-codex-primary-chat.mjs` to preserve the Hermes-derived UI while changing its runtime contract:

```text
Hermes ChatView / Composer / Sidebar
        |
Zero3 Codex primary-chat adapter
        |
+-------+-------------------------------+
| new/list/resume | send/stop | stream |
| Thread APIs     | Turn APIs | Items  |
+-------+-------------------------------+
        |
window.zero3Codex
        |
codex app-server
```

The R2A mapping is:

- new main chat -> `thread/start`;
- sidebar recents -> `thread/list`;
- resume/history -> `thread/resume` + `thread/read(includeTurns=true)`;
- text send -> `turn/start`;
- assistant stream -> `item/started`, `item/agentMessage/delta`, `item/completed`;
- settle -> `turn/completed`;
- Stop/Esc -> `turn/interrupt`;
- title/status -> Codex thread notifications.

Codex Threads/Turns/Items are projected into the Hermes `SessionInfo` and `ChatMessage` stores strictly as presentation adapters. Those stores do not define runtime authority on the migrated path.

R2A deliberately uses `approvalPolicy=never` with `sandbox=read-only`. This is a temporary safety mode: native Codex approval/input UI is not mapped yet, so the product must neither hang on an invisible approval request nor gain workspace-write capability without a visible decision surface. Unexpected server-originated requests are denied fail-closed.

R2A does not silently route missing operations back into Hermes Runtime. Attachments, edit/rewind/regenerate/branch, native archive/delete, steering, rich tool/file/reasoning rendering, approval/input UI and multi-pane Codex parity remain explicit migration work. See [`CODEX_PRIMARY_CHAT_R2.md`](CODEX_PRIMARY_CHAT_R2.md).

### Core binary ownership

For development, `apps/zero3-desktop/scripts/run.mjs` builds the `codex` executable from the exact pinned `upstream/codex/codex-rs` source when it is missing and passes its path as `ZERO3_CODEX_BIN`.

This distinction is important:

- the pinned open-source Codex build is the **Zero3 core**;
- host-installed Codex/Claude/Hermes applications are **external collaborators** and must not silently replace that path.

Zero3 uses a dedicated Codex state boundary (`ZERO3_CODEX_HOME`, defaulting to the Zero3 application data area) so primary core state is explicit rather than accidentally owned by another installed application.

### Temporary Hermes compatibility state

The Hermes-derived shell still has unported surfaces whose boot/data dependencies assume Hermes' backend. That backend may still boot during `npm run dev` only as compatibility scaffolding.

Rules during the remaining migration:

- main chat conversation semantics are Codex-owned;
- no new Zero3 runtime feature may be added to Hermes runtime;
- no desktop product feature may use Zero3 Node as primary state/runtime authority;
- old Node bridge overlay files remain unapplied;
- new core work goes through `window.zero3Codex`;
- removal of the Hermes compatibility backend happens after all target shell dependencies are ported, not by weakening the Codex-core invariant.

## Multi-Agent Collaboration

The existing `zero3-subagents` crate and its Codex/Claude/Hermes CLI workers are classified as External Agent Collaboration infrastructure.

Their eventual responsibility is to support:

- discover external installed agents;
- inspect running/unfinished work;
- continue an existing external task;
- send instructions or review requests;
- observe execution and collect output;
- hand off work between external agents;
- take over unfinished work into Zero3's Codex core.

Their current `Subagent*` names remain temporarily for source compatibility.

## Zero3 extensions

Existing Rust components remain useful, but should attach to Codex rather than replace it:

- scheduler -> Codex tool/MCP/automation extension;
- memory -> Codex/Zero3 project-memory extension;
- BrowserProvider -> Codex tool/MCP provider;
- ComputerProvider -> Codex tool/MCP provider;
- EventStore/job durability -> extension workflow infrastructure, not primary conversation state;
- Weixin channel -> user/channel ingress into Codex core.

These components may remain independently testable while migration occurs.

## DeepSeek-Harness integration

DeepSeek-Harness stays pinned as an audit/reference source. A capability enters Zero3 only after deciding where it belongs:

1. Codex core patch when it fundamentally improves the Agent Kernel;
2. Zero3 tool/MCP/hook/skill when it is an extension;
3. desktop UI adapter when it is presentation/interaction behavior.

Do not keep DeepSeek-Harness as a default parallel agent runtime merely to avoid porting the capability.

## Legacy components

### `apps/node`

Legacy/extension host. It currently exposes jobs, schedules, memory, browser/computer and external-agent dispatch. It is no longer the target desktop runtime authority.

### `apps/desktop`

Legacy Rust/Tao/Wry desktop. It remains only for rollback/installer history while the Hermes-derived Electron shell migration completes. Do not add new product UI here.

### `crates/zero3-subagents`

Legacy naming for External Agent Collaboration adapters. Codex/Claude/Hermes are peers only inside this optional collaboration module, not at the product-core level.

## Migration phases

### R0 — complete: architecture reset

- codified role hierarchy;
- stopped applying Zero3 Node chat/memory/schedule/browser desktop overlays;
- stopped target desktop from auto-starting Zero3 Node;
- added CI architecture guard;
- preserved buildable legacy code for controlled migration.

### R1A — complete: Codex app-server transport

- pinned Codex binary resolution/build;
- app-server lifecycle ownership;
- initialize/initialized JSONL handshake;
- typed request/response correlation;
- bounded notification/server-request forwarding;
- typed Thread / Turn / interrupt Renderer API;
- no arbitrary JSON-RPC proxy.

### R2A — current: primary chat cut

- Hermes main session UI -> Codex Thread;
- composer -> `turn/start`;
- streaming assistant UI -> Codex Item notifications/deltas;
- Stop -> `turn/interrupt`;
- durable session restore -> `thread/list/read/resume`;
- compatibility types remain presentation-only;
- primary chat is read-only until approval UI lands.

### R2B / R3 — feature parity and execution UX

- structured attachments -> Codex UserInput;
- reasoning / shell / file / MCP / dynamic-tool Item rendering;
- native approval and elicitation presentation;
- workspace-write only after approval routing is live;
- native thread archive/delete/branch/edit/rollback/steer;
- projects/worktrees and token/cost/status presentation;
- multi-pane/session-tile Codex parity.

### R4 — External Agent Collaboration

- formal `ExternalAgent` contract;
- inspect/continue/handoff/takeover;
- adapters for installed Codex, Claude, Hermes and future agents.

### R5 — migrate Zero3 extensions

- scheduler, memory, browser/computer, messaging and workflows attach through Codex-native extension seams.

### R6 — DeepSeek capability absorption

- audit, port, benchmark and integrate selected capabilities.

## CI invariant

`node scripts/check-architecture.mjs` is the first architecture gate. The Windows target-shell gate then applies the exact pinned Hermes overlay and TypeScript-checks/builds the resulting Electron application.

The dedicated Codex Core Smoke builds the exact pinned Codex source and exercises real JSONL protocol flow through `initialize`, `thread/list`, `thread/start` and `turn/start`, including the pinned `text_elements` UserInput field. Credential-free CI may tolerate a model/auth runtime failure only after request deserialization succeeds; invalid-params/unknown-field failures block the release.

CI and the architecture guard require the typed `zero3Codex` boundary, reject generic Codex Renderer proxies, reject legacy Zero3 Node routing from primary chat, and keep the retired Node desktop bridge out of the target shell.

Platform smoke tests for legacy/extension components may continue until each path is replaced. Passing a legacy smoke test is evidence that a compatibility component still works; it is not evidence that the component defines the target architecture.

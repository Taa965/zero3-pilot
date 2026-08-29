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

### Runtime authority

`upstream/codex` is the source of truth for the primary agent runtime. Zero3 should use Codex app-server's native protocol instead of inventing parallel conversation/job abstractions for the core path.

Relevant Codex primitives include:

- Thread — durable conversation/session identity
- Turn — one agent execution turn
- Item — user message, agent output, reasoning, shell command, file edit, tool activity, etc.
- streaming notifications — `item/started`, `item/completed`, `item/agentMessage/delta`, turn notifications and tool progress
- approval and interruption APIs

The Zero3 desktop adapter should progressively map Hermes UI concepts onto these primitives.

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

## Current code audit

The repository currently contains an older architecture whose shape is:

```text
legacy Rust/Wry Desktop or Hermes UI overlays
                    |
             Zero3 Pilot Node
                    |
       +------------+------------+
       |            |            |
 CodexWorker   ClaudeWorker  HermesWorker
       |
 jobs / scheduler / memory / browser / computer
```

This implementation is real and CI-tested, but its **role classification is now legacy/extension infrastructure**. It must not continue evolving into the main Agent Kernel.

The most important drift points found in the 2026-08-29 reset audit were:

1. `README.md` explicitly said the product was *not* a Codex fork/secondary development and described Zero3-owned contracts as the runtime center.
2. This architecture document called `zero3-pilot-node` the runtime authority.
3. `apps/node` registered Codex, Claude and Hermes symmetrically and owned primary job execution.
4. Hermes Desktop overlays routed chat, memory, schedules and browser controls to Zero3 Node.
5. The desktop dev launcher automatically built/started Zero3 Node and treated Hermes as one worker behind it.
6. CI asserted the existence of the Zero3 Node desktop bridge, accidentally making the drift a release requirement.

R0 removes those assumptions from the target desktop path and adds a mechanical architecture guard.

## Desktop architecture

### Target

```text
Hermes React UI
    |
Electron preload / typed Zero3 adapter
    |
Electron main Codex client
    |
`codex app-server --stdio`
    |
open-source Codex
```

The app-server protocol is bidirectional JSONL over stdio. A Zero3 client must initialize once, then use Codex APIs such as `thread/start`, `thread/resume`, `turn/start`, streaming item notifications and approval/interrupt APIs.

### R0 compatibility state

The pinned Hermes desktop may temporarily start its own Hermes compatibility backend because the upstream UI expects it. In R0 this backend exists only to keep the shell renderable while the Codex transport is implemented.

R0 rules:

- no new Zero3 product feature may be added to Hermes runtime;
- no new desktop product surface may use Zero3 Node as primary state/runtime authority;
- old Node bridge overlay files may remain in the repository for migration archaeology but are not applied by `prepare-upstream.mjs`;
- Zero3 Node is not automatically started by the target desktop launcher.

## Multi-Agent Collaboration

The existing `zero3-subagents` crate and its Codex/Claude/Hermes CLI workers are being reclassified as External Agent Collaboration infrastructure.

Their purpose is not primary execution. Their eventual responsibility is to support actions such as:

- discover external installed agents;
- inspect running/unfinished work;
- continue an existing external task;
- send instructions or review requests;
- observe execution and collect output;
- hand off work between external agents;
- take over unfinished work into Zero3's Codex core.

The current `SubagentWorker` names remain temporarily for compatibility; semantic migration and API renaming happen after the Codex core transport is established.

## Zero3 extensions

Existing Rust components remain valuable, but should attach to Codex rather than replace it:

- scheduler -> Codex tool/MCP/automation extension
- memory -> Codex/Zero3 project-memory extension
- BrowserProvider -> Codex tool/MCP provider
- ComputerProvider -> Codex tool/MCP provider
- EventStore / job durability -> extension workflow infrastructure, not primary conversation state
- Weixin channel -> user/channel ingress into Codex core

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

Legacy naming for the External Agent Collaboration adapters. Codex/Claude/Hermes are peers only inside this optional collaboration module, not at the product-core level.

## Migration phases

### R0 — architecture reset

- codify the role hierarchy;
- stop applying Zero3 Node chat/memory/schedule/browser desktop overlays;
- stop target desktop from auto-starting Zero3 Node;
- add CI architecture guard;
- preserve buildable legacy code for controlled migration.

### R1 — Codex app-server client

- spawn/resolve pinned Codex app-server;
- initialize JSONL transport;
- typed request/response correlation;
- notification stream and lifecycle supervision;
- expose narrow Electron preload API.

### R2 — primary chat

- Hermes session UI -> Codex Thread;
- composer -> `turn/start`;
- streaming assistant UI -> Item notifications/deltas;
- Stop -> `turn/interrupt`;
- durable session restore -> `thread/list/read/resume`.

### R3 — execution UX

- shell/file/tool items;
- approval requests;
- MCP UI;
- projects and worktrees;
- token/cost/status presentation.

### R4 — External Agent Collaboration

- formal `ExternalAgent` contract;
- inspect/continue/handoff/takeover;
- adapters for installed Codex, Claude, Hermes and future agents.

### R5 — migrate Zero3 extensions

- scheduler, memory, browser/computer, messaging and workflows attach through Codex-native extension seams.

### R6 — DeepSeek capability absorption

- audit, port, benchmark and integrate selected capabilities.

## CI invariant

`node scripts/check-architecture.mjs` is the first architecture gate. It intentionally fails when the target Hermes desktop preparation or launcher reintroduces Zero3 Node as primary desktop core.

Platform smoke tests for legacy/extension components may continue until each path is replaced. Passing a legacy smoke test is evidence that a compatibility component still works; it is not evidence that the component defines the target architecture.

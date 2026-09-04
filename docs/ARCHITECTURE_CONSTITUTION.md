# Zero3 Architecture Constitution

This document is the highest-level architecture contract for Zero3 Pilot. Feature plans, PRs and runtime changes must conform to it. If another document conflicts with this file, this file wins until the conflict is explicitly resolved.

## 1. Core identity

Zero3 Pilot is a deep secondary development of OpenAI's open-source Codex project.

**Open-source Codex is the single authoritative Agent Kernel.**

The following capabilities belong to the Codex core path unless there is a documented technical reason to extend them:

- Thread / session lifecycle
- Turn lifecycle and streaming events
- Context and conversation history
- Model invocation and primary agent loop
- Tool execution
- Shell and file operations
- MCP
- Approval / permission interaction
- Git / worktree integration
- Primary execution state and interruption

Zero3 must not create a second general-purpose Agent Kernel that competes with these responsibilities.

## 2. Product UI ownership

**Zero3 Pilot owns and maintains exactly one product Renderer: the Zero3 three-column desktop UI.**

The authoritative renderer source lives under:

```text
apps/zero3-desktop/renderer-v2/
```

The product must not require parallel maintenance of a Codex UI, Hermes UI, or provider-specific desktop shell.

### Codex UI role

Open-source Codex remains the Agent Kernel/runtime. Its own UI is **not** a Zero3 product surface and must not be bundled or mounted as a parallel desktop UI.

Zero3 may reuse Codex protocols, app-server, CLI/runtime code and deliberate Codex core patches, but product UI work belongs in the Zero3 Renderer.

### Hermes role

Hermes Agent is now a **temporary Electron/Vite host and historical UI/UX donor**, not a maintained Zero3 product UI.

Zero3 may temporarily reuse reviewed host infrastructure such as:

- Electron main/preload foundations
- native window behavior
- packaging/build plumbing
- already-integrated purpose-specific Runtime bridges

Hermes React product UI is retired: it must not be mounted by the target app and must not receive new Zero3 product UI features.

Hermes runtime, `hermes serve`, Hermes agent loop, Hermes model execution and Hermes tool runtime are not target Zero3 core dependencies. Any remaining compatibility dependency must be removed rather than expanded.

The end state is a Zero3-owned Electron host plus the same Zero3-owned three-column Renderer; extracting the host must not require another product UI rewrite.

## 3. DeepSeek-Harness role

DeepSeek-Harness is a **capability donor**, not a parallel runtime.

The preferred integration pattern is:

```text
DeepSeek-Harness idea / implementation
            |
        audit + isolate
            |
      re-express / port
            |
  Codex core or Zero3 extension
```

A long-lived `Zero3 -> DeepSeek-Harness runtime -> execute` architecture requires an explicit exception review and must not become the default product path.

## 4. External Agent Collaboration

Installed or separately running AI applications are external collaborators.

Examples:

- official Codex application / installed Codex client
- Claude application / Claude Code client
- Hermes application / CLI
- future Cursor, VS Code agent, or other local agents

These belong to the **Multi-Agent Collaboration** module.

Zero3 may discover an external agent, inspect sessions/active work, send an instruction, continue or interrupt work when supported, observe progress, collect results, request review, hand work to another agent, or take unfinished work over into the Zero3/Codex core.

External agents are workers under Zero3 orchestration. They do not define Zero3's primary session model, tool model, context, Renderer, or runtime authority.

A conceptual adapter should converge on capabilities such as:

```text
ExternalAgent
├─ discover()
├─ inspect()
├─ getSessions()
├─ getActiveWork()
├─ sendInstruction()
├─ continueTask()
├─ interrupt()
├─ observe()
├─ collectResult()
├─ handoff()
└─ takeover()
```

## 5. Zero3 extension layer

Zero3-specific product capabilities should extend Codex instead of replacing it.

Examples:

- scheduler / automation
- project-level memory
- self-media workflows
- Author Runtime
- video-generation pipelines
- review/QA systems
- multi-agent orchestration
- browser/computer-use enhancements
- DeepSeek-derived capabilities

Preferred attachment points are Codex tools, MCP, app-server extensions, hooks, skills, configuration, or deliberately maintained Zero3 patches on the Codex core.

## 6. Desktop transport invariant

The target desktop path is:

```text
Zero3 three-column Renderer
             |
     purpose-specific preload APIs
             |
      +------+-------------------+
      |                          |
window.zero3Codex       GPT/Gemini Web providers
      |                          |
Codex app-server           WebContentsView
      |
open-source Codex
```

During the host-extraction transition, the Electron/Vite process may still come from the pinned Hermes package, but the mounted product Renderer must remain Zero3-owned.

The following must not become target primary paths:

```text
Hermes React UI -> Zero3/Hermes runtime -> execute
Codex OSS UI    -> Zero3 product workflow
Zero3 UI        -> second generic Agent Kernel -> Codex
```

Renderer-to-main access must remain purpose-specific. Do not expose an arbitrary JSON-RPC proxy, unrestricted Electron IPC bridge, or generic shell command bridge to the Renderer.

## 7. Zero3 Node status

The existing `apps/node` implementation is reclassified as **legacy / extension-host infrastructure**.

It may temporarily host existing scheduler, memory, browser/computer or compatibility APIs while those capabilities are migrated. It is not allowed to be described or extended as Zero3's general runtime authority, primary chat backend, or Agent Kernel.

## 8. Pull-request gate

A PR is an architecture regression if it does any of the following without an explicit constitution amendment:

- makes Zero3 Node the primary desktop chat/runtime authority;
- routes primary conversation through `CodexWorker`, `ClaudeWorker` or `HermesWorker` instead of Codex app-server;
- introduces a new generic agent loop outside Codex;
- makes Hermes runtime a required Zero3 product core;
- makes DeepSeek-Harness a parallel default runtime;
- treats official Codex/Claude/Hermes applications as Zero3's own core execution engine rather than external collaborators;
- adds or restores a second product Renderer alongside `renderer-v2`;
- adds new Zero3 product UI into Hermes React UI or Codex OSS UI;
- makes a feature require synchronized implementation in Zero3 UI plus Hermes/Codex UI;
- reintroduces hard-coded demo sessions, fake tool execution, or fake runtime state as the product path.

CI runs `scripts/check-architecture.mjs` to catch obvious regressions mechanically. Human review remains authoritative for semantic violations.

## 9. Migration priority

1. R0 — freeze the Agent Kernel hierarchy and detach new desktop feature work from Zero3 Node.
2. R1 — introduce a Zero3-owned Codex app-server transport/client and lifecycle.
3. R2 — move the primary chat semantics to Codex Thread / Turn / Item.
4. R3 — map approvals, tools, shell, files, MCP, projects and worktrees to Codex-native semantics.
5. U1 — cut the mounted Renderer over to the Zero3-owned three-column UI and retire Hermes/Codex product UIs.
6. U2 — connect Codex/GPT/Gemini sessions and WebContentsViews to that single Renderer.
7. U3 — extract the reviewed Electron main/preload Runtime from the temporary Hermes package host into a Zero3-owned host.
8. R4 — frame installed AI applications as External Agent Collaboration with handoff/takeover semantics.
9. R5 — migrate scheduler, memory and browser/computer features into Codex-native extension seams.
10. R6 — selectively port DeepSeek-Harness capabilities.

No phase should reverse the role hierarchy or reintroduce multiple maintained product UIs.

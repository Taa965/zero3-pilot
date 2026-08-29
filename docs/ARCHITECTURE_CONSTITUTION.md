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

## 2. Hermes Agent role

Hermes Agent is a **UI/UX donor and desktop shell**, not Zero3's brain.

Zero3 may reuse or adapt:

- Electron shell and native-window behavior
- React desktop layout
- Chat transcript UI
- Streaming response presentation
- Tool-call presentation
- Side previews
- File browser
- Terminal UI
- Projects/session navigation
- Settings, themes, shortcuts and multi-window UX

Hermes runtime, `hermes serve`, Hermes agent loop, Hermes model execution and Hermes tool runtime are not target Zero3 core dependencies.

During migration, a Hermes backend may remain temporarily only when the pinned upstream shell requires it for rendering or compatibility testing. No new Zero3 product capability may depend on that temporary runtime.

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

Zero3 may:

- discover an external agent
- inspect sessions / active work
- observe progress
- send an instruction
- ask it to continue unfinished work
- interrupt it when supported
- collect results
- request review
- hand work to another agent
- take over unfinished work into the Zero3/Codex core

External agents are workers under Zero3 orchestration. They do not define Zero3's session model, tool model, primary context, or runtime authority.

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
Hermes-derived Electron/React UI
             |
      Zero3 UI Adapter
             |
      codex app-server
             |
     open-source Codex
```

The following must not become the target primary path:

```text
Hermes UI -> Zero3 Node -> Codex/Claude/Hermes worker
```

or:

```text
Hermes UI -> Hermes Gateway -> Hermes Runtime -> Zero3
```

Compatibility scaffolding may exist temporarily, but new core features must move the repository toward the first diagram.

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
- adds new Hermes Desktop feature overlays whose product state is owned by Zero3 Node instead of the Codex core path.

CI runs `scripts/check-architecture.mjs` to catch the most obvious regressions mechanically. Human review remains authoritative for semantic violations.

## 9. Migration priority

1. R0 — freeze the architecture and detach new desktop feature work from Zero3 Node.
2. R1 — introduce a Zero3-owned Codex app-server transport/client and lifecycle.
3. R2 — map Hermes chat UI to Codex Thread / Turn / Item streaming.
4. R3 — map approvals, tools, shell, files, MCP, projects and worktrees.
5. R4 — reframe current worker adapters as External Agent Collaboration with handoff/takeover semantics.
6. R5 — migrate scheduler, memory and browser/computer features into Codex-native extension seams.
7. R6 — selectively port DeepSeek-Harness capabilities.

No phase should reverse the role hierarchy defined above.

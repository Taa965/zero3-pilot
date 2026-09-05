# 2026-08-29 Codex-core architecture reset audit

## Requested product

Zero3 Pilot must be:

- a deep secondary development of the open-source OpenAI Codex project;
- Codex as the only primary Agent Kernel/runtime authority;
- Hermes Agent's Electron/React desktop as the UI shell;
- DeepSeek-Harness as a capability donor;
- installed Codex/Claude/Hermes applications as optional external collaborators for multi-agent work, including continuing unfinished work, instruction, review, handoff and takeover.

## Audit conclusion

The repository had drifted away from that definition.

### Critical drift

1. `docs/ARCHITECTURE.md` named `zero3-pilot-node` the local runtime authority.
2. `apps/node` owned primary jobs and registered `CodexWorker`, `ClaudeWorker` and `HermesWorker` symmetrically.
3. `apps/zero3-desktop/scripts/run.mjs` automatically built/started Zero3 Node for the target Hermes-derived desktop.
4. `prepare-upstream.mjs` applied Node-backed desktop overlays for read state, native chat, memory, schedules and browser control.
5. CI asserted that the Hermes-derived desktop contained the Zero3 Node bridge, making the drift a release requirement.
6. Root README described Zero3-owned contracts as the platform center and explicitly said the product was not a Codex fork with extra capabilities.

### Medium drift

1. `zero3-subagents` naming blurred the distinction between Codex core and external agents.
2. The older Rust/Tao/Wry desktop and installer remained prominent in docs despite the Hermes shell being the intended UI direction.
3. Scheduler/memory/browser/computer capabilities were designed as Node-owned product runtime features instead of Codex extensions.

## R0 corrections in this branch

- close obsolete PR #14 that packaged/owned Zero3 Node from Electron;
- add `ARCHITECTURE_CONSTITUTION.md`;
- redefine README and architecture docs around Codex core;
- stop `prepare-upstream.mjs` from applying all Node-backed product bridge overlays;
- stop the target desktop launcher from starting Zero3 Node;
- classify the Hermes backend as temporary UI compatibility scaffolding only;
- reclassify current subagent workers as External Agent Collaboration adapters;
- add an architecture CI guard so Node-backed desktop core work cannot silently return.

## What remains intentionally buildable

R0 does not delete the existing Rust Node, scheduler, memory, browser/computer providers, worker adapters, legacy desktop or their tests. They provide migration evidence and contain useful Zero3 capabilities.

Their role changes immediately:

- Node -> legacy/extension host;
- scheduler/memory/browser/computer -> future Codex extensions;
- worker adapters -> External Agent Collaboration;
- legacy Wry desktop -> rollback/history only.

## Next required implementation

R1 must create the actual Zero3 Codex app-server transport using the pinned Codex source/protocol. Minimum acceptance:

1. resolve/spawn Codex app-server;
2. JSONL stdin/stdout transport;
3. request IDs and response correlation;
4. `initialize` + `initialized` handshake;
5. graceful process supervision/restart diagnostics;
6. typed `thread/start`, `thread/list/read/resume`, `turn/start`, `turn/interrupt` seams;
7. notification event stream for items, deltas, tools and approvals;
8. narrow Electron preload API with no generic process/network proxy.

Only after R1 should the Hermes main chat UI be migrated to Codex Thread/Turn/Item.

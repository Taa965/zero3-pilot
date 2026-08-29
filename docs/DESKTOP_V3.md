# Zero3 Desktop v3 Architecture

## Decision

Zero3 Pilot will own its desktop product surface. The UI foundation is the open-source Hermes Desktop Electron/React application, not the proprietary Codex Desktop application and not the Codex Ratatui TUI.

Codex remains an execution engine through its open-source CLI / `app-server` source. DeepSeek Harness is pinned as an additional engine/plugin/UI architecture source. Zero3 Pilot Node remains the durable local control plane for jobs, scheduling, memory, browser automation, computer control, policy enforcement, and cross-agent orchestration.

## Fixed upstream source versions

The migration branch pins:

```text
openai/codex                  94311d447587411789533c47601fd8bc9d81eb48
NousResearch/hermes-agent     f7c79efbac19ae18e8dee7c79a4e4c0935299b5f
deepseek-ai/deepseek-harness  cd5ef8148158c3a752a658978873241fdf8e2bbc
```

Do not silently float these SHAs. Upstream updates are explicit review events because renderer, transport, permissions, packaging, and plugin contracts can all change.

## Target boundary

```text
Zero3 Desktop
  Hermes-derived Electron main process
  Hermes-derived React renderer
          |
          | Zero3 desktop transport
          v
Zero3 Pilot Node (loopback only)
  jobs / events / scheduler / memory / policy
          |
          +-- Codex app-server adapter
          +-- Claude adapter
          +-- Hermes adapter
          +-- DeepSeek Harness adapter
          +-- Browser CDP provider
          +-- Computer Use provider
```

The desktop owns presentation and interaction. The Node owns durable state and side effects. Agent engines do not own product UI state.

## Migration phases

### Phase A — shell proof

- Pin all upstream sources.
- Build the Hermes Desktop source as a Zero3-branded application.
- Run Hermes in an isolated Zero3-owned `HERMES_HOME`.
- Install the Zero3 skill into that isolated profile.
- Start/reuse Zero3 Pilot Node before the desktop development session.
- Route Zero3-specific actions through the existing loopback REST API and policy seam.

This proves that the desktop packaging, React surface, file/project UX, transcript UX, terminal, preview panes, and platform lifecycle can be reused without depending on the proprietary Codex Desktop renderer.

### Phase B — native Zero3 transport

Replace the compatibility skill bridge for first-class UI actions with a dedicated desktop transport. The renderer must receive a stable bootstrap/capabilities model from Zero3 Node and subscribe to job/event changes without polling every panel independently.

Expected first-class surfaces:

- conversations / execution threads
- projects / workspaces / worktrees
- task queue and persistent jobs
- automation schedules
- memory
- browser sessions
- computer control
- Agent routing and per-engine status
- approvals and permission prompts
- logs / diagnostics

Hermes-specific backend assumptions must be progressively moved behind adapters instead of spreading through the Zero3 renderer.

### Phase C — Codex app-server adapter

Use the pinned open-source Codex `app-server` as the preferred Codex integration boundary. CLI dispatch remains a fallback during migration. Do not invoke the proprietary Codex AppX as a hidden dependency of the Zero3 desktop product.

### Phase D — DeepSeek Harness adapter

Integrate DeepSeek Harness behind the same engine abstraction. Reuse concepts from its plugin-oriented architecture where they improve Zero3, but do not make the renderer depend directly on DeepSeek-specific state shapes.

### Phase E — remove legacy shell

After the v3 desktop passes Windows packaging, startup, local Node, Agent, browser, computer-use, persistence, and recovery acceptance tests:

- remove Tao/Wry from the primary desktop path;
- update the Windows installer to package the Electron application;
- retain the old Node HTML dashboard only as a diagnostic/recovery surface;
- delete the legacy desktop launcher when no rollback requirement remains.

## Acceptance gates before merging to main

1. The Electron/React desktop builds from the pinned Hermes source on Windows.
2. The app launches without requiring the proprietary Codex Desktop/AppX.
3. Zero3 Node starts or is reused on loopback and remains the side-effect boundary.
4. Zero3 skill discovery works in the isolated Hermes profile.
5. A Zero3 Agent job can be submitted and its durable result inspected.
6. Existing scheduler, memory, Browser CDP, and Computer Use tests remain green.
7. The build exposes the exact upstream SHAs used for provenance.
8. No upstream submodule floats to an unreviewed commit.
9. The old Tao/Wry shell is not extended with new product UI.

## License / attribution handling

Hermes Agent and DeepSeek Harness are consumed as pinned upstream source trees and must retain their upstream license and attribution. Zero3-specific overlays must not remove upstream copyright or license material. Before vendoring any source out of a submodule, copy the relevant license/notice text into the distribution notice set and document the source path and pinned SHA.

# Zero3 Desktop v3 Architecture

> **Historical migration document — superseded.**
>
> This file records an earlier desktop-v3 migration design in which Zero3 Pilot Node was still described as the durable control-plane/runtime boundary and Codex was treated as an adapter/engine. That is **not the current architecture authority**.
>
> Current rule: open-source Codex is the only authoritative native Agent Kernel/runtime. Hermes is a desktop UI/UX shell source with temporary compatibility scaffolding for unported surfaces; legacy Zero3 Node must not become the hidden native core for migrated behavior. See [`ARCHITECTURE_CONSTITUTION.md`](ARCHITECTURE_CONSTITUTION.md), [`ARCHITECTURE.md`](ARCHITECTURE.md) and the repository [`README`](../README.md).
>
> The remainder is retained for migration-history/provenance only. Statements below such as “Zero3 Pilot Node remains the durable local control plane” or “Codex app-server adapter” describe the earlier design stage and must not be used to override the current architecture constitution.

## Historical decision

Zero3 Pilot planned to own its desktop product surface. The UI foundation was selected from the open-source Hermes Desktop Electron/React application, not the proprietary Codex Desktop application and not the Codex Ratatui TUI.

At this historical stage, Codex was described as an execution engine through its open-source CLI / `app-server` source, DeepSeek Harness as an additional engine/plugin/UI architecture source, and Zero3 Pilot Node as the durable local control plane for jobs, scheduling, memory, browser automation, computer control, policy enforcement, and cross-agent orchestration. **This runtime-authority split has since been superseded by the Codex-native architecture.**

## Fixed upstream source versions at this migration stage

The migration branch pinned:

```text
openai/codex                  94311d447587411789533c47601fd8bc9d81eb48
NousResearch/hermes-agent     f7c79efbac19ae18e8dee7c79a4e4c0935299b5f
deepseek-ai/deepseek-harness  cd5ef8148158c3a752a658978873241fdf8e2bbc
```

Do not silently float these SHAs. Upstream updates are explicit review events because renderer, transport, permissions, packaging, and plugin contracts can all change.

## Historical target boundary

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

This diagram is retained as historical context. The current architecture instead gives Codex native Agent Kernel/runtime authority and constrains legacy Node/Hermes behavior to non-authoritative compatibility or extension roles.

## Historical migration phases

### Phase A — shell proof

- Pin all upstream sources.
- Build the Hermes Desktop source as a Zero3-branded application.
- Run Hermes in an isolated Zero3-owned `HERMES_HOME`.
- Install the Zero3 skill into that isolated profile.
- Start/reuse Zero3 Pilot Node before the desktop development session.
- Route Zero3-specific actions through the existing loopback REST API and policy seam.

This phase proved that the desktop packaging, React surface, file/project UX, transcript UX, terminal, preview panes, and platform lifecycle could be reused without depending on the proprietary Codex Desktop renderer.

### Phase B — native Zero3 transport

The historical design proposed replacing the compatibility skill bridge for first-class UI actions with a dedicated desktop transport, while receiving bootstrap/capabilities data from Zero3 Node.

Expected first-class surfaces included:

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

This phase description predates the current Codex-native Thread/Turn/Item transport and should be read as migration history.

### Phase C — Codex app-server adapter

The historical plan used the pinned open-source Codex `app-server` as the preferred Codex integration boundary, with CLI dispatch as a migration fallback. Current Zero3 has since elevated Codex from an adapter role to the authoritative native Agent Kernel/runtime.

### Phase D — DeepSeek Harness adapter

The historical design considered DeepSeek Harness behind the same engine abstraction. In the current architecture DeepSeek-Harness is a capability donor/reference source rather than an alternate native engine.

### Phase E — remove legacy shell

The historical acceptance plan called for removing Tao/Wry from the primary desktop path after the Electron target passed Windows packaging/startup and recovery gates. The current target shell is the Hermes-derived Electron/React path; legacy Wry/Node installer documentation must not be treated as the first-alpha distribution model.

## Historical acceptance gates

The original migration document listed:

1. The Electron/React desktop builds from the pinned Hermes source on Windows.
2. The app launches without requiring the proprietary Codex Desktop/AppX.
3. Zero3 Node starts or is reused on loopback and remains the side-effect boundary.
4. Zero3 skill discovery works in the isolated Hermes profile.
5. A Zero3 Agent job can be submitted and its durable result inspected.
6. Existing scheduler, memory, Browser CDP, and Computer Use tests remain green.
7. The build exposes the exact upstream SHAs used for provenance.
8. No upstream submodule floats to an unreviewed commit.
9. The old Tao/Wry shell is not extended with new product UI.

Items 3–5 are especially historical and do not define current runtime authority. Current release gates are tracked in [`RELEASE_PROCESS.md`](RELEASE_PROCESS.md), [`../ROADMAP.md`](../ROADMAP.md) and the first-alpha readiness issue.

## License / attribution handling

Hermes Agent and DeepSeek Harness are consumed as pinned upstream source trees and must retain their upstream license and attribution. Zero3-specific overlays must not remove upstream copyright or license material. Before vendoring any source out of a submodule, copy the relevant license/notice text into the distribution notice set and document the source path and pinned SHA.

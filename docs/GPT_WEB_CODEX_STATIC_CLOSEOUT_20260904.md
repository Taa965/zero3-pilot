# GPT Web × Codex Local 静态开发封口 — 2026-09-04

> Integration branch: `feature/gpt-web-codex-unified-workspace-v1`  
> Static integration head: recorded by Git history after this document commit.  
> Truth boundary: this is a **static development closeout**, not Windows runtime PASS.

## 六路已汇总

- P01 / PR #78 — H5 versioned task-extension sidecar;
- P02 / PR #79 — packaged Zero3 project-context MCP for pinned Codex;
- P03 / PR #80 — authoritative required-evidence Completion Gate;
- P04 / PR #81 — Remote Host lease hydration from H5 extension envelope;
- P05 / PR #82 — token-isolated desktop Control Plane bridge;
- P06 / PR #83 — GPT Web → Codex structured handoff controls.

总控没有重复六路开发内容；各路合并后只增加一次集成接线：`applyZero3ControlRuntime()` 在 GPT Web Provider 完成后注入。

## 当前闭环

```text
GPT Web Surface
  -> Zero3 Task/Handoff Sheet or App/MCP staged TaskSpec
  -> Electron-main Control Plane Bridge
  -> H5 core task + task-extension sidecar
  -> Remote Host lease + extension hydration
  -> pinned Codex Thread/Turn
  -> Codex command/exec Git preflight/postflight
  -> Completion Evidence Gate
  -> zero3.pilot.execution-result.v1
  -> H5 durable terminal/evidence
  -> return_entry_id identifies the originating GPT Web entry
```

## 安全/权威边界

- ChatGPT Web remains a real `chatgpt.com` surface; no private conversation API, cookie export, access-token extraction, or DOM task transport.
- Open-source Codex remains the sole authoritative Agent Kernel.
- Control credentials stay in Electron main; renderer receives purpose-specific IPC only.
- H5 task extensions do not create a second task state machine; canonical lease/terminal state remains in the existing control plane.
- Git pre/postflight is routed through pinned Codex App Server `command/exec`, not a new Node shell authority.
- ProjectContext MCP is injected read-only into Codex (`project_get_context`, `handoff_get`) by default.
- Unknown requested completion evidence fails closed.

## Static feature status

Implemented:

- GPT Web persistent browser profile;
- per-conversation local binding/restore;
- provider picker;
- blue internet icon;
- GPT/Codex native surface switching;
- structured Task/Handoff dispatch fallback;
- H5 context/handoff preservation;
- packaged project-context MCP implementation and Codex config injection;
- Git base/clean/postflight gates;
- structured ExecutionResult;
- required-evidence Completion Gate.

The current Hermes-derived shell remains transitional presentation infrastructure. The next Gemini/Antigravity plan introduces the provider registry and new Zero3 UI architecture, so final mixed-provider chronological session presentation is completed there instead of deepening the retired Hermes visual structure.

## Only remaining proof gate

Windows truth testing is intentionally not performed in the GPT web development session. Use:

`docs/GPT_WEB_CODEX_WINDOWS_ACCEPTANCE_20260904.md`

The parent PR must remain Draft until the real Windows evidence proves:

- Electron overlay compile/typecheck;
- ChatGPT embedded login/profile persistence;
- MCP packaged process startup;
- H5 task-extension round trip;
- Codex Git/evidence gate behavior;
- GPT → Codex → Result flow;
- six-worktree/thread isolation;
- `dist:win` package behavior.

No static statement in this repository converts those runtime checks to PASS.

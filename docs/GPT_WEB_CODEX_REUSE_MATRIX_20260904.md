# GPT Web × Codex Local Reuse Matrix — 2026-09-04

> 审计基线：`main@c93a3f1198e31e98b1e5caf6f72dd8a77f7b3733`  
> 结论标签：`REUSE` / `EXTEND` / `REPLACE` / `NEW` / `RETIRED`

## 1. 总结

当前 Zero3 Pilot 并不是从零开始。

最关键的 Codex 本地执行链已经存在：

```text
Hermes-derived React UI
-> window.zero3Codex
-> typed Electron preload IPC
-> Electron main Zero3CodexAppServer
-> codex app-server --stdio
-> pinned open-source Codex
```

主聊天已经从 Hermes runtime 切到 Codex Thread / Turn / Item；持久化 AppServer conversation source、approval/input、Item rendering、structured input、native Thread actions 和 Windows bundled Codex 也已经合并。

因此新需求的真正缺口主要集中在：

1. GPT Web Browser Provider；
2. GPT Web binding metadata；
3. GPT/Codex 混排工作区入口；
4. Project Context / Handoff 扩展；
5. Codex-authoritative Git/verification evidence；
6. Zero3 MCP；
7. GPT Web -> Codex -> GPT 的产品化流转 UI。

---

## 2. Matrix

| 能力 | 当前实现 | 判定 | 本轮动作 |
|---|---|---|---|
| Desktop shell | `apps/zero3-desktop`，Hermes Electron/React shell | REUSE | 继续 overlay 模式，不 fork UI runtime |
| Codex core | pinned `upstream/codex` | REUSE | 保持唯一 Agent Kernel |
| Codex App Server lifecycle | `apply-codex-transport.mjs` 内 `Zero3CodexAppServer` | REUSE | 只补窄 typed operations |
| Renderer Codex bridge | `window.zero3Codex` typed preload | REUSE | 不增加 generic `call(method, params)` |
| Codex thread start/resume/list/read | 已实现 | REUSE | 作为 Codex entry authority |
| Codex turn start/interrupt | 已实现 | REUSE | 后续补 steer/review 等按需能力 |
| Codex streaming events | lifecycle/notification/request 已转发 | REUSE | UI 继续基于原生事件，不解析 CLI 文本 |
| Primary chat | Codex-native R2/R3 已完成 | REUSE | 不重写第二套 Codex chat |
| Durable Codex history | AppServer source persistence #49 已合并 | REUSE | 必须回归保护 |
| Approval / user input | R2B typed bridge 已存在 | REUSE | GPT Web 不复用该权限模型 |
| Codex Item rendering | R3A-R3F 已存在 | REUSE | 可直接作为 Codex surface |
| Structured local-image input | 已存在 | REUSE | 无需本轮重做 |
| Codex package/login/runtime | bundled pinned Codex path 已存在 | REUSE | 不引入 host-installed Codex 作为 core |
| Legacy `apps/desktop` Rust/Tao/Wry | rollback/history only | RETIRED | 不在此实现新功能 |
| Zero3 Node primary runtime | architecture 已明确 retired | RETIRED | 不恢复为 GPT/Codex session authority |
| 旧 `apply-browser-bridge.mjs` | 通过 Zero3 Node jobs 控制浏览器并读取 snapshot | RETIRED / REPLACE | 不重新启用；新 GPT Web Browser Provider 直接属于 Electron shell presentation |
| Hermes existing browser window infrastructure | `browser-windows.ts` 等 UI/window primitives | EXTEND | 可复用 window/layout patterns，但不复用旧 Node browser runtime |
| GPT Web embedded browser | 不存在 | NEW | Electron `WebContentsView` + persistent partition |
| ChatGPT Browser Profile | 不存在 | NEW | `persist:zero3-chatgpt`，本机持久化，不导出认证机密 |
| GPT Web URL/title binding | 不存在 | NEW | navigation/title observer + local metadata |
| ChatGPT cloud history API | 无正式集成 | 不做 | V1 只管理 Zero3 访问/绑定过的 URL |
| Unified GPT/Codex sidebar | 现有 sidebar 仅 Codex Thread projection | EXTEND | 引入 Workspace Entry projection，混排显示 |
| Codex session authority | Codex Thread | REUSE | 不能搬到 Zero3 DB 重新做 lifecycle |
| Generic `Zero3Session` authority | 不存在且与 constitution 有冲突风险 | REPLACE DESIGN | 改为 `Workspace Entry Registry`，只管理 UI binding |
| Project-level memory/context | constitution 允许 Zero3 extension；现有 Node memory 方向不再是 primary | EXTEND / MIGRATE | 走 Codex-native MCP/skill/hook extension seam |
| MCP landing | `mcp/README.md` 只有目录占位，无 server | NEW | 建 Zero3 project extension MCP |
| Remote Task protocol | `zero3.pilot.remote-task.v1` 已存在 | REUSE | 作为 GPT -> Codex Task/Handoff 基础 |
| Remote Task validation | `remote-task-runner.ts` 已存在 | REUSE | 扩展 context/evidence，不另造 task kernel |
| Task -> Codex Thread mapping | `Zero3RemoteCodexMapping` 已存在 | REUSE | 与 Workspace Entry/Project binding 对接 |
| Evidence/outbox | host-runtime 已有 evidence/outbox | REUSE | 扩展 completion/result evidence |
| Remote Host allow-list | 已存在 | REUSE | 六路并行继续按 workspace 隔离 |
| Commander Bridge H5 control-plane adapter | 独立仓库 PR #1 已存在 | EXTEND / DEPENDENCY | 保持 transport-only，不给 shell/Git/Codex authority |
| Control lease | 既有 control-plane 方向 | REUSE / EXTEND | 继续 fencing/lease，不做 last-writer-wins |
| Git base-ref preflight | `remote-task-runner.ts` 当前明确阻塞 `base_ref` | NEW / EXTEND | 做 Codex-authoritative Git preflight |
| clean worktree preflight | 当前明确阻塞 | NEW / EXTEND | 同上，不绕过 kernel 建通用 shell executor |
| Commit/push evidence | 尚未形成统一 Handoff gate | NEW / EXTEND | 通过 Codex-native flow + evidence contract 实现 |
| Worktree parallel isolation | constitution 归 Codex Git/worktree integration；control-plane 有 workspace concept | EXTEND | 统一 task workspace/worktree policy |
| Windows verification | 现有 Remote Host / 验收体系存在 | REUSE / EXTEND | 接入 Completion Gate evidence |
| Completion Gate | 有“不得假定成功”原则但无本需求完整 gate | NEW / EXTEND | 以 Codex/Git/verification authoritative evidence 判定 |
| GPT Web -> Codex handoff UI | 不存在 | NEW | `交给 Codex` / status / result / `回到 GPT` |
| GPT Web DOM automation | 旧 browser snapshot 有相关历史能力 | 不做 | 不作为正式链路 |
| GPT Web private API | 不存在 | 不做 | 不依赖 |

---

## 3. 现有代码可直接复用的关键点

### 3.1 `apps/zero3-desktop/scripts/apply-codex-transport.mjs`

已具备：

- pinned `codex app-server --stdio` lifecycle；
- initialize / initialized；
- JSONL parsing；
- request correlation / timeout；
- bounded stdout/stderr；
- server request forwarding；
- typed Renderer preload；
- thread start/resume/list/read；
- turn start/interrupt；
- lifecycle/notification/request events。

结论：P03 不是“开发 Codex Adapter”，而是“补齐本需求缺失的窄接口并保持现有安全边界”。

### 3.2 `apps/zero3-desktop/scripts/apply-codex-primary-chat.mjs`

主聊天已经直接映射：

```text
new chat -> thread/start
sidebar -> thread/list
history -> thread/resume + thread/read
send -> turn/start
stream -> native item notifications
stop -> turn/interrupt
```

结论：Codex UI 主体直接复用。

### 3.3 `apps/zero3-desktop/host-runtime/remote-types.ts`

已经定义：

```text
Zero3RemoteTask
Zero3RemoteLease
Zero3RemoteCodexMapping
Zero3RemoteTaskState
Zero3RemoteOutboxEnvelope
```

并拥有：

```text
objective
workspace
base_ref
constraints
acceptance_criteria
permission_profile
max_turns
timeout
require_clean_worktree
```

结论：它与新 TaskSpec 高度重合，应演进而不是重做。

### 3.4 `remote-task-runner.ts`

已经做到：

- task schema validation；
- workspace allow-list；
- task fingerprint；
- task/execution -> Codex thread durable mapping；
- read-only + on-request safety default；
- duplicate turn recovery；
- evidence collection；
- outcome-unknown fail closed。

同时明确缺口：

```text
base_ref -> currently blocked
require_clean_worktree -> currently blocked
```

这正是 P05 的真实开发入口。

---

## 4. 需要废弃/避免复用的内容

### 4.1 旧 Browser Bridge

`apply-browser-bridge.mjs` 将浏览器动作发给 Zero3 Node `/api/v1/jobs/browser`，并暴露 snapshot text/elements。

该 overlay 已被 `apps/zero3-desktop/README.md` 明确列入 retired Zero3 Node desktop direction，且 `prepare-upstream.mjs` 不再 apply。

因此：

- 不重新启用；
- 不在其上继续开发 GPT Web；
- 可借鉴 URL validation 等局部安全做法；
- 新 GPT Web Browser Provider 必须直接属于 Electron desktop presentation layer。

### 4.2 新建第二套 Session authority

旧方案中的统一 `Zero3Session` 若承担 Codex thread lifecycle，会与 architecture constitution 冲突。

修正为：

```text
Workspace Entry Registry
```

它只统一 UI entry，不统一 provider authority。

---

## 5. 本轮真实开发边界

### P01 — Workspace Entry Core

NEW/EXTEND：

- `Zero3WorkspaceEntryKind`；
- Codex Thread projection；
- GPT Web binding metadata；
- registry persistence；
- provider-independent sidebar adapter。

禁止：复制 Codex Thread 内容成为第二 authority。

### P02 — GPT Web Browser Provider

NEW：

- Electron `WebContentsView`；
- persistent `session.fromPartition('persist:zero3-chatgpt')`；
- URL/title/load/crash events；
- create/open/show/hide/destroy；
- bounds sync；
- browser profile local persistence；
- fallback external browser。

### P03 — Codex Extension

REUSE/EXTEND：

- 复用现有 `Zero3CodexAppServer`；
- 按需补 `thread/name/set`、`turn/steer`、`review/start`、usage/status 等；
- Renderer 仍只暴露 purpose-specific methods。

### P04 — Project Context / Handoff

REUSE/EXTEND/NEW：

- 演进 `zero3.pilot.remote-task.v1`；
- project/context reference；
- structured result；
- artifact/evidence references；
- MCP project extension contract。

### P05 — Git / Worktree / Verify Evidence

EXTEND/NEW：

- Codex-authoritative Git preflight；
- base ref / clean tree；
- head/commit/push evidence；
- Windows verify evidence；
- Completion Gate。

### P06 — Unified UI

EXTEND/NEW：

- provider picker；
- blue internet icon；
- mixed recents；
- surface switch；
- handoff/status/result controls。

---

## 6. 依赖关系

```text
P01 Workspace Entry contract
├─ P02 GPT Web Browser
├─ P03 Codex projection/extension
└─ P06 Unified UI

P04 Task/Handoff
└─ P05 Git/Verify evidence

P01 + P02 + P03 + P04 + P05
└─ P06 final wiring
```

顶层开发可并行，但总控阶段只做一次汇总、接线、静态总审与 Windows 真实性验收，不重复各支线已经完成的开发内容。

---

## 7. Phase 0 结论

Phase 0 Reuse Matrix：**完成**。

实际复用率高于原先估计：Codex runtime、conversation lifecycle、primary chat、remote task、task-thread mapping、evidence/outbox、Windows Remote Host 都已存在。

因此后续不应按“从零开发 Session Hub + Codex Adapter + Git Manager”执行，而应按：

```text
新增 GPT Web presentation provider
+ 新增 Workspace Entry projection
+ 演进现有 Remote Task/Handoff
+ 补 Codex-authoritative Git/verify evidence
+ 新增 Zero3 MCP project extension
+ 统一 UI 接线
```

执行。

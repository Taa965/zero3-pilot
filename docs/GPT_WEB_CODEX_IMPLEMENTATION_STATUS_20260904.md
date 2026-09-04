# GPT Web × Codex Local 实施状态 — 2026-09-04

> 分支：`feature/gpt-web-codex-unified-workspace-v1`  
> PR：#77（Draft）  
> 验证级别：静态实现 / 静态审计；**尚未进行 Windows 真实性验收**。

## 1. 已完成

### Phase 0 — Reuse Matrix

完成。

确认现有 Zero3 已具备：

- pinned open-source Codex；
- Codex App Server stdio transport；
- typed Electron preload；
- Thread / Turn / Item primary chat；
- durable Codex history；
- approval / input / item rendering；
- Remote Host；
- `zero3.pilot.remote-task.v1`；
- task -> Codex Thread durable mapping；
- evidence/outbox；
- H5 Control Plane 基础。

因此没有重新实现第二套 Codex Agent Kernel。

### P01 — Workspace Entry Core

已落地：

- `Workspace Entry Registry`；
- GPT Web entry schema；
- project binding；
- URL/title/local-title metadata；
- 本地原子持久化；
- mutation serialisation；
- typed Electron IPC/preload。

Codex Thread authority 没有搬进 Workspace Registry。

### P02 — GPT Web Browser Provider

已落地：

- Electron `WebContentsView`；
- `persist:zero3-chatgpt` profile；
- ChatGPT 登录态独立持久化；
- create/show/hide/navigate/reload/suspend/remove/openExternal；
- URL / title observation；
- `/c/<id>` conversation binding；
- max 3 live views；
- native view LRU/suspend；
- HTTPS navigation guard；
- popup isolation；
- OAuth URL 不进入 Zero3 metadata；
- 不读取 cookie/access token；
- 不依赖 ChatGPT private API；
- 不使用 DOM scraping 作为正式链路。

额外完成：

- 当真实 ChatGPT 页面内部从 conversation A 跳到 conversation B 时，Zero3 保留 A 的 sidebar entry，并创建/复用 B entry；
- native live view 重新绑定到目标 entry；
- renderer 收到 `previousEntryId -> entryId` navigation event，用于同步当前选中项。

### P03 — Codex Runtime Extension

核心直接复用既有 `Zero3CodexAppServer`。

本轮新增实际需要的 authority seam：

- Remote Host 可通过现有 app-server transport 调用 `command/exec`；
- 没有新增 generic Renderer JSON-RPC proxy；
- 没有恢复 host-installed Codex 作为 primary runtime。

### P04 — Project Context / Handoff

Host contract 已扩展：

- `project_context` reference；
- source entry/kind；
- context version/ref；
- handoff request；
- return entry；
- named evidence request；
- `zero3.pilot.execution-result.v1` structured result；
- agent summary；
- Git pre/postflight evidence；
- evidence method list。

另已落地：

`mcp/zero3-project-context/`

工具：

```text
project_get_context
project_put_context
handoff_get
handoff_publish
```

具备：

- optimistic version control；
- atomic local writes；
- 2 MiB payload cap；
- stale writer rejection；
- execution-result protocol validation；
- taskId/result.task_id integrity gate。

### P05 — Git / Worktree / Verification Evidence

已完成 Git 部分的 Codex-authoritative pre/postflight：

```text
Codex app-server command/exec
-> git rev-parse --show-toplevel
-> HEAD
-> requested base commit
-> clean-worktree check
```

完成后：

```text
HEAD
branch
worktree status
optional @{upstream}
```

硬门禁：

- `base_ref` mismatch -> BLOCKED；
- `require_clean_worktree` dirty -> BLOCKED；
- `require_clean_worktree_on_success` dirty -> 不得 succeeded；
- `require_remote_sync_on_success` HEAD != upstream -> 不得 succeeded。

没有引入 Node child-process Git Agent Kernel。

### P06 — Unified UI

已落地：

- 原新建会话入口弹出 Provider Picker；
- `GPT Web` / `Codex Local` 两种选项；
- GPT Web 使用蓝色 globe/internet icon；
- GPT Web entry 与 Codex conversations 位于同一左侧 conversation 区域；
- GPT Web native view 覆盖主聊天区域，Zero3 左栏保持可见；
- resize / native bounds adapter；
- 点击 Codex / 左侧其他 UI 会隐藏 GPT view；
- Codex selection 继续走原有 Thread path；
- Provider Picker 即使 Codex history 为空也保持挂载。

## 2. 当前明确未完成

### Blocker A — H5 optional-field preservation

Host 端已支持：

```text
project_context
handoff
```

但当前 `apps/web/src/control_plane.rs` 的 typed `RemoteTask` schema 尚未同步这些字段。

因此目前不能声称新增字段已经完整穿透：

```text
GPT/Commander
-> H5
-> Remote Host
```

legacy Remote Task v1 核心字段仍兼容。

### Blocker B — packaged MCP wiring

MCP server implementation 已存在，但还没有：

- bundle 到 Desktop packaged resources；
- 给 pinned Codex Thread 默认注入受控 MCP config；
- Windows packaged lifecycle evidence。

不得假定用户全局安装 `node` / `tsx` / `npm`。

### Blocker C — named verification evidence gate

`handoff.required_evidence` 当前：

- schema 已有；
- prompt 已有；
- result evidence list 已有；

但尚未把每个 requested evidence name 映射到 authoritative verification adapter，并在缺失时 fail-closed。

### Blocker D — GPT Web → Codex one-click control path

UI/Browser/Remote Host/Handoff 基础已具备，但真正的一键：

```text
GPT Web
-> Zero3 control task
-> H5
-> Codex
```

仍需要 ChatGPT App/MCP write path 或受控 Zero3 control-plane action。

不能通过 DOM 自动点击 ChatGPT 来伪造这一步。

## 3. UI 当前限制

GPT Web 与 Codex 已处于同一个 sidebar conversation 区域，GPT 使用蓝色互联网图标。

但两种 provider 还没有放进一个完全统一的 chronological sort/virtualized array；当前 GPT rows 位于 Codex recents 前方。

这是 presentation polish，不影响 provider authority 边界。

## 4. 验证状态

没有执行：

- Linux 真实性 build/test；
- Windows Electron compile；
- Windows ChatGPT OAuth/login；
- WebContentsView real render；
- Windows Codex `command/exec` integration；
- 6-way worktree integration；
- `dist:win`。

这是刻意遵循当前 Zero3 开发流程：GPT 网页会话做静态实现与静态审查，Windows 真实性验收交给本地 Codex/Hermes。

统一 Windows 验收方案见：

`docs/GPT_WEB_CODEX_WINDOWS_ACCEPTANCE_20260904.md`

## 5. 合并门禁

PR #77 当前必须保持 Draft。

只有以下条件满足才能 Ready / merge：

1. Desktop overlay prepare/typecheck 真实 PASS；
2. ChatGPT Web login/profile persistence 真实 PASS；
3. URL/title/entry separation 真实 PASS；
4. GPT/Codex native view switching 真实 PASS；
5. Codex Git pre/postflight 真实 PASS；
6. ExecutionResult 真实 PASS；
7. MCP implementation typecheck/behavior PASS；
8. H5 optional-field preservation 封口；
9. required-evidence Completion Gate 封口；
10. 6-way isolation PASS；
11. Windows package PASS。

总控阶段只做一次统一接线、一次真实性集成验收和集中修复，不重复各支线已经完成的开发内容。

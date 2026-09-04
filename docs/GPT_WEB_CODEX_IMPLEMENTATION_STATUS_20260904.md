# GPT Web × Codex Local 实施状态 — 2026-09-04

> 分支：`feature/gpt-web-codex-unified-workspace-v1`  
> PR：#77（Draft）  
> 当前阶段：**STATIC_CLOSEOUT_READY_FOR_WINDOWS_ACCEPTANCE**  
> 验证纪律：静态实现/静态审计已收口；Windows 真实性编译、运行、登录、MCP、Git/Handoff、并行隔离与打包仍为 `NOT_RUN`。

## 1. 已完成的静态能力

### Phase 0 — Reuse Matrix

继续复用现有 Zero3 权威边界：

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
- H5 Control Plane。

没有重新实现第二套 Codex Agent Kernel。

### P01 — Workspace Entry Core

已落地：

- `Workspace Entry Registry`；
- GPT Web entry schema；
- project binding；
- URL/title/local-title metadata；
- 本地原子持久化；
- mutation serialisation；
- typed Electron IPC/preload。

Workspace Registry 只管理 UI/project binding，不接管 Codex Thread authority。

### P02 — GPT Web Browser Provider

已落地：

- Electron `WebContentsView`；
- `persist:zero3-chatgpt` 独立 profile；
- create/show/hide/navigate/reload/suspend/remove/openExternal；
- `/c/<id>` conversation binding；
- URL/title observation；
- max 3 live views + LRU/suspend；
- HTTPS navigation guard；
- popup isolation；
- OAuth URL 不进入 Zero3 metadata；
- 不读取 Cookie/access token；
- 不依赖 ChatGPT private API；
- 不使用 DOM scraping/DOM automation 作为正式控制面。

真实 ChatGPT 页面从 conversation A 跳到 B 时，A sidebar entry 保留，B 创建/复用独立 entry，并通过 navigation event 同步当前选中项。

### P03 — Codex Runtime Extension

继续复用既有 `Zero3CodexAppServer`。

新增：

- Remote Host 通过同一 app-server transport 调用 `command/exec`；
- Git pre/postflight 不建立 Node shell/Git Agent Kernel；
- 没有 generic Renderer JSON-RPC proxy；
- 没有恢复 host-installed Codex 为 primary runtime。

### P04 — Project Context / Handoff

Host contract 已支持：

- `project_context` reference；
- source entry/kind；
- context version/ref；
- handoff request；
- return entry；
- named evidence request；
- `zero3.pilot.execution-result.v1`；
- agent summary；
- Git pre/postflight evidence；
- evidence method list。

`mcp/zero3-project-context/` 已实现：

```text
project_get_context
project_put_context
handoff_get
handoff_publish
```

并具备 optimistic version control、atomic local writes、payload cap、stale writer rejection、result protocol validation、taskId/result.task_id integrity gate。

### P05 — Git / Completion Evidence

Codex-authoritative Git preflight/postflight 已落地：

```text
command/exec
-> git rev-parse --show-toplevel
-> HEAD
-> optional requested base commit
-> optional clean-worktree preflight
-> postflight HEAD / branch / status / optional upstream
```

硬门禁：

- `base_ref` mismatch -> `BLOCKED`；
- `require_clean_worktree` dirty -> `BLOCKED`；
- `require_clean_worktree_on_success` dirty -> 不得 `succeeded`；
- `require_remote_sync_on_success` 且 `HEAD != @{upstream}` -> 不得 `succeeded`。

### P06 — Unified UI

已落地：

- 原新建会话入口出现 Provider Picker；
- `GPT Web` / `Codex Local`；
- GPT Web 蓝色 globe/internet icon；
- GPT Web entry 与 Codex conversations 位于同一左侧 conversation 区域；
- GPT Web native view 覆盖主聊天区域但不覆盖 Zero3 左栏；
- native bounds / resize adapter；
- 点击 Codex/其他主界面时隐藏 GPT native view；
- Codex selection 继续走原 Thread path；
- Provider Picker 在 Codex history 为空时仍可用。

## 2. 四个原静态 Blocker 已封口

### A — H5 optional-field preservation：已封口

不修改旧 `RemoteTask` 核心 schema，改用独立、版本化 extension sidecar：

```text
/api/control/v1/tasks/:task_id/extensions
/api/host/v1/tasks/:task_id/extensions
```

支持：

```text
project_context
handoff
provider
review
```

具备：

- task/execution identity binding；
- optimistic `expected_version`；
- stale writer rejection；
- atomic local persistence；
- Host/Control 独立 bearer token；
- legacy `zero3.pilot.remote-task.v1` 核心字段保持兼容。

因此新增 extension 字段不再依赖旧 typed `RemoteTask` schema 吞吐。

### B — packaged project-context MCP：已静态封口

`applyZero3ProjectContextMcp()` 已进入共享 `prepare-upstream.mjs` pipeline：

- server 复制到 packaged Electron source tree；
- Desktop dependency 注入 `@modelcontextprotocol/server` / `zod`；
- 使用 packaged Electron binary + `ELECTRON_RUN_AS_NODE=1` 启动，不依赖用户全局 node/tsx/npm；
- `thread/start` 注入受控 MCP config；
- Codex 默认只启用 `project_get_context` / `handoff_get` 读取工具；
- UI/Provider/MCP overlay 由 prepare pipeline 显式编排，不再藏在 Provider 内部副作用。

真实 packaged lifecycle 仍需 Windows 验收。

### C — named verification evidence gate：已静态封口

`handoff.required_evidence` 已映射到 authoritative Completion Gate：

```text
codex.turn.completed
git.preflight
git.postflight
git.clean
git.remote_synced
agent.summary
execution.result
```

规则：

- 缺失 requested evidence -> 不得 `succeeded`；
- unknown evidence name -> fail closed；
- success terminal 持久化前再次校验；
- Completion Gate 失败落 `blocked`，不会把 worker 文本声明当成证据。

### D — GPT Web → Codex one-click control path：已静态封口

GPT Web active entry 已有 `交给 Codex` action：

```text
GPT Web entry
-> Zero3 Handoff Sheet
-> window.zero3Control.tasks.dispatchCodex
-> H5 control task + extension sidecar
-> Remote Host
-> pinned Codex Thread/Turn
-> ExecutionResult / evidence
```

这条链路：

- 不读取 ChatGPT DOM；
- 不自动点击 ChatGPT 页面；
- 不把 control token 暴露给 Renderer；
- 可以携带 `project_context` / `handoff.return_entry_id` / `required_evidence`；
- ChatGPT App/MCP write path 后续可作为更无感入口，但不是 V1 fallback 闭环的 blocker。

## 3. 当前仅剩非核心静态项

### Presentation polish

GPT Web 与 Codex 已在同一个 sidebar conversation 区域，但还不是一个统一的 chronological virtualized array；目前 GPT rows 单独按 `lastActiveAt` 排序并位于 Codex recents 前方。

这是 UI polish，不影响 provider authority、Handoff、Git、MCP 或 Completion Gate。

### Mainline integration

PR #77 当前仍基于 `main`。Development Group V1 的总控收口位于其独立 integration branch；两个大功能在各自真实性验收完成后，仍需要一次 release-level 合并/冲突检查，不能把“各自静态完成”扩张成“最终 main 已全部集成”。

## 4. 当前验证状态

以下均尚未在本轮由 ChatGPT Web 执行，因此保持 `NOT_RUN`：

- Windows Electron compile/typecheck；
- Windows ChatGPT OAuth/login；
- WebContentsView real render；
- Browser profile restart persistence；
- Windows Codex `command/exec` integration；
- packaged project-context MCP lifecycle/tool enumeration；
- H5 extension sidecar real HTTP round-trip；
- GPT Web -> H5 -> Remote Host -> Codex one-click real handoff；
- named evidence fail-closed real run；
- 6-way worktree/thread isolation；
- `dist:win`。

统一真实性验收见：

`docs/GPT_WEB_CODEX_WINDOWS_ACCEPTANCE_20260904.md`

## 5. PR #77 合并门禁

PR #77 必须继续保持 Draft，直到以下真实证据全部关闭：

1. Desktop `reset -> prepare -> typecheck -> codex:verify` PASS；
2. ChatGPT Web login/profile persistence PASS；
3. URL/title/entry separation PASS；
4. GPT/Codex native view switching PASS；
5. Codex Git pre/postflight PASS；
6. structured `ExecutionResult` PASS；
7. packaged project-context MCP PASS；
8. H5 extension sidecar preservation PASS；
9. named-evidence Completion Gate PASS；
10. GPT Web -> Codex one-click handoff PASS；
11. 6-way isolation PASS；
12. Windows package PASS。

总控阶段仍遵循：只做一次统一真实性集成验收和集中修复，不重复已经静态完成的各支线开发。

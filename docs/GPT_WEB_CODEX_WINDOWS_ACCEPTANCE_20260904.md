# GPT Web × Codex Local Windows 统一真实性验收 — 2026-09-04

> 目标 PR：#77  
> 分支：`feature/gpt-web-codex-unified-workspace-v1`  
> 静态状态：`STATIC_CLOSEOUT_READY_FOR_WINDOWS_ACCEPTANCE`  
> 当前真实性状态：**NOT_RUN**  
> 原则：只做一次完整真实性验收；任何静态实现、CI 或局部成功都不得扩张成 Windows/product PASS。

## 0. Truth boundary

当前静态代码已经封口：

- GPT Web `WebContentsView` + persistent profile；
- Workspace Entry；
- GPT/Codex Provider Picker；
- GPT Web → Codex structured handoff fallback；
- H5 versioned task-extension sidecar；
- packaged project-context MCP；
- Codex-authoritative Git pre/postflight；
- `zero3.pilot.execution-result.v1`；
- named `required_evidence` Completion Gate。

以下只有 Windows 真机证据才能变成 PASS：登录态、Electron native view、Codex process、MCP packaged lifecycle、H5 round trip、真实 Git、完整 GPT→Codex→Result、并行隔离和 Windows package。

---

## 1. 固定候选 SHA

```powershell
git fetch origin
git checkout feature/gpt-web-codex-unified-workspace-v1
git pull --ff-only origin feature/gpt-web-codex-unified-workspace-v1
git status --short
$TESTED_HEAD = git rev-parse HEAD
$TESTED_HEAD
```

要求：

```text
WORKTREE_CLEAN=true
TESTED_HEAD=<exact 40-char SHA>
```

工作树不 clean 时停止；不要覆盖本地改动。

---

## 2. Desktop shared prepare pipeline

```powershell
cd apps/zero3-desktop
npm run reset
npm run prepare
npm run typecheck
npm run codex:verify
```

必须确认 shared prepare 实际执行并生成：

```text
Workspace Entry Runtime
GPT Web Provider
GPT Web UI
Control Runtime
Project Context MCP
Remote Host Runtime
Codex primary chat overlays
```

检查生成树至少存在：

```powershell
Test-Path ..\..\upstream\hermes-agent\apps\desktop\electron\zero3\gpt-web\gpt-web-provider.ts
Test-Path ..\..\upstream\hermes-agent\apps\desktop\electron\zero3\control\control-client.ts
Test-Path ..\..\upstream\hermes-agent\apps\desktop\electron\zero3\mcp\project-context-server.mjs
Test-Path ..\..\upstream\hermes-agent\apps\desktop\src\app\chat\sidebar\zero3-gpt-web-section.tsx
Test-Path ..\..\upstream\hermes-agent\apps\desktop\src\app\chat\sidebar\gpt-web-handoff-actions.tsx
```

全部必须为 `True`。

再执行一次：

```powershell
npm run reset
npm run prepare
npm run typecheck
```

第二次也必须成功，用来验证 reset/prepare 幂等和生成文件清理。

---

## 3. Packaged Project Context MCP

先验证独立实现：

```powershell
cd ..\..\mcp\zero3-project-context
npm install
npm run typecheck
```

必须覆盖：

1. `project_get_context` 不存在时 version 0；
2. `project_put_context(expectedVersion=0)` -> version 1；
3. stale `expectedVersion=0` 再写 -> reject；
4. 正确 `expectedVersion=1` -> version 2；
5. `handoff_publish` 错误 result protocol -> reject；
6. `handoff_publish(taskId=A)` + `result.task_id=B` -> reject；
7. 正确 handoff 可 `handoff_get`；
8. state 不包含 Cookie/token/chat transcript。

然后验证 Desktop packaged seam：

```powershell
cd ..\..\apps\zero3-desktop
npm run reset
npm run prepare
```

检查：

- generated MCP server 位于 Hermes desktop Electron tree；
- generated Desktop package dependencies 含 MCP server package + zod；
- Codex `thread/start` 注入 `zero3_project_context`；
- command 使用 packaged Electron `process.execPath` + `ELECTRON_RUN_AS_NODE=1`；
- 默认启用工具只有 `project_get_context` / `handoff_get`；
- 不依赖用户全局 `node` / `tsx` / `npm` 启动 packaged MCP。

---

## 4. H5 task-extension sidecar

配置测试用 H5 Control Plane 后，真实 HTTP 覆盖：

```text
POST /api/control/v1/tasks/<task>/extensions
GET  /api/control/v1/tasks/<task>/extensions
GET  /api/host/v1/tasks/<task>/extensions
```

必须验证：

1. Control token 可写；
2. Host token 只按 Host 路径读取；
3. 未认证/错误 token 拒绝；
4. `expected_version=0` 首写成功；
5. stale version 写入 409；
6. 同 task_id 改绑另一个 execution_id -> 409；
7. project_context/handoff/provider/review 被持久化；
8. Remote Host lease 后能拿到与 task/execution 匹配的 extension；
9. extension 冲突时 fail closed；
10. legacy core `zero3.pilot.remote-task.v1` 在没有 sidecar 时仍兼容。

---

## 5. 启动 Zero3 Desktop

```powershell
cd apps/zero3-desktop
npm run dev
```

记录：

```text
Codex app-server started = yes/no
Remote Host started = yes/no
Renderer booted = yes/no
GPT Web provider IPC = yes/no
Workspace Entry IPC = yes/no
Control Plane bridge = yes/no
Packaged MCP process = yes/no
```

---

## 6. Provider Picker 与 GPT/Codex 切换

点击原“新建会话”。必须出现：

```text
GPT Web
Codex Local
```

验证 Codex Local：

- 进入既有 Codex Thread；
- 没有第二套 Agent runtime；
- history/turn 原路径正常。

验证 GPT Web：

- 中心区域是真实 `https://chatgpt.com/` WebContentsView；
- Zero3 左栏仍可见；
- 不是 iframe；
- GPT ↔ Codex 至少切换 20 次，无 native view 残留/双层遮挡；
- resize/maximize/sidebar resize 后 bounds 正常。

---

## 7. ChatGPT 登录/Profile 持久化与安全

首次登录 ChatGPT 后验证：

1. OAuth/login 可以完成或按 provider 规则使用安全 external fallback；
2. Zero3 workspace metadata 不保存 OAuth provider URL/authorization code/access token；
3. 登录后返回 `chatgpt.com`；
4. 关闭/重启 Zero3；
5. GPT Web 登录态仍存在；
6. profile 与系统 Chrome/Edge 隔离；
7. Zero3 不读取/输出 Cookie/access token；
8. `nodeIntegration` 不开放给 GPT Web；
9. `contextIsolation=true`；
10. 非 HTTPS 主导航、危险 popup/permission 默认 fail closed。

---

## 8. Conversation binding / sidebar

建立多个真实 ChatGPT conversation，验证：

- `/c/<id>` 自动绑定；
- title 稳定同步；
- generic `ChatGPT` / `New chat` 不覆盖有效标题；
- A→B 网页内导航时 A entry 保留，B entry 独立；
- GPT 条目蓝色 globe icon；
- 重启后 entry 恢复；
- live GPT view <= 3；
- suspended entry 能从持久化 URL 恢复；
- store 无 OAuth/token/chat transcript。

当前 GPT rows 与 Codex recents 尚不是统一 chronological virtualized array；这属于 presentation polish，不作为 V1 authority/function blocker。

---

## 9. GPT Web → Codex 一键 Handoff

打开一个 GPT Web entry，点击：

```text
交给 Codex
```

填写：

```text
Task ID
Objective
Local Workspace
Base Ref/SHA (optional)
```

要求真实链路为：

```text
GPT Web UI
-> purpose-specific zero3Control IPC
-> Electron-main Control Plane client
-> H5 task-extension sidecar
-> H5 core remote task
-> Remote Host lease + extension hydration
-> pinned Codex Thread/Turn
```

验证：

- Renderer 看不到 Control token；
- sidecar 在 core task enqueue 前成功写入；
- `return_entry_id` 等于来源 GPT entry；
- `project_context.source_kind=gpt_web`；
- 默认 handoff required evidence 包含 turn/Git/result；
- 不读取 ChatGPT DOM 来传递任务；
- 不调用 ChatGPT private API；
- Codex 任务最终 ExecutionResult 可关联原 task/execution/return entry。

---

## 10. Codex-authoritative Git preflight/postflight

至少覆盖：

### A — 正确 base + clean

```text
base_ref == HEAD
require_clean_worktree=true
```

应产生真实：

```text
repository_root
head_commit
base_commit
clean_worktree=true
```

### B — base mismatch

必须 `BLOCKED`，不得启动重复 side-effect Turn。

### C — dirty worktree

`require_clean_worktree=true` 时必须 `BLOCKED`。

### D — non-Git workspace

必须 fail closed。

### E — postflight clean gate

`require_clean_worktree_on_success=true` + dirty tree -> 不得 `succeeded`。

### F — upstream gate

`require_remote_sync_on_success=true` + `HEAD != @{upstream}` -> 不得 `succeeded`。

确认 Git authority 全部经过 pinned Codex App Server `command/exec`，不是新建 Node child-process shell authority。

---

## 11. ExecutionResult + named required evidence

成功候选必须生成：

```text
protocol = zero3.pilot.execution-result.v1
task_id
execution_id
codex_thread_id
codex_turn_id
agent_summary
git_preflight
git_postflight
evidence_methods
```

依次测试：

### Case 1 — 全部证据存在

请求：

```text
codex.turn.completed
git.preflight
git.postflight
execution.result
```

只有全部满足才允许 `succeeded`。

### Case 2 — 请求 git.clean 但 postflight dirty

必须 `blocked`。

### Case 3 — 请求 git.remote_synced 但未同步

必须 `blocked`。

### Case 4 — 请求 agent.summary 但无 summary

必须 `blocked`。

### Case 5 — 未知 evidence name

例如：

```text
made.up.evidence
```

必须 fail closed / `blocked`，不得忽略。

### Case 6 — terminal 前最终二次门禁

确认成功结果在 durable terminal `succeeded` 写入前仍经过 Completion Gate；不能只有 runner 内部第一次检查。

---

## 12. 6-way isolation

使用 6 个独立 worktree / Codex Thread 执行相互独立任务。

每路记录：

```text
task_id
execution_id
workspace
branch
base_sha
thread_id
turn_id
head_sha
terminal_state
```

必须验证：

- workspace/branch/thread/turn/evidence/mapping 不串；
- 一个任务失败不污染其他 5 路；
- stale lease/fencing 不可发布旧 terminal；
- sidecar task/execution 不可串绑；
- 每路 Git base/dirty gate 独立。

---

## 13. Windows package

前面全部通过后：

```powershell
cd apps/zero3-desktop
npm run dist:win
```

安装包验证：

- 启动正常；
- pinned Codex 可找到；
- GPT Web WebContentsView 可用；
- ChatGPT profile 重启持久；
- Workspace/Control/GPT/MCP/Remote Host generated runtime 都包含在最终应用；
- packaged project-context MCP 能由 Electron-as-Node 启动；
- 不依赖用户全局 Codex/node/tsx/npm；
- one-click GPT→Codex handoff 可在安装包环境完成；
- named evidence gate 在 packaged 环境仍 fail closed。

---

## 14. 回传格式

```text
TESTED_HEAD:
WINDOWS_VERSION:
NODE_VERSION:
ELECTRON_VERSION:
CODEX_PIN:

A. reset/prepare/typecheck/codex overlay
PASS/FAIL + evidence

B. GPT Web login/profile/security
PASS/FAIL + evidence

C. URL/title/sidebar/native-view switching
PASS/FAIL + evidence

D. packaged Project Context MCP
PASS/FAIL + evidence

E. H5 task-extension sidecar
PASS/FAIL + evidence

F. GPT Web -> Codex one-click handoff
PASS/FAIL + evidence

G. Git preflight/postflight
PASS/FAIL + evidence

H. ExecutionResult + named evidence gate
PASS/FAIL + evidence

I. 6-way isolation
PASS/FAIL + evidence

J. dist:win installed behavior
PASS/FAIL + evidence

BLOCKERS:
- ...

FINAL:
PASS / FAIL / BLOCKED
```

只有全部必需项具有真实 Windows 证据后，PR #77 才能从 Draft 转 Ready/merge；在此之前所有运行项保持 `NOT_RUN`。

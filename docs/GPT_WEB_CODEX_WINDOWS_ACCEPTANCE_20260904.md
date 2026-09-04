# GPT Web × Codex Local Windows 统一真实性验收 — 2026-09-04

> 目标 PR：#77  
> 分支：`feature/gpt-web-codex-unified-workspace-v1`  
> 当前状态：仅静态实现完成；本文用于本地 Windows Codex / Hermes Agent 执行真实性验证。  
> 原则：一次性完成编译、运行、功能、Git/Handoff 与并行隔离验收；不要把单项成功扩张成整个功能 PASS。

## 1. 拉取基线

```powershell
git fetch origin
git checkout feature/gpt-web-codex-unified-workspace-v1
git pull --ff-only origin feature/gpt-web-codex-unified-workspace-v1
git status --short
git rev-parse HEAD
```

必须记录：

```text
TESTED_HEAD=<sha>
WORKTREE_CLEAN=true/false
```

如果工作树不是预期 clean 状态，停止并报告，不要覆盖本地未提交内容。

---

## 2. Desktop overlay 静态生成 / TypeScript 验证

```powershell
cd apps/zero3-desktop
npm run reset
npm run prepare
npm run typecheck
npm run codex:verify
```

验收：

- `prepare-upstream.mjs` overlay 无 drift；
- `workspace-entry-runtime` 可复制/注入；
- `gpt-web-provider` 可复制/注入；
- `gpt-web-ui` patch anchor 全部匹配；
- Remote Host 能通过 `zero3CodexAppServer.request('command/exec', ...)` 接线；
- Hermes renderer / Electron main / preload TypeScript 无错误；
- Codex overlay pin verification 无回归。

任何一步失败：保留完整 stdout/stderr，标记 `BLOCKED`，不要继续声明 UI 可用。

---

## 3. Project Context MCP 验证

```powershell
cd ..\..\mcp\zero3-project-context
npm install
npm run typecheck
$env:ZERO3_PROJECT_CONTEXT_DIR = "$env:LOCALAPPDATA\Zero3Pilot\project-context-test"
npm start
```

在另一个终端用支持 MCP stdio 的本地客户端验证工具可枚举：

```text
project_get_context
project_put_context
handoff_get
handoff_publish
```

必须覆盖：

1. `project_get_context` 不存在时返回 version 0；
2. `project_put_context(expectedVersion=0)` -> version 1；
3. stale `expectedVersion=0` 再写一次必须失败；
4. 正确 `expectedVersion=1` -> version 2；
5. `handoff_publish` 的 `result.protocol` 不是 `zero3.pilot.execution-result.v1` 时必须拒绝；
6. `handoff_publish(taskId=A)` 但 `result.task_id=B` 时必须拒绝；
7. 正确 handoff 可通过 `handoff_get` 读取；
8. state 文件只位于 `ZERO3_PROJECT_CONTEXT_DIR`，没有认证 token/cookie/chat transcript。

当前 MCP 还未默认打包进 Desktop；本步骤验证 server implementation，不得因此宣称“packaged Codex MCP wiring PASS”。

---

## 4. 启动 Zero3 Desktop

```powershell
cd ..\..\apps\zero3-desktop
npm run dev
```

记录启动日志：

```text
Codex app-server started = yes/no
Remote Host started = yes/no
Renderer booted = yes/no
GPT Web provider IPC available = yes/no
```

---

## 5. 新建会话 Provider Picker

点击左侧原“新建会话”。

期望出现：

```text
新建会话

🌐 GPT Web
真实 ChatGPT 网页，会话与网页端同步

Codex Local
本地代码开发、命令、测试与真实性执行
```

分别验证：

### Codex Local

- 选择后进入现有 Codex 新 Thread 流程；
- 不出现第二个 Agent runtime；
- 原 Codex sidebar/history/turn 逻辑不回归。

### GPT Web

- 选择后中心主聊天区域被真实 ChatGPT WebContentsView 覆盖；
- Zero3 左侧栏仍可见；
- 不打开 iframe；
- 页面真实来源是 `https://chatgpt.com/`。

---

## 6. ChatGPT 登录与 Browser Profile 持久化

首次登录 ChatGPT。

必须验证：

1. 登录流程可完成；
2. OAuth/登录提供商页面可正常跳转；
3. 登录期间 Zero3 的 `workspace-entries-v1.json` **不得**保存 OAuth provider URL、authorization code、access token；
4. 登录成功后返回 `chatgpt.com`；
5. 关闭 Zero3；
6. 重新启动；
7. 再次打开 GPT Web 时登录态仍存在；
8. 不要求复用系统 Chrome Cookie；
9. 浏览器 profile 与系统 Chrome/Edge 独立。

如果某种 OAuth provider 拒绝 embedded user-agent：记录 provider / 错误页面，使用 `openExternal` fallback 验证，不要绕过认证安全策略。

---

## 7. GPT Web 会话 URL / Title / 左栏绑定

在 GPT Web 中新建真实 ChatGPT 会话并发送消息。

期望：

```text
chatgpt.com/
→ chatgpt.com/c/<conversation-id>
```

验证：

1. `/c/<id>` 被自动记录为 `conversationUrl`；
2. 页面标题稳定后同步到 Zero3 左侧栏；
3. GPT Web 条目前显示蓝色 globe/internet 图标；
4. generic title `ChatGPT` / `New chat` 不覆盖已有有效标题；
5. 点击 GPT Web 条目可恢复同一 conversation；
6. 点击 Codex 会话后 GPT native view 被隐藏；
7. 再点 GPT Web 会话可重新显示；
8. resize / maximize / sidebar resize 时 native view bounds 不漂移；
9. GPT Web 内容不覆盖 Zero3 左侧栏；
10. 至少切换 GPT ↔ Codex 20 次，不出现 native view 残留/双层遮挡。

---

## 8. Browser 安全边界

验证：

- Zero3 metadata 只持久化 `chatgpt.com` URL；
- OAuth URL 不进入 workspace entry file；
- 非 HTTPS 主导航被阻止；
- popup/nested popup 不获得 Node integration；
- renderer 无 `nodeIntegration`；
- `contextIsolation=true`；
- browser permission 默认 fail-closed；
- Zero3 没有读取/输出 ChatGPT Cookie / access token；
- 没有依赖 ChatGPT DOM selector 或私有 backend API。

同时测试普通 ChatGPT 文本输入、复制、附件入口等基础操作是否受默认 permission gate 影响；若功能受损，记录实际 permission 类型后再做最小 allow-list，不得直接改成 allow-all。

---

## 9. Workspace Entry 持久化

创建至少：

```text
GPT Web A
GPT Web B
GPT Web C
GPT Web D
Codex Thread A
Codex Thread B
```

验证：

- GPT Web 共享一个登录 profile；
- conversation URL/title 各自独立；
- 重启后 entry 可恢复；
- 同时 live GPT Web view 不超过 3 个；
- 被 suspend 的 entry 再打开时从持久化 URL 恢复；
- entry store 并发更新没有丢数据；
- store 文件格式有效、无临时文件残留。

---

## 10. Codex-authoritative Git Preflight

准备测试 Git 仓库/分支。

通过 Remote Task 触发：

### Case A — 正确 base

```text
base_ref == workspace HEAD
require_clean_worktree=true
```

期望：

```text
remote.git.preflight
repository_root = real repo root
head_commit = real HEAD
base_commit = requested base
clean_worktree = true
```

### Case B — base mismatch

期望任务 `BLOCKED`，不得启动重复 Codex Turn。

### Case C — dirty worktree

制造一个未提交文件：

```powershell
'dirty' | Out-File zero3-dirty-test.txt
```

`require_clean_worktree=true` 时必须 `BLOCKED`。

清理测试文件后继续。

### Case D — 非 Git workspace

应 fail-closed，不得假装验证成功。

确认所有 Git 查询由：

```text
pinned Codex App Server command/exec
```

完成，而不是 Node `child_process` 建立第二套 shell authority。

---

## 11. ExecutionResult / Git Postflight

运行一个允许完成的 Remote Task。

必须得到：

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

当开启：

```text
require_clean_worktree_on_success=true
```

Codex 完成但留下 dirty tree 时，Completion Gate 必须阻止 `succeeded`。

当开启：

```text
require_remote_sync_on_success=true
```

必须验证：

```text
HEAD == @{upstream}
```

否则任务不得标记 `succeeded`。

注意：当前 `handoff.required_evidence` 的 named-evidence enforcement 尚未封口，不得将本步骤扩大成“全量 Completion Gate PASS”。

---

## 12. H5 Control Plane 兼容性

当前 Host 端已支持可选：

```text
project_context
handoff
```

但 `apps/web` H5 typed `RemoteTask` schema 尚未演进。

因此当前必须验证：

- legacy `zero3.pilot.remote-task.v1` 核心字段仍正常；
- 不依赖新增可选字段穿透 H5；
- 若发送新增字段，确认当前 H5 是否丢弃，并把结果记录为已知 `BLOCKER`；
- 在 H5 schema-preservation 修复前，不能宣称 GPT Web → structured context/handoff 完整闭环 PASS。

---

## 13. 六路并行隔离

最后一次集成验收使用 6 个独立 Git worktree / Codex Thread：

```text
P12
P13
P14
P15
P16
P17
```

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

- workspace 不串；
- branch 不串；
- Codex Thread 不串；
- Turn/event 不串；
- evidence 不串；
- task mapping 不串；
- base SHA gate 独立；
- dirty worktree gate 独立；
- 一个任务失败不把其他 5 路误标失败/成功。

---

## 14. Windows 打包验证

在 dev 验证通过后执行：

```powershell
cd apps/zero3-desktop
npm run dist:win
```

验证安装包：

- 能启动；
- pinned Codex 可找到；
- GPT Web Provider 可创建；
- Browser Profile 重启后持久化；
- overlay runtime 源文件包含在最终应用；
- 不依赖用户全局安装 Codex；
- 当前 MCP server 未正式 bundle 时，应明确显示/记录为未接线能力，而不是静默假装存在。

---

# 最终回传格式

请将结果写成：

```text
TESTED_HEAD:
WINDOWS_VERSION:
NODE_VERSION:
ELECTRON_VERSION:
CODEX_PIN:

A. prepare/typecheck/codex overlay
PASS/FAIL + evidence

B. GPT Web login/profile
PASS/FAIL + evidence

C. URL/title/sidebar
PASS/FAIL + evidence

D. GPT/Codex switch
PASS/FAIL + evidence

E. Git preflight/postflight
PASS/FAIL + evidence

F. ExecutionResult
PASS/FAIL + evidence

G. MCP server implementation
PASS/FAIL + evidence

H. H5 optional-field preservation
PASS/FAIL/BLOCKED + evidence

I. 6-way isolation
PASS/FAIL/BLOCKED + evidence

J. dist:win
PASS/FAIL + evidence

BLOCKERS:
- ...

FINAL:
PASS / FAIL / BLOCKED
```

只有所有必需项具有真实证据后，PR #77 才能从 Draft 转 Ready / 合并。

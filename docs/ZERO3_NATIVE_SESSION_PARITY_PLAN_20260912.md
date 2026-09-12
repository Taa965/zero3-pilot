# Zero3 本体会话能力对齐施工方案（P0–P2）

> 目标：Zero3 本体会话 = 锁定开源 Codex 内核 + 用户自己的模型 API 配置，能力**不得低于**直接用
> `codex` CLI/TUI 配置模型 API。Zero3 的差异只允许出现在外层编排（记忆、Provider 切换、任务/工作组、
> 远程节点、UI 形态），不允许出现在内核能力、协议面、启动环境或配置表达力上。
>
> 适用范围：`apps/zero3-desktop`（Zero3 桌面本体）与其唯一的 Agent Kernel
> `upstream/codex`（pin `94311d447587411789533c47601fd8bc9d81eb48`）。
>
> 基线日期：2026-09-12。本文件是施工手册，不是调研报告：每个任务都给出改动文件、接口、步骤、测试、验收与回滚。

---

## 0. 验收基线：什么叫"不低于裸 Codex"

### 0.1 B-Line（等价基线）定义

设 `A` = 在**同一内核 pin、同一 `CODEX_HOME` 配置、同一启动环境**下，用户用 `codex` CLI/TUI 能完成的动作集合；
`B` = 在 Zero3 本体会话里能完成的动作集合。

验收要求：`A ⊆ B`。`B \ A` 只允许是 Zero3 的**增值能力**（共享记忆、Provider 切换与 handoff、任务/工作组、
远程节点、原生 UI 时间线）。任何 `A \ B` 都必须作为缺陷处理，或在 `docs/CODEX_APPSERVER_CAPABILITY_MATRIX.md`
里登记为"明确不支持"，并满足：fail-closed、UI 明示、有原因、有替代路径。

### 0.2 六条不变量（后续所有改动都必须保持）

| 编号 | 不变量 | 判定方式 |
| --- | --- | --- |
| I1 | 唯一内核：agent 行为只能由 pinned `codex app-server` 执行，Zero3 不实现第二套执行语义 | 架构守卫：全仓只允许一个进程入口 spawn `app-server` |
| I2 | 环境一致：内核环境 = 用户环境 + 显式白名单追加 − 显式且有测试与文档的移除 | `kernel doctor` + env 派生单元测试（平台矩阵） |
| I3 | 配置一致：用户在官方 Codex 能表达的配置，在 Zero3 内核里也能表达 | `config/read` 往返 + 配置面板覆盖测试 |
| I4 | 协议不遗漏：每个 app-server 方法都有三态记录（已接 / 计划 / 明确不支持） | 矩阵文件与协议 schema 自动比对，缺项即失败 |
| I5 | 无静默降级：不支持的能力必须 fail-closed 且 UI 明示，禁止"看起来能用其实丢语义" | parity smoke + 负向测试 |
| I6 | 结果可验证：等价性由 CI 上的 parity 用例集持续证明 | `zero3-kernel-parity` workflow 必须常绿 |

---

## 1. 现状审计（2026-09-12，含证据）

### 1.1 已完成的先导修复

| 项 | 内容 | 证据 |
| --- | --- | --- |
| Windows 内核环境 | 内核启动环境补 `PSExecutionPolicyPreference=Bypass`（Electron 主进程自身 + app-server 子进程 + Rust Codex worker），旧树由 overlay 原地升级 | commit `00408d7`、`apps/zero3-desktop/tests/windows-powershell-policy.test.cjs`、`docs/LOCAL_SESSION_TROUBLESHOOTING.md` |

这次修复暴露的是**结构性问题**：能力偏差来自"启动环境/配置面各自维护"，所以 P0 的核心就是把它变成契约。

### 1.2 app-server 协议面使用情况

pin 住的 app-server 协议里共有 **98** 个客户端方法（`upstream/codex/codex-rs/app-server-protocol/schema/json/ClientRequest.json`）。
Zero3 目前实际调用 **22** 个（含 `initialize`）：

```text
initialize
account/read                account/rateLimits/read
model/list                  modelProvider/capabilities/read
skills/list                 skills/config/write          skills/extraRoots/set
thread/start                thread/resume                thread/read
thread/list                 thread/turns/list            thread/fork
thread/archive              thread/unarchive             thread/delete
thread/name/set             thread/revert
turn/start                  turn/interrupt               turn/steer
command/exec
```

### 1.3 差距清单

| 层面 | 现状 | 差距 | 证据 |
| --- | --- | --- | --- |
| 内核配置 | 内核使用独立 `CODEX_HOME`（`Documents\Zero3 Pilot\codex`），仅通过 `skills/extraRoots/set` 挂载官方 `~/.codex/skills` | 用户 `config.toml` 的 `model_providers`、`mcp_servers`、`hooks`、`features`、`permissions`、`[windows] sandbox` 无法进入内核；`config/read`、`config/value/write`、`config/batchWrite`、`configRequirements/read` 未接 | `apps/zero3-desktop/scripts/apply-codex-skills.mjs:55-62`、`:294`；全仓无 `config/*` 调用 |
| 模型 API | 本体会话固定走 Zero3 本机桥：`model_providers.<id>.base_url=本机桥`、`wire_api=responses`，并显式 `request_max_retries=0`、`stream_max_retries=0` | 官方默认重试被关掉；用户 `config.toml` 里定义的 provider/profile 不能直接用；`approvalPolicy` 硬编码 `'never'`、`sandbox` 硬编码 `'danger-full-access'`（机器人通道 `read-only`） | `apps/zero3-desktop/scripts/apply-session-provider-runtime.mjs:1029-1037`、`:1375-1382` |
| 功能面 | 只用 22/98 方法 | 缺 `review/start`、`thread/compact/start`、`thread/goal/*`、`fs/*`、`fuzzyFileSearch`、`windowsSandbox/readiness|setupStart`、`account/usage/read`、`mcpServerStatus/list`、`mcpServer/tool/call`、`mcpServer/resource/read`、`mcpServer/oauth/login`、`config/mcpServer/reload`、`hooks/list`、`plugin/*`、`app/*`、`thread/rollback`、`thread/inject_items`、`thread/metadata/update`、`thread/items/list` | 1.2 节统计 |
| 输入面 | 两条会话面不一致：Codex 原生聊天面（R3C）已支持 `text` + `localImage`；Zero3 API 本体会话只发送 `[{ type: 'text', ... }]`，且字段写成 `textElements`（协议是 `text_elements`） | API 本体会话无图片/附件，裸 Codex 支持 `LocalImage` 与 `-i`；同一产品两套协议构造必然继续漂移 | `apply-session-provider-runtime.mjs:1413-1415` vs `scripts/apply-codex-structured-input.mjs:233-278` |
| 环境面 | 仅补了 PowerShell 策略一项 | 代理继承、`TMP/TEMP`、`PATHEXT`、`COMSPEC`、Windows 控制台编码、`[windows] sandbox` 语义均无统一契约与自检 | `docs/LOCAL_SESSION_TROUBLESHOOTING.md` |
| 架构面 | 5 处独立 Codex 客户端 + 1 处 Rust worker | 参数/环境/超时/错误处理各自维护，偏差必然重复出现 | `electron/main.ts`（内联 transport）、`executor-runtime/native/native-app-server-driver.ts`、`provider-usage-runtime/provider-usage.ts`、`project-link-runtime/native-projects.mjs`、`apply-session-provider-runtime.mjs`（`codex exec`）、`crates/zero3-subagents/src/workers.rs` |

---

## 2. 目标架构

```text
Zero3 Desktop（Hermes 派生 UI）
        |
        +-- 会话/任务/记忆/工作组/远程节点（Zero3 外层编排，B \ A）
        |
        v
   Zero3KernelClient   <- 唯一 app-server 客户端（进程、协议、超时、通知、server request、env、config）
        |
        +-- 环境契约（env_kernel = env_user + ADD − REMOVE(逐条有据)）
        +-- 配置分层（Zero3 托管层 < 用户层 < 会话层 override）
        +-- 能力矩阵 + parity gate（CI）
        |
        v
   pinned codex app-server   <- 唯一 Agent Kernel（A）
```

三条主线：

1. **收敛**（P0）：一个客户端、一份环境契约、一份配置分层。
2. **覆盖**（P1）：协议能力面接到 UI，默认值与官方一致，且可被用户选择。
3. **可验证与可移植**（P2）：配置面板、自检面板、导出与互通、矩阵与 CI 门常绿。

---

## 3. 工程与交付规则

- 每个任务 = 一个可独立回滚的 commit/批次；优先改 overlay generator（`apps/zero3-desktop/scripts/apply-*.mjs`）再重放生成树，
  禁止只改 `upstream/hermes-agent` 生成产物。
- fail-closed：锚点漂移、矩阵缺项、parity 失败一律抛错，不做静默降级。
- 结构性不变量写进 `scripts/check-architecture.mjs`（CI 的 `Codex-core architecture guard`）。
- 测试入口：`node --test apps/zero3-desktop/tests/*.test.cjs`（CI 在 Windows 上跑）+ 相关 runtime 单测 + 真实 app-server smoke。
- 需要 cargo 的验证走 `docs/WINDOWS-VERIFY.md` 的 Windows 验证通道。
- 交付物必须给出：BASE_SHA、HEAD_SHA、变更文件、验证证据、未执行项、迁移/回滚、风险。

---

## 4. P0：结构层（先做，做完再谈能力）

### P0-T1 单一内核客户端（One Kernel Client）

**问题**：5 处独立 Codex 客户端 + 1 处 Rust worker，各自维护参数、环境、超时与错误映射。

**目标**：新增 `apps/zero3-desktop/kernel-runtime/`（overlay 复制到 `electron/zero3/kernel/`），成为唯一 app-server 客户端。

**接口草案**

```ts
type Zero3KernelRequestOptions = { timeoutMs?: number; signal?: AbortSignal }
type Zero3KernelLaunch = {
  binary: string          // 必须是 pinned 构建（ZERO3_CODEX_BIN）
  cwd: string
  env: NodeJS.ProcessEnv  // 由环境契约派生，调用方不得自带 env
  configOverrides?: Record<string, unknown>
}
export class Zero3KernelClient {
  start(): Promise<Zero3KernelStatus>
  stop(reason?: string): void
  request<T>(method: string, params: unknown, options?: Zero3KernelRequestOptions): Promise<T>
  subscribe(listener: (event: Zero3KernelEvent) => void): () => void
  status(): Zero3KernelStatus
}
```

**迁移顺序（每步独立可回滚）**

1. `provider-usage-runtime/provider-usage.ts` 改用 client（只读 `account/read`、`account/rateLimits/read`）。
2. `project-link-runtime/native-projects.mjs` 改用 client。
3. `executor-runtime/native/native-app-server-driver.ts` 收敛为 client 之上的薄封装。
4. `electron/main.ts` 内联 `Zero3CodexAppServer` 改为 client 的调用方（IPC 与事件桥接语义不变）。
5. `apply-session-provider-runtime.mjs` 的 `codex exec` 保留为外部协作目标，但其环境必须来自同一份契约。
6. `crates/zero3-subagents/src/workers.rs` 的 Codex worker 复用同一组环境条目（已含 `PSExecutionPolicyPreference`）。

**测试**：协议编解码/超时/错误映射单测；真实 app-server `initialize` + `thread/start` smoke；守卫断言除 `kernel-runtime` 外无 `app-server` spawn。

**验收**：`rg -n "app-server"` 只命中 `kernel-runtime` 与 smoke 脚本；既有测试全绿；主聊天、本体会话、额度、项目绑定行为不变。

**风险/回滚**：接入期用 `ZERO3_KERNEL_CLIENT=1` 逐路径切换，旧实现保留一个版本后删除。

### P0-T2 启动环境契约（Kernel Environment Contract）

**目标**：把"内核环境"写成代码契约 + 自检，消灭"官方能跑、Zero3 不能"这一类缺陷。

**契约**

```text
env_kernel = env_user
  + ADD(白名单，必须有理由注释)
  − REMOVE(必须逐条有理由 + 测试 + 文档)
```

**ADD 清单（当前 + 待补）**

| 变量 | 现状 | 说明 |
| --- | --- | --- |
| `CODEX_HOME` | 已有 | Zero3 内核隔离目录 |
| `PSExecutionPolicyPreference` | 已有（win32） | PowerShell 进程作用域策略；组策略仍优先 |
| `NO_PROXY`/`no_proxy` | 已有（回环例外） | 用户显式值不覆盖 |
| 系统代理 `HTTP(S)_PROXY` | 待补 | 仅当用户未显式设置；解析失败不得静默直连 |
| `TMP`/`TEMP` | 待补 | 与官方一致，避免沙箱下写临时文件失败 |
| `PATHEXT`、`COMSPEC` | 待补 | Windows 命令解析一致性（app-server 已补 `PATHEXT`，仍需断言） |
| 编码相关（`PYTHONUTF8` 等） | 待补 | 中文路径/输出不乱码 |
| `[windows] sandbox` 语义 | 待补 | 与官方 `elevated` 沙箱可用性一致（含 `windowsSandbox/readiness`） |

**自检**：`kernel doctor`（产品内 + CLI）。检查项：内核二进制与 pin、`CODEX_HOME` 可写、环境条目、PowerShell 脚本执行
（`npm --version`）、代理连通、沙箱就绪、`config/read` 往返、skills 根可见、MCP 服务器状态、`model/list` 非空。
任一项失败都要输出"与官方差异"。

**测试**：env 派生纯函数平台矩阵单测；Windows 真实 spawn 断言（`powershell` .ps1 垫片、`npm`、`git`、`python`）。

### P0-T3 能力对齐矩阵 + parity 回归门

**产物**

- `docs/CODEX_APPSERVER_CAPABILITY_MATRIX.md`：由 `tools/parity/matrix.mjs` 从协议 schema + 代码扫描生成，
  每行 = 方法 / Zero3 状态（`wired|planned|unsupported`）/ 触碰文件 / 守卫测试 / 备注。
- `tools/parity/run.mjs`：同一组 case 分别在"裸 codex（同一配置）"与"Zero3 kernel client"上执行并比对。
- `.github/workflows/zero3-kernel-parity.yml`：ubuntu + windows 双跑，失败即拦。

**parity case 清单（首版 ≥ 18 条）**

| # | case | 判定 |
| --- | --- | --- |
| 1 | `npm --version`（.ps1 垫片） | 两边都成功（今天这类环境缺陷的兜底） |
| 2 | 写文件并读回 | 文件内容与路径一致 |
| 3 | `apply_patch` 修改 | 补丁语义一致 |
| 4 | git 状态/提交 | 输出与退出码一致 |
| 5 | 长命令流式输出 | 有增量 `item/commandExecution/outputDelta` |
| 6 | 中断运行中的 turn | `turn/interrupt` 后状态一致 |
| 7 | 图片输入 | 内核收到 `localImage`，不报不支持 |
| 8 | MCP 工具调用 | `mcpToolCall` 事件两端一致 |
| 9 | Skill 调用 | skill 可列出并可调用 |
| 10 | 审批（on-request） | 触发 `item/commandExecution/requestApproval` 并可应答 |
| 11 | 只读沙箱拒绝写 | 拒绝语义一致，不静默成功 |
| 12 | `thread/compact/start` | 压缩后仍可继续 turn |
| 13 | `thread/revert` | 还原到指定 turn |
| 14 | 会话恢复 | 重启后可 `thread/resume` 并读回结构化历史 |
| 15 | `model/list` 元数据 | 模型/effort/serviceTier 元数据完整 |
| 16 | 上游错误透传 | HTTP 状态与错误体要点可见，不吞错 |
| 17 | 编码与中文路径 | 输出不乱码 |
| 18 | 配置往返 | `config/read` 能看到用户配置项 |

**验收**：矩阵 100% 有状态；18/18 绿；`unsupported` 必须带原因与替代路径，并进入 `expected-unsupported.json`
白名单（含复核日期）。

---

## 5. P1：能力面覆盖

### P1-T1 会话内选择权（不再硬编码）

- 数据：`Runtime Binding` 增加 `approvalPolicy`、`sandbox`、`permissionProfile`、`features[]`、`modelProvider`。
- 代码：移除 `apply-session-provider-runtime.mjs` 中 `approvalPolicy:'never'`、`sandbox:'danger-full-access'` 的硬编码，
  改为会话级配置；默认取用户 `config.toml`，无配置时用官方推荐 `on-request` + `workspace-write`。
- UI：`ui-v2/conversations/Zero3NativeConversationSurface.tsx` 与 `CodexConversationSurface.tsx` 统一"运行配置"栏，
  切换即时反映到下一 turn 的 override，并在时间线提示"本轮生效"。
- 测试：`thread/start|resume` override 断言；审批事件端到端；写权限 gate 与 writer 状态机交互。

### P1-T2 高频内核能力接入

| 方法 | UI 位置 | 说明 |
| --- | --- | --- |
| `review/start` | 会话工具条 / 命令面板 | 代码评审 |
| `thread/compact/start` | 会话工具条（上下文压力提示） | 长会话手动压缩 |
| `thread/goal/get|set|clear` | 会话头部"目标" | 目标持久化 |
| `thread/rollback`、`thread/inject_items`、`thread/metadata/update`、`thread/items/list` | 会话操作菜单 | 会话语义补齐 |
| `fs/*`、`fuzzyFileSearch` | 文件选择/引用、@ 提及 | 编辑器级文件能力 |
| `windowsSandbox/readiness|setupStart` | 设置 → 沙箱 | 官方 elevated 沙箱准备 |
| `account/usage/read`、`account/rateLimits/read` | 状态栏 / 设置 | 与现有 provider-usage 合并去重 |
| `experimentalFeature/list|enablement/set` | 设置 → 高级 | feature flag 对齐 |
| `permissionProfile/list` | 运行配置栏 | 命名权限 profile |

每条都要求：`thread/start|resume` 参数正确、UI 入口可见、失败 fail-closed、有守卫测试。

### P1-T3 MCP 一等公民

- 接入：`mcpServerStatus/list`、`mcpServer/tool/call`、`mcpServer/resource/read`、`mcpServer/oauth/login`、`config/mcpServer/reload`。
- UI：MCP 面板（服务器/工具/状态/授权/重载）；时间线中 `mcpToolCall` 可展开参数与结果。
- 兼容：现有 `mcp-runtime/project-context-*` 与项目 `.codex/config.toml` 注入保持可用，统一走 `config/mcpServer*` 入口。
- 测试：状态列表、工具调用、OAuth 登录分支、重载后工具可见性。

### P1-T4 输入面：图片 / 附件 / 文件引用

- 协议：`turn/start` input 支持 `text` + `localImage`（+ `skill`），修正 `text_elements` 字段名。
- 统一：API 本体会话复用 R3C 已落地的严格校验输入构造（`scripts/apply-codex-structured-input.mjs`），不再各写一套。
- UI：粘贴截图、拖拽文件、选择文件；类型与大小白名单；失败给明确原因（不静默丢附件）。
- 测试：payload 断言 + 真实 turn（图片路径进入内核）+ 超限拒绝。

### P1-T5 provider 直连与重试策略

- 标准 API（`openai_compatible` / `anthropic` / `google_gemini`）：直接生成 `model_providers`（`base_url`、密钥来源、
  `wire_api`、默认重试），让 Codex 自带客户端直连；恢复 `request_max_retries` / `stream_max_retries` 默认值（可按 profile 配置）。
- 本机桥降级为"网页后端 / 私有协议"专用（GPT-Web、Gemini-Web 等），并在 UI 标注降级点（工具、图片、usage、流式）。
- 测试：直连与桥两条路径的 parity case 一致；重试行为（429/5xx）可观察。

---

## 6. P2：一致性、可移植与长尾

### P2-T1 Codex 配置面板与用户配置继承

- 接入 `config/read`、`config/value/write`、`config/batchWrite`、`configRequirements/read`。
- 分层：`Zero3 托管层 < 用户层（~/.codex/config.toml，只读继承或一键导入）< 会话层 override`；冲突在 UI 明示。
- UI：设置 → Codex 配置（provider/model/approval/sandbox/permissions/features/MCP/hooks/`[windows] sandbox`）。
- 迁移：默认不搬用户数据；只做配置合并，并附"导入官方配置"按钮与差异预览。

### P2-T2 可移植与互通

- 一键"用官方 Codex 打开此项目/线程"（同配置、同 cwd）。
- 导出：`CODEX_HOME` 视图、会话 JSONL（结构化事件）、线程导出。

### P2-T3 产品内"内核自检"面板

- 把 P0-T2 的 doctor 与 P0-T3 的 parity 差异做成 UI，直接显示"与官方 Codex 的差异项"，作为排障入口。

### P2-T4 插件 / 市场 / 应用 / hooks 面

- `plugin/list|read|install|uninstall`、`marketplace/*`、`app/list|read|installed`、`hooks/list`。
- 这是官方用户能力的重要来源（连接器、扩展），按使用频率分批接入。

### P2-T5 增值能力边界固化

- 记忆、Provider 切换、handoff、任务编排、远程节点只做外层；写入守卫与文档，禁止用"定制"替换内核语义。
- 与 `docs/ZERO3_NATIVE_CONVERSATION_REBUILD_PLAN_20260912.md` 的 Phase E–H 保持同一套 authority 规则。

---

## 7. 测试矩阵

| 层级 | 范围 | 入口 | 要求 |
| --- | --- | --- | --- |
| 单元 | env 派生、配置分层、参数构造、错误映射、矩阵生成 | `apps/zero3-desktop/kernel-runtime/*.test.ts`、`apps/zero3-desktop/tests/*.test.cjs` | 平台矩阵（win32/darwin/linux） |
| 集成 | 真实 app-server：initialize → thread → turn → 中断 → 恢复 | `apps/zero3-desktop/scripts/smoke-codex-*.mjs` 扩展 | Windows + Linux 双跑 |
| parity | 18 条 case 两边比对 | `tools/parity/run.mjs` | CI 门，禁止无理由 skip |
| UI | 运行配置栏、审批对话、MCP 面板、图片输入、自检面板 | `ui-v2/**` + `task-workspace.browser.mjs` 模式 | 真实组件测试，不 mock 协议 |
| 守卫 | I1–I5 的结构不变量 | `scripts/check-architecture.mjs` + 新守卫脚本 | 缺项即失败 |
| Rust | Codex worker 环境条目 | `cargo test -p zero3-subagents` | 经 Windows 验证通道 |

---

## 8. CI 与守卫变更清单

| 变更 | 文件 | 说明 |
| --- | --- | --- |
| parity workflow | `.github/workflows/zero3-kernel-parity.yml`（新增） | ubuntu + windows，跑 `tools/parity/run.mjs` |
| 架构守卫扩充 | `scripts/check-architecture.mjs` | 追加：唯一 client、env 契约函数、矩阵非空、无硬编码 approval/sandbox |
| 桌面测试 | `apps/zero3-desktop/tests/`（扩充） | 每个 P1 任务至少一组 fail-closed 断言 |
| 生成树 typecheck | CI 现有 `desktop-v3-hermes-build` | 保持 `tsc -p tsconfig.electron.json --noEmit` 通过 |

---

## 9. 迁移、兼容与回滚

- **生成树**：所有改动经 overlay generator 表达；旧树由 overlay 原地升级（沿用 `zero3CodexLaunchEnvironmentReplacement()` 的修复范式）。
- **行为开关**：`ZERO3_KERNEL_CLIENT`、`ZERO3_KERNEL_ENV_CONTRACT`、`ZERO3_DIRECT_PROVIDER` 默认关闭，逐路径启用后可回退。
- **配置继承**：默认只读继承用户配置；不做文件搬迁；冲突可回退到"Zero3 托管层"。
- **数据**：会话事件与线程 ID 不变；新增字段向后兼容（缺省时从用户配置或官方推荐值推导）。
- **回滚粒度**：按任务回滚，不跨任务；任何回滚都必须恢复 parity 绿。

---

## 10. 里程碑与批次

| 批次 | 内容 | DoD |
| --- | --- | --- |
| M1（P0） | P0-T1 单一 client（先迁 provider-usage / project-links） | 守卫通过；22 个已用方法行为不变；parity 骨架可跑 |
| M2（P0） | P0-T2 环境契约 + doctor + P0-T3 矩阵与 parity 门 | 18/18 绿；矩阵 100% 有状态 |
| M3（P1） | P1-T1 选择权 + P1-T2 高频能力 | 每项有 UI 入口与测试 |
| M4（P1） | P1-T3 MCP 面板 + P1-T4 输入面 + P1-T5 provider 直连 | MCP 端到端；图片输入真实成功 |
| M5（P2） | P2-T1 配置面板与继承 + P2-T3 自检面板 | `config/read` 往返；自检面板可解释差异 |
| M6（P2） | P2-T2 互通导出 + P2-T4 插件/市场/应用/hooks | 导出可被官方 Codex 打开 |

每批一个 PR：给出 BASE_SHA / HEAD_SHA / PR_URL / 变更文件 / 测试证据 / 未执行项 / 风险。

---

## 11. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 收敛 client 时丢失既有超时/错误语义 | 会话不稳定 | 按路径灰度迁移 + 行为对比测试 |
| 继承用户配置引入意外行为（如 `approval_policy`） | 安全/体验 | 只读继承 + 冲突面板 + 明确默认值 |
| provider 直连后网页后端能力对齐下降 | 部分 provider 能力差异 | 保留桥并标注降级点 + parity 覆盖 |
| 矩阵与守卫维护成本 | 长期漂移 | 矩阵自动生成、`unsupported` 白名单带复核日期 |
| Windows 沙箱与代理差异 | 环境类缺陷复发 | doctor 面板 + Windows parity job 必跑 |

---

## 12. 完成标准（DoD）

- [ ] I1–I6 六条不变量都有 CI 守卫。
- [ ] app-server 只被 `kernel-runtime` 一处 spawn。
- [ ] 环境契约函数被所有 Codex 子进程复用，doctor 全绿。
- [ ] 98 个方法 100% 三态登记，`planned` 全部落地或降级为有理由的 `unsupported`。
- [ ] parity 18 条 case 常绿（ubuntu + windows）。
- [ ] 本体会话可配置 approval / sandbox / permission profile / feature / provider。
- [ ] `review/start`、`thread/compact/start`、MCP 面板、图片输入可用。
- [ ] `config/read` 能读到用户配置；配置面板可编辑并生效。
- [ ] 一键"用官方 Codex 打开"与内核自检面板可用。
- [ ] 文档同步：本文件、能力矩阵、`docs/LOCAL_SESSION_TROUBLESHOOTING.md`。

---

## 13. 待确认决策点

| 编号 | 决策 | 选项 | 建议 |
| --- | --- | --- | --- |
| D1 | 用户 `~/.codex/config.toml` 的处置 | 只读继承 / 一键导入 / 完全不继承 | 只读继承 + 冲突面板（默认继承，可回退） |
| D2 | 本体会话默认 approval/sandbox | `on-request` + `workspace-write` / 保持全权限 | 对齐官方推荐，全权限改为显式选择 |
| D3 | 标准 API 是否改直连 | 直连 / 保留桥 | 直连优先，桥留给网页后端 |
| D4 | MCP 与插件面优先级 | P1 全做 / MCP 先行 | MCP 进 P1，插件/市场放 P2 |
| D5 | provider-usage 与 project-links 是否并入 kernel client | 并入 / 保持独立 | 并入（否则 I1 无法守卫） |

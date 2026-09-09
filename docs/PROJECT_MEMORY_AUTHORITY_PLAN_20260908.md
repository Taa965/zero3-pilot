# Zero3 项目实体与记忆中枢 施工方案

日期：2026-09-08
范围：阶段一至阶段四（项目存储 → 本地记忆闭环 → 网页 MCP → Claude executor 与 failover）
状态：历史施工基线（下文保留 2026-09-08 原始核查）；共享记忆当前实现、部署与验收结果见 [2026-09-10 状态记录](SHARED_MEMORY_STATUS_20260910.md)。

---

## 0. 现状基线

本节全部结论均来自对当前 `main`（`e99f9d6`）的代码核查，不是推测。施工前若与实际不符，以代码为准并更新本节。

### 0.1 已经存在且已接入的

| 组件 | 位置 | 状态 |
|---|---|---|
| 项目上下文 MCP | `apps/zero3-desktop/mcp-runtime/project-context-server.mjs` | 已实现，已注册给 Codex |
| 交接协议 | 同上，`zero3.pilot.execution-result.v1` | 已实现 |
| Executor 契约与 failover 引擎 | `apps/zero3-desktop/executor-runtime/` | 已实现，有单测，已随 development-group bridge 拷入应用 |
| Agent 路由 | `apps/zero3-desktop/agent-routing-runtime/` | 已接入，目标仅 `CODEX` / `GEMINI` / `AUTO` |
| Web 会话存储 | `apps/zero3-desktop/workspace-runtime/workspace-entry-store.ts` | 已接入，entry 带 `projectId` |
| GPT 网页会话列表与视图 | `ui-v2/conversations/`、`gpt-web-runtime/` | 已接入（`e99f9d6`） |

`project-context-server.mjs` 暴露四个工具：

- `project_get_context(projectId)` — 读项目上下文快照
- `project_put_context(projectId, expectedVersion?, payload)` — 写，乐观并发
- `handoff_get(taskId)` — 读最近一次结构化执行结果
- `handoff_publish(taskId, expectedVersion?, result)` — 写

存储位于 `ZERO3_PROJECT_CONTEXT_DIR`（应用内为 `userData/zero3/project-context`），文件名是 `sha256(logicalId)`，单条上限 2 MiB，`PROJECT_SCHEMA_VERSION = 1`。

### 0.2 三个决定施工内容的关键事实

**事实 A — Codex 目前只能读，不能写项目记忆。**

`scripts/apply-project-context-mcp.mjs` 在 `thread/start` 时向 Codex 注入 MCP 配置，其中：

```js
enabled_tools: ['project_get_context', 'handoff_get']
default_tools_approval_mode: 'approve'
required: true
```

两个写工具（`project_put_context`、`handoff_publish`）**没有出现在白名单里**。所以"记忆互通"目前是单向的：Codex 能读，写不回去。阶段二的主要工作就是打开这一侧并处理随之而来的并发与审批问题。

**事实 B — Zero3 没有项目实体。**

`workspace-entry-store.ts` 里的 `projectId` 是一个不透明字符串（`optionalText(..., MAX_PROJECT_ID)`），存了不解释。仓库内没有任何项目的创建、存储或目录绑定代码。`ui-v2/projects/ProjectList.tsx` 是写死的 mock。

上游 Hermes 确有一等公民项目（`projects.db`、命名的多文件夹工作区、`projectRootCwd`），但它由 Hermes Python gateway 提供，而架构约束明确规定 Hermes 后端只是临时 UI 脚手架、任何 Zero3 能力不得依赖它（见 `scripts/run.mjs` 中的 R1A 注释）。**因此必须自建，不能接管。**

这一点决定了阶段顺序：`project_get_context(projectId)` 需要一个真实的 `projectId`，没有项目实体，记忆中枢没有主键，网页端也无从知道该读哪个项目。**项目存储不是 UI 功能，是记忆中枢的主键。**

**事实 C — failover 引擎已经能做"额度耗尽切换"，缺的是执行器实现。**

`executor-runtime/executor-types.ts` 定义了 `ExecutorFailureCode`，其中包含 `quota_exhausted`、`context_exhausted`、`budget_exhausted`。`executor-runtime/router/failover-controller.ts` 已实现 `switch` / `handoff` / `recover` 三类决策，其中 `context_lost` 与 `context_exhausted` 走 `HANDOFF_REQUIRED`（必须带上下文交接），`rate_limited` 等走 `RETRY_THEN_SWITCH`。

`failover-controller.test.ts` 里已有这样的用例：

```js
candidates: ['native', 'claude', 'api'], automaticFailover: true
// quota_exhausted → { type: 'switch', fromExecutorId: 'native', toExecutorId: 'claude', ... }
```

即"Claude 额度耗尽后切换"这个场景，**引擎侧已实现且有测试覆盖**。但 `claude` 在整个仓库中只出现在三个测试文件里，作为假想 executor id；没有真实实现，也没有注册到 `agent-routing-runtime` 的目标表（`Zero3AgentTarget` 只有 `CODEX | GEMINI | AUTO`）。

### 0.3 网页 GPT 侧的外部条件

已于 2026-09-08 核实 OpenAI 官方开发者文档（`developers.openai.com/api/docs/guides/developer-mode`）：

- Developer Mode 可用于 **Pro / Plus / Business / Enterprise / Education**
- 提供 **完整 MCP 客户端支持，read 与 write 皆可**，write 默认需要用户确认
- 文档未声明按档位的功能差异
- 远程 MCP 支持的传输为 **SSE 与 streaming HTTP**

**结论：无需为写回能力升级订阅。** 但社区存在 "Write actions blocked on custom MCP server（Business workspace）" 的报告，可能存在工作区级开关。**阶段三启动前必须先做一次十分钟实测**（见 3.0），不得依赖任何转述做采购决定。

需要特别指出：Zero3 现有的 `project-context-server.mjs` 使用 `serveStdio`，是 stdio 传输，只能被本机子进程连接。ChatGPT 网页端无法连接它。阶段三的工作量在于补一层传输，而非开关。

### 0.4 工程约定（每个阶段都适用）

**覆盖层不是幂等的。** `prepare-upstream.mjs` 的 apply 脚本在已 prepare 过的树上重跑会因锚点漂移而失败（典型报错：`apply-codex-transport.mjs` 找不到 `src/global.d.ts` 的锚点）。唯一正确的循环是：

```bash
cd apps/zero3-desktop && npm run reset && ZERO3_DESKTOP_ALREADY_PREPARED=1 npm run dev
```

`npm run reset` 会把 `upstream/hermes-agent` 硬重置回 pin，覆盖层由三个 prepare 脚本重新生成。`ui-v2/` 是未追踪的源目录，不受 reset 影响。

**源文件的权威位置是 `apps/zero3-desktop/`，不是 `upstream/`。** 在 `upstream/hermes-agent/apps/desktop/src/zero3-ui-v2/` 下直接改能立刻热更新，但下次 reset 就会丢。开发期可以手动 `cp` 过去取得热更新，但改动必须落回源目录。

**门禁：** 每阶段合入前 `ZERO3_DESKTOP_ALREADY_PREPARED=1 npm run typecheck` 必须通过（三个 tsconfig）。涉及 `executor-runtime/` 的改动还需跑其单测。

**提交：** 静态编译通过即提交合入 `main` 并推送，不留在特性分支。

---

## 阶段一：Zero3 项目实体

### 目标

建立 Zero3 自己的项目存储，使项目成为一等公民：有名字、绑定本地目录、可作为会话与记忆的归属主键。

### 为什么是第一步

`projectId` 是 `project_get_context` 的入参、是 workspace entry 的归属字段、是 failover 时任务上下文的定位符。后三个阶段全部以它为前提。在没有项目实体之前做任何记忆或路由工作，都会退化成给一个不存在的主键打补丁。

### 数据模型

```ts
type Zero3Project = {
  id: string                        // `project-${randomUUID()}`
  name: string                      // 用户可见名称
  rootPath: string                  // 绝对路径，必须是已存在的目录
  chatGptProjectUrl: string | null  // 可选，见阶段一附注
  createdAt: string
  lastActiveAt: string
}
```

`rootPath` 校验规则（fail-closed）：必须为绝对路径、必须存在、必须是目录；不存在或不可读时拒绝创建，不做静默回退。

### 存储

新增 `apps/zero3-desktop/workspace-runtime/project-store.ts`，**完全沿用 `workspace-entry-store.ts` 的持久化模式**：

- 单个 JSON 文件，位于 `userData/zero3/projects.json`
- 写入走临时文件 + `fs.rename` 原子替换
- 文件权限 `mode: 0o600`
- 读取时逐字段校验（`requiredText` / `optionalText` 风格），损坏字段拒绝而非猜测

不要引入数据库。当前规模下 JSON 文件足够，且与既有 store 保持一致，减少一套需要维护的持久化语义。

### IPC 与 preload

新增 `apps/zero3-desktop/scripts/apply-project-store.mjs`，遵循 `apply-workspace-entry-runtime.mjs` 的结构：

| IPC 通道 | preload 方法 | 签名 |
|---|---|---|
| `zero3:project:list` | `list` | `() => Promise<Zero3Project[]>` |
| `zero3:project:get` | `get` | `(request: { id: string }) => Promise<Zero3Project \| null>` |
| `zero3:project:create` | `create` | `(request: { name: string; rootPath: string }) => Promise<Zero3Project>` |
| `zero3:project:update` | `update` | `(request: { id: string; name?: string; chatGptProjectUrl?: string \| null }) => Promise<Zero3Project>` |
| `zero3:project:remove` | `remove` | `(request: { id: string }) => Promise<{ removed: boolean }>` |
| `zero3:project:pickDirectory` | `pickDirectory` | `() => Promise<string \| null>` |

暴露为 `window.zero3Project`。类型定义追加到 `global.d.ts` 的注入块中（与 `zero3Workspace` 同一位置）。

`pickDirectory` 走 Electron `dialog.showOpenDialog({ properties: ['openDirectory'] })`，在 main 进程执行；渲染进程不得自行拼路径。

**该 apply 脚本必须加入 `prepare-upstream.mjs` 的调用链**，位置在 `applyZero3WorkspaceEntryRuntime()` 之后（workspace entry 的 `projectId` 将引用它）。

### 渲染层改动

- `ui-v2/adapters/ProjectAdapter.ts`（新增）— 与 `WebWorkspaceAdapter` 同构，封装 `window.zero3Project`
- `ui-v2/projects/ProjectList.tsx` — 移除 mock，渲染真实项目；新增按钮走 `pickDirectory` → `create`
- `ui-v2/projects/ProjectWorkspace.tsx` — 显示当前项目的路径、会话数
- `ui-v2/shell/Zero3AppShell.tsx` — 新增 `activeProjectId` 状态，与既有的 `activeSessionId` / `provider` 并列
- `ui-v2/conversations/UnifiedSessionList.tsx` — 按 `activeProjectId` 过滤会话；过滤逻辑可参考 `gpt-web-ui/gpt-web-section.tsx` 中已有的 `visibleEntries` 实现
- 新建 GPT 会话时把 `activeProjectId` 传入 `zero3GptWeb.create({ projectId })`（参数已存在，当前传 `null`）

### 验收

1. 新建项目并选择本地目录，重启应用后项目仍在
2. 在项目 A 下新建的 GPT 会话，切到项目 B 时不出现在列表中
3. `rootPath` 传入不存在的路径时创建失败并给出可读错误，不产生半条记录
4. typecheck 通过
5. `npm run reset` 后重新 prepare，项目数据（在 userData 下，不在 upstream 内）不受影响

### 风险

| 风险 | 处置 |
|---|---|
| 与 Hermes 自身的项目概念在 UI 上并存造成混淆 | ui-v2 只呈现 Zero3 项目；Hermes 侧栏在 ui-v2 挂载后本就不可见 |
| `projectId` 历史值为 `null` 的既有会话 | 视为"未归属"，在列表中单独一组展示，不隐藏、不自动迁移 |

### 附注：`chatGptProjectUrl` 的用途

用于把 Zero3 项目与 ChatGPT 网页端的项目绑定，**不通过读取 ChatGPT 的 DOM 或调用其内部接口实现**。做法是：用户在视图内手动进入目标 ChatGPT 项目一次，Zero3 记录当时的 URL（provider 本就在记录 `currentUrl` / `conversationUrl`）；此后该 Zero3 项目下新建的 GPT 会话都从这个 URL 起步，自然落入同一个 ChatGPT 项目。

拒绝读取 DOM 的三条理由：与仓库既定原则冲突（`gpt-web-handoff-actions.tsx` 明确写有"不读取 ChatGPT DOM"）；ChatGPT 改版即失效（隐藏侧栏已经依赖了一个它的 id `#stage-slideover-sidebar`，这笔技术债不应加倍）；抓取第三方站点的账号数据存在服务条款风险。

---

## 阶段二：本地记忆闭环

### 目标

让 Codex 在项目内既能读也能写 `project_context`，使"上次做到哪里、为什么这么设计、有什么坑"沉淀到单一权威，而不是散落在 GitHub 或各自的会话历史里。

### 前置

阶段一完成（需要真实 `projectId`）。

### 核心改动：打开写工具

`scripts/apply-project-context-mcp.mjs` 中的注入配置改为：

```js
enabled_tools: [
  'project_get_context',
  'handoff_get',
  'project_put_context',   // 新增
  'handoff_publish'        // 新增
]
```

`default_tools_approval_mode` **保持 `'approve'`**。写入项目记忆是有副作用的操作，应当经过与文件写入同级的审批，不要为了顺畅而降级为自动放行。

### projectId 的传递

当前注入逻辑 `zero3WithProjectContextMcp(method, params)` 只在 `thread/start` 时追加 MCP 配置，不传递项目身份。需要扩展：Codex 线程启动时，把当前 `activeProjectId` 一并写入线程配置，使 agent 知道自己该读写哪个项目的上下文。

具体传递方式取决于 Codex app-server 对 `thread/start` 配置的接受形态，**施工前需先确认**：优先考虑通过 MCP server 的 `env` 传入（如 `ZERO3_ACTIVE_PROJECT_ID`），由 server 侧兜底校验；这样 agent 无法越权访问其他项目的上下文，比让 agent 自行填 `projectId` 更安全。

若采用 env 方案，`project-context-server.mjs` 需相应调整：当 `ZERO3_ACTIVE_PROJECT_ID` 存在时，拒绝对其他 `projectId` 的读写请求。这是一处 fail-closed 加固，建议一并做。

### 并发与冲突

`project_put_context` 已实现 `expectedVersion` 乐观并发控制。多 agent 同时写同一项目时会出现版本冲突，此时**不得静默重试覆盖**：应把冲突作为错误返回给 agent，由其重新读取后合并。这是该协议设计版本号的原因，绕过它等于放弃单一权威。

### 上下文结构

`payload` 当前是 `z.unknown()`，无结构约束。建议约定最小结构并写入文档（不强制 schema 校验，保留演进空间）：

```ts
{
  version: 1,
  decisions: Array<{ at: string; text: string; by: string }>,   // 已确认的决定
  currentFocus: string | null,                                  // 上次做到哪里
  pitfalls: Array<{ text: string; at: string }>,                // 踩过的坑
  glossary: Record<string, string>                              // 项目内术语
}
```

刻意不放代码结构、文件树、依赖关系——那些从仓库本身可以随时得到，写进记忆只会过期。记忆应当只存**从代码里读不出来的东西**。

### 验收

1. 在 Codex 会话中让其写入一条决策，审批通过后落盘
2. 新开一个 Codex 会话，能读到该决策
3. 并发写入产生版本冲突时返回错误而非静默覆盖
4. 越权访问（请求其他 `projectId`）被拒绝
5. `executor-runtime` 单测与 typecheck 通过

### 风险

| 风险 | 处置 |
|---|---|
| agent 把大量无关内容写进记忆导致 2 MiB 上限触顶 | 上限已在 server 侧强制；在上下文结构文档中明确"只存读不出来的东西" |
| 审批疲劳导致用户习惯性放行 | 保持 `approve` 模式，但控制写入频率——建议约定在会话结束或关键决策点写入，而非每轮 |

---

## 阶段三：网页 MCP 接入

### 目标

让 ChatGPT 网页端通过 MCP 读取（并在实测允许的前提下写入）同一份项目记忆，取消 GitHub 作为记忆同步通道的角色。

### 3.0 前置实测（必须先做，约十分钟）

在动任何代码前，用你自己的 Pro 账号验证一次：

1. 起一个最小 MCP server，暴露一个读工具和一个写工具，走 streaming HTTP
2. 通过任意隧道工具暴露到公网
3. 在 ChatGPT 网页 Developer Mode 中连接
4. 分别调用读工具与写工具

**只有第 4 步的写工具确实可用，才继续做本阶段的写入部分**；若写被拒，本阶段降级为只读接入，架构不变，写入等条件具备后再开。

不要跳过这一步。官方文档与社区报告存在不一致，实测是唯一可靠依据。

### 传输层

新增 `apps/zero3-desktop/mcp-runtime/project-context-http.mjs`：

- **复用** `project-context-server.mjs` 中的 `getProject` / `putProject` / `getHandoff` / `putHandoff` 及其校验逻辑——先将这些函数抽取为 `project-context-core.mjs`，两个传输层共用，避免两套实现漂移
- 传输采用 streaming HTTP（SSE 为备选），与 OpenAI 文档一致
- 监听地址默认 `127.0.0.1`，端口可配；**不直接监听 `0.0.0.0`**

### 鉴权（不可省略）

隧道 URL 会出现在日志、截图、剪贴板里，必须假定它会泄漏。

- 每个 endpoint 绑定一个高熵 bearer token，存于 `userData/zero3/mcp-http-token`，权限 `0o600`
- 所有请求校验 `Authorization: Bearer <token>`，失败返回 401 且不泄漏任何存在性信息
- 提供令牌轮换入口（UI 上一个"重置令牌"按钮即可）
- 记录访问日志：时间、工具名、projectId、结果，便于事后审计

### 出境白名单（不可省略）

这是整个方案里唯一会让数据离开本机的环节，必须显式控制。

- 项目级开关：默认**关闭**，用户逐项目显式开启"允许网页端访问此项目记忆"
- 字段级过滤：出境前剥离 `rootPath` 等本机路径信息；`decisions` / `pitfalls` / `glossary` 允许出境，其余默认不出
- UI 上必须能一眼看到哪些项目开着这个口子

**明确记录该决策的代价**：开启后，这些项目记忆将进入 OpenAI。这与 Zero3 现有的 fail-closed 姿态（凭据锁在 main、默认 read-only sandbox、只允许 chatgpt.com 导航、不读 ChatGPT DOM）存在张力。这不是技术问题，是取舍——本方案的立场是：**由用户逐项目显式开启，默认全关**，而不是做成全局开关一键放行。

### 隧道

OpenAI 侧若提供官方隧道机制则优先使用；否则任选一种隧道工具，方案不依赖具体实现。隧道只负责可达性，**安全性由上面的 bearer token 与白名单保证**，不得依赖"URL 难猜"。

### 验收

1. 3.0 实测结论已记录在案
2. 网页端能读到已开启项目的记忆
3. 未开启的项目，网页端请求返回空或拒绝，且不泄漏项目存在性
4. 无 token 或错误 token 一律 401
5. 出境内容中不含 `rootPath` 等本机路径
6. 令牌轮换后旧令牌立即失效

### 风险

| 风险 | 处置 |
|---|---|
| 隧道 URL 泄漏 | bearer token 强制；令牌可轮换；访问日志可审计 |
| 网页端写入污染本地权威 | 沿用 `expectedVersion` 乐观并发；网页写入建议单独标记来源，便于回溯 |
| OpenAI 侧策略变化导致连接失效 | 传输层与核心逻辑已分离，stdio 一侧不受影响，本地闭环仍然可用 |

---

## 阶段四：Claude executor 与 failover

### 目标

把 Claude 注册为可用执行器，使"某一方额度耗尽时自动切换到另一方并带上上下文"真正可用。

### 前置

阶段二完成。failover 的 `handoff` 分支依赖 `project_context` 与 `handoff_publish` 能写，否则切换过去的执行器拿不到上下文，只能从零开始——那不是交接，是重来。

### 引擎侧：无需改动

`failover-controller.ts` 已实现全部所需决策，`failover-controller.test.ts` 已覆盖 `quota_exhausted → switch` 到 `claude` 的场景。本阶段不修改引擎。

### 需要新增的

**1. Claude executor 实现**

新增 `executor-runtime/external/claude-executor.ts`，`ExecutorKind` 取 `'external-agent'`，实现 `Zero3Executor` 接口（参照 `native/native-codex-executor.ts`）。

关键在于**失败码映射**：必须把 Claude 侧的真实错误正确翻译为 `ExecutorFailureCode`，尤其区分：

- `quota_exhausted` — 额度耗尽，走 `switch`
- `rate_limited` — 限流，走 `RETRY_THEN_SWITCH`（先重试）
- `context_exhausted` — 上下文超限，走 `HANDOFF_REQUIRED`（必须带交接）

映射错了，failover 行为就是错的：把限流当额度耗尽会导致不必要的切换，把上下文超限当普通失败会导致切换后丢失全部上下文。这是本阶段最需要仔细做的部分，建议为映射函数单独写测试。

**2. 注册到路由表**

`agent-routing-runtime/agent-contracts.ts`：

```ts
export type Zero3AgentTarget = 'CODEX' | 'GEMINI' | 'CLAUDE' | 'AUTO'
```

`agent-router.ts` 中相应扩展 `providerState` / `autoEligible` / 偏好集合。当前 `GEMINI_PREFERRED` 为 `DESIGN|RESEARCH|REVIEW`，`CODEX_PREFERRED` 为 `IMPLEMENT|VERIFY|FIX|INTEGRATE`；Claude 的偏好类型需要产品决策，**未定，施工前确认**。

**3. 交接载荷**

切换时需将当前任务上下文写入 `handoff_publish`，新执行器启动时经 `handoff_get` 取回。`Zero3TaskSpecV2` / `Zero3ExecutionResultV2` 结构已存在，直接复用。

### 与现有人工交接的关系

`gpt-web-handoff-actions.tsx` 提供的"交给 Codex / 交给 Gemini"是人工填表的 Level-A fallback（Task ID、目标、worktree 路径全靠手填），它面向的是**网页 GPT 这种无法接入 executor 契约的会话**。本阶段完成后两者并存：

- 能接入 executor 契约的（Codex、Claude）走自动 failover
- 网页 GPT 仍走人工交接表单

网页 GPT 无法成为自动 failover 的目标，因为它没有可编程的任务提交与结果回传通道。这是产品事实，不是待办事项。**若阶段三的写入实测通过，网页 GPT 可以成为记忆的读写方，但仍不是执行器。** 这两件事需要分开理解。

### 验收

1. Claude 注册后出现在候选执行器列表中
2. 模拟 `quota_exhausted`，控制器产出 `switch` 决策并切换
3. 模拟 `context_exhausted`，控制器产出 `handoff` 决策，新执行器能经 `handoff_get` 取回上下文
4. 失败码映射有独立测试覆盖
5. `executor-runtime` 全部单测通过

### 风险

| 风险 | 处置 |
|---|---|
| 失败码映射错误导致误切换 | 映射函数单独测试；先以手动切换（`manualSwitch`）验证链路，再开自动 |
| 自动切换掩盖真实故障 | 保留 `automaticFailover` 开关；切换事件必须在 UI 上可见，不静默 |
| 两个执行器同时写同一 workspace | `handoff/workspace-lease.ts` 已有租约机制，接入时必须使用 |

---

## 跨阶段未决问题

以下问题施工前需要明确答复，**不要在实现中自行假设**：

1. **阶段二** — Codex `thread/start` 配置能否携带自定义 env 供 MCP server 读取？若不能，`projectId` 的安全传递方式需另定。
2. **阶段三** — 3.0 实测中，Pro 账号的自建 MCP 写工具是否真正可用？
3. **阶段四** — Claude 在 `Zero3TaskType` 上的偏好如何设定？是否参与 `AUTO` 路由，还是仅作为显式目标与 failover 候选？
4. **全局** — `memorix` 与 `zhipan` 两个 MCP server 当前均连接失败（`ConnectionRefused` / `CONNECTION_CLOSED`）。若它们计划作为记忆中枢的底层数据源，需先修复连接；本方案不依赖它们，`project-context` 自身的文件存储即可独立工作。

---

## 施工顺序总结

```
阶段一  项目实体          ← 唯一必经之路，后三个阶段的主键
   │
   ├─→ 阶段二  本地记忆闭环   （打开写工具 + projectId 安全传递）
   │      │
   │      ├─→ 阶段三  网页 MCP   （传输层 + 鉴权 + 出境白名单）
   │      │
   │      └─→ 阶段四  Claude executor（失败码映射 + 路由注册）
```

阶段三与阶段四都依赖阶段二，彼此之间无依赖，可并行。

**不要先做阶段三。** 本地闭环尚未跑通就开公网入口，等于把整条链路里最难的安全问题提到最前面，而此时能验证的收益最小。

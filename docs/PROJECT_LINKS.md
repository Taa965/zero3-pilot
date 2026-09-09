# Zero3 项目与应用项目关联

新建 Zero3 Pilot 项目后自动显示“关联应用项目”窗口。Codex、Claude Code、Antigravity 分别选择“关联已有项目”“创建并关联”或“暂不更改”；允许只关联其中一个应用。之后在项目总览的“关联的应用项目 → 管理关联”补充或修改。

## 各应用的实际行为

| 应用 | 已有项目来源 | 创建方式 | 后续会话 |
| --- | --- | --- | --- |
| Codex | 官方 CLI app-server `project/list`，支持多根目录选择 | `project/create`，传入名称、目录和幂等键 | CLI 使用关联目录；首次返回 thread ID 后，通过 `thread/metadata/update` 归入原生项目 |
| Claude Code | 用户 `.claude.json` 的目录项目，过滤失效目录并去重；也可手动选目录 | 官方 `claude mcp add-json --scope local` 建立目录项目的共享记忆配置 | Claude CLI 使用所选目录及其本地 MCP |
| Antigravity | `.gemini/config/projects/*.json` 的真实原生项目 ID | 官方 `agy --new-project` 初始化，不发送模型提示；确认唯一新增原生项目后保存关联，名称由应用生成 | 首次会话传 `--project` 和 `--add-dir`，恢复时使用原 conversation ID |

需先安装并登录相应官方 CLI；仅有网页账号并不能替代本地 CLI。可用 `ZERO3_CODEX_CLI_BIN`、`ZERO3_CLAUDE_BIN`、`ZERO3_ANTIGRAVITY_BIN` 指定安装路径。某个应用不可用时显示错误，其他已成功关联保留。

## 共享记忆及历史会话

关联保存在 `userData/zero3/project-links.sqlite`，不写入 Git。成功配置后，Zero3 目录及选定应用目录使用同一个 Zero3 项目 ID；全局 Codex MCP 优先读取这里的显式关联，因此未来新项目无需维护静态目录清单。

Codex 写入所选目录 `.codex/config.toml` 的独立标记段，Claude 使用官方本地 MCP 配置命令，Antigravity 写入 `.agents/mcp_config.json`。这些配置只含客户端路径与项目 ID，不含服务器令牌；已有其他 MCP 保留，同名冲突明确报错。连接凭据继续使用本机受保护的共享记忆配置。

关联不会导入或合并原应用的聊天记录、自动生成旧任务记忆，亦不会合并先前自动分配的记忆范围。正在进行的会话保存创建时的项目身份和目录；修改关联只影响新会话。历史关联目录及 ID 保留占用，避免旧会话被另一个 Zero3 项目接管；本轮没有提供解除历史占用或迁移历史数据的界面。

本机全局 Codex 独立 MCP 客户端也已更新。它与 Codex CLI 读取同一个映射和权威服务；当前已启动的 MCP 实例需重载一次。共享的是显式写入共享记忆服务的事实及交接内容，不是应用间实时复制全部聊天。

## 失败和重复操作

- 事务预先占用目录，拒绝不同 Zero3 项目覆盖同一目录或原生项目。
- 每个提供方有有期限的操作租约，重复点击不会重复创建。
- 已获得原生 ID 后配置失败，保留 ID，重试只安装配置。
- 创建结果无法确认时禁止盲目再创建；刷新后手动选择已创建项目恢复。
- 配置成功后才激活全局记忆映射；失败不会把目录切到错误记忆范围。
- Codex 项目归属更新暂时失败时保留模型回复，并在下次发送时重试。

## 2026-09-10 验收

- 14 项自动测试通过：真实 SQLite、文件配置保留、失败恢复、目录并发占用、自动范围优先级、CLI 协议、会话快照及 Antigravity 原生 ID 路由。
- 桌面三个 TypeScript 配置检查通过。
- 实际 Codex CLI 创建临时原生项目、列表读回及删除成功；未调用模型。
- Browser 中渲染实际弹窗组件，已有项目选择、部分失败提示及重试通过；使用模拟 IPC，不是 Electron 端到端验收。重试调用顺序为 `codex, claude, claude, antigravity`。
- 全局独立 MCP 客户端更新后六个工具发现成功，权威上下文 `stale:false`，跨范围读取隔离通过。
- Claude / Antigravity 创建协议及路由使用进程夹具验证；本轮未对真实账号执行创建验收，不把夹具结果表述为真实账号成功。

复验：

```powershell
node --test apps/zero3-desktop/project-link-runtime/*.test.mjs apps/zero3-desktop/memory-sync-runtime/workspace-scope.test.mjs apps/zero3-desktop/tests/project-link-sessions.test.cjs
$env:ZERO3_DESKTOP_ALREADY_PREPARED='1'
npm --prefix apps/zero3-desktop run typecheck
```

运行前须将桌面源码应用到已准备的 upstream 工作树。共享记忆 CI 已纳入项目关联运行时测试；本地会话测试还需桌面 TypeScript 依赖。

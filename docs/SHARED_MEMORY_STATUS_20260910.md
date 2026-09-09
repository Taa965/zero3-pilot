# 共享记忆：实现、部署与验收记录

日期：2026-09-10。本文取代旧施工方案中共享记忆的进度描述；协议边界仍以 [V2.1 契约](MEMORY_AUTHORITY_V2_1_CONTRACT.md) 为准。

## 结论与接手基线

项目／任务共享记忆的核心读写闭环已完成并部署到 AWS：Windows 发布事件，PostgreSQL 确认，网页侧通过 DC 插件在 AWS 读取到同一事件。离线队列、版本冲突、回放、任务交接以及桌面接入已完成实现和测试。

接手时已有事件协议、SQL 投影、Rust 服务和部分客户端代码，但 AWS 生产库没有事件、Windows 没有连接配置；回放与 SQLite 接线尚未完成。旧文档的“待施工”也没有反映这些已有成果。因此不以缺乏分母的百分比报告进度。

| 能力 | 当前状态 | 验收边界 |
| --- | --- | --- |
| PostgreSQL 事件权威与投影 | 已部署 | 幂等、版本检查、权限、任务隔离、稳定提交序号 |
| HTTP／WebSocket 服务 | 已实现 | HTTP 真实数据库联调；WebSocket 回放逻辑和客户端协议测试 |
| SQLite 离线同步 | 已接入 | 持久化队列、发送租约、分页回放、断线重试、明确冲突 |
| Codex 全局 MCP／Zero3 项目 MCP | 已安装并启用 | 用户追加授权后，所有现有及未来 Codex 工作区均可使用；各工作区自动选择自己的记忆范围 |
| 跨设备任务交接 | 已完成 | 两个独立客户端读取同一交接，拒绝旧版本覆盖 |
| 桌面项目“上下文”页 | 已实现、类型检查通过 | 配置导入、刷新、服务器内容、离线及队列状态；本轮未进行完整 GUI 点击验收 |
| 网页 GPT 经 DC 访问 | 已实测 | DC 选择 AWS 设备后运行下文 CLI，读到 Windows 发布的生产记录 |
| Windows 登录后自动连接 | 已获授权并安装 | 隐藏启动、单实例和断开自动重连已实测；不需要每次手动建立隧道 |
| 原生 ChatGPT Developer Mode MCP | 尚未验收 | 保留项目白名单、出站字段限制；共享模式下 HTTP 快照写入关闭 |
| GitHub Memory Inbox | 库及测试已有 | 本轮没有部署新的 webhook 接收服务，勿当作已上线入口 |
| 全提供方自动提炼／晋升记忆 | 不在本轮已完成声明中 | 已有治理契约；不会把提供方原生聊天记录自动当作项目事实 |

## 本轮补齐和修复

- 修复 Rust `tokio::select!` 编译错误，以及 PostgreSQL REAL 与 Rust 浮点转换。
- 使用数据库实际错误原因区分 409 版本／权威冲突和临时服务故障，避免错误无限重试。
- 迁移 007 在分配事件序号前取得事务锁，防止较大的已提交序号让客户端跳过尚未提交的小序号。
- 迁移 008 拒绝同一个事件 UUID 的不同内容，并把任务 ID 绑定到原项目，避免任务投影跨项目混用。
- 读取投影和实体版本使用一致性事务；上下文返回 `entities`，事件回放保留 `expected_entity_version`。
- 校验事件标识、时间、类型、范围、权威、载荷，并对整个事件扫描凭据字段。
- SQLite 使用事务领取发送批次，进程专属租约避免多个 MCP 互相抢占；批次控制在约 1.5 MiB。
- 分页回放等待本地持久化后再确认，严格限制项目与序号；混合批次中的失败不会吞掉后续成功项。
- 服务地址必须为 HTTPS 或 loopback HTTP，不跟随重定向；认证拒绝不会回退暴露缓存。
- 共享配置启用时，项目 MCP 提供事件发布与同步状态，任务交接也进入共享事件；本地快照替换工具不再用于该项目。
- 新增真实 PostgreSQL 持续集成工作流，覆盖迁移、并发、服务和独立客户端交接。

## 生产部署

- 主机：`ubuntu@34.218.104.186`。
- 服务：`zero3-memory-authority.service`，用户 `zero3memory`。
- 数据库：`zero3_memory`，PostgreSQL 14，现有 vector 扩展。
- 服务只绑定 `127.0.0.1:8791`。Pilot Node 继续使用 8790。
- 生产版本：`/opt/zero3-memory-runtime/releases/shared-20260910-48c2172a1526`。
- 当前链接：`/opt/zero3-memory-runtime/current`。
- 升级前备份：`/var/backups/zero3-memory/shared-20260910-48c2172a1526`，包含数据库 dump、原配置和上一版本路径。
- 服务端凭据配置：`/etc/zero3-memory/authority.env`。此文件不可提交或复制到聊天。
- 新增 Windows 与网页 DC 两份独立项目级授权，最高 agent authority 60；既有授权保持原样。
- 初次验收仅启用 Zero3 项目。用户随后明确要求覆盖整个 Codex，包括未来所有项目和会话；Windows 授权已扩展为 `projects: ["*"]`，最高权威仍为 60。网页 DC 的独立授权保持原项目范围。

生产验收事件 `1408387c-2386-4ae9-96fe-065e2fb65d3b` 由 Windows 发布，服务器序号为 **1**，状态 `acked`。随后通过实际 DC 插件，在 AWS 设备读取到了该事件，返回 `sync.stale: false`。记录属于验收任务 `shared-memory-acceptance-20260910`，明确标记为连接验收，不作为业务决定。任务事件不会增加项目投影版本，因此该次返回项目版本 0 正常。

## 如何使用

### 网页 GPT／DC（已经可用）

在 DC 中选择 AWS 设备 `6b11dcaa-1e6d-42c3-9b7a-261932eabe51`（`ip-172-26-3-97`），运行：

```sh
/home/ubuntu/.local/node-v22.22.2/bin/node \
  /home/ubuntu/.local/share/zero3-memory/client-20260910/apps/zero3-desktop/memory-sync-runtime/memory-cli.mjs \
  --project project-487b390b-ddf6-4a26-b47d-b8758a244e13 get
```

最后的 `get` 可以替换为 `status`、`handoff TASK_ID` 或 `publish /absolute/path/event.json`。发布文件遵循 `schemas/zero3.memory.event.v1.schema.json`，新实体的 `expected_entity_version` 为 0，更新时先读取 `entities` 中对应实体的 `version`。重试相同事件必须保留完整原始事件，包括 UUID 和时间。

云端默认配置已放在 `/home/ubuntu/.config/zero3/shared-memory.json`，仅所属用户可读。不需要把令牌发送给 GPT。系统自带 Node 太旧，必须使用上面的现有 Node 22 路径（客户端依赖 `node:sqlite`）。

### Windows／Zero3 Desktop

桌面源代码已接入“项目 → 上下文 → 共享记忆”。重启更新后的应用并导入连接配置后，新开的项目 AI 会话使用同一权威服务。已有会话需要重新打开才能取得新的 MCP 配置。

默认配置位置为应用 `userData/zero3/shared-memory.json`；本机为 `C:\Users\Laaa\Documents\Zero3 Pilot\zero3\shared-memory.json`。也可通过 `ZERO3_SHARED_MEMORY_CONFIG` 指定绝对路径。配置格式：

```json
{
  "baseUrl": "http://127.0.0.1:8792",
  "token": "<单独发放的项目令牌>",
  "clientId": "pilot-windows-zero3-project",
  "deviceId": "windows-zero3",
  "projects": ["*"],
  "cacheDir": "C:\\Users\\Laaa\\Documents\\Zero3 Pilot\\zero3\\shared-memory-cache"
}
```

Windows 的 8792 通过 SSH 转发到 AWS loopback 8791。用户已经明确授权保存凭据和登录自动连接，安装结果：

- 凭据与独立客户端目录：`C:\Users\Laaa\Documents\Zero3 Pilot\zero3\memory-transport`。
- SSH 私钥副本、连接 JSON、缓存目录均设置为仅当前 Windows 用户拥有访问权限；原始 SSH 密钥文件保持原样。
- 用户启动文件夹中的 `Zero3 Shared Memory.lnk` 启动隐藏 PowerShell，再运行该目录内的 `start-memory-tunnel.ps1`。仓库保留可审查的同名源码。
- 固定 SSH 主机密钥、仅监听 loopback 8792；每次连接退出后间隔 30 秒重试，互斥锁防止重复运行。
- 修复含空格路径的双层引用问题，确保 `Zero3 Pilot` 目录中的 known_hosts 真正被 OpenSSH 读取。
- 已实测快捷方式参数、重复启动退出，以及中断唯一 SSH 子进程后自动恢复 `/ready`。
- 配置备份保存在受保护的 `memory-transport` 目录，服务器授权变更前备份为 `/etc/zero3-memory/authority.before-codex-global-20260910.env`。

### Codex 全局配置与自动项目范围

已在 `C:\Users\Laaa\.codex\config.toml` 注册 `mcp_servers.zero3_shared_memory`，使用独立客户端，不依赖当前仓库的 node_modules 或运行中的 Zero3 Desktop。配置采用 [Codex 官方 MCP 方式](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，没有修改模型、账号或沙箱权限。

全局配置不设固定 `cwd`，也不固定 `ZERO3_ACTIVE_PROJECT_ID`；启用 `ZERO3_MEMORY_AUTO_PROJECT=1`，由 Codex 传入当前任务工作目录。现有已打开的客户端需要重新加载 MCP（或重启一次 Codex）才能使用新工具；之后新项目和新会话无需重复配置。

- 已登记的六个 Zero3 工作区沿用原项目 ID，当前 Zero3 项目的既有记录保持可见。
- 新 Git 项目按规范化仓库 origin 分配稳定 ID；HTTPS／SSH 的同一 origin 对应同一范围。
- Git 工作树使用主仓库范围；没有 Git 的新目录按工作目录建立范围。无项目会话使用 Codex 实际传入的工作目录，同目录的会话共享记忆。
- 首次选择结果持久化在受保护缓存内的 `workspace-scopes.sqlite`，之后添加或更改 origin 不会导致既有工作区突然切换记忆。
- 全局可用不等于把所有项目记录混成一份。每个 MCP 实例仍绑定当前项目，读取其他项目 ID 会被拒绝。
- 新增 `memory_get_scope` 工具供 AI 获取本会话的项目 ID；服务初始化指引要求先读当前记忆，完成后发布相关持久事实或交接，不保存凭据或整段聊天。
- Zero3 内置 Codex 继续通过项目注入读取同一连接配置，已支持全项目授权；其他 MCP 配置保持原样。

本轮实际 stdio MCP 验收包括 Zero3、LanToDo 和全新临时目录：初始化、六个工具发现、权威上下文读取（`stale: false`）以及跨范围读取拒绝。可使用 `scripts/verify-memory-mcp.mjs --server <绝对路径> --config <绝对路径> --cwd <工作区绝对路径>` 复验，不调用模型，不输出令牌或完整上下文。

另外从 LanToDo 目录启动真实 Codex app-server，`mcpServerStatus/list` 已发现全局 `zero3_shared_memory` 的六个工具。该调用验证 Codex 配置和工具发现，不代表当前已经打开的旧会话完成了重载。新增范围分配测试与原离线缓存测试共 6 项通过；桌面三个 TypeScript 配置检查通过。

### 同步状态含义

| 字段／状态 | 含义及处理 |
| --- | --- |
| `pending` / `sending` | 已保存在本机／发送中，尚不能声称其他设备已经收到 |
| `acked` | 服务器已提交，并有服务器序号 |
| `conflict` | 重新读取实体，合并后用新 UUID 和当前实体版本发布；保留旧冲突记录 |
| `rejected` | 权限或事件不合法，修正后发布新事件 |
| `sync.stale: true` | 当前显示离线缓存，不能据此声称已获取最新权威内容 |

缓存按服务地址、项目、clientId、令牌隔离。轮换令牌后生成新的缓存命名空间；轮换前应排空或审查旧待发事件，不会自动把旧凭据域的待发数据带入新授权。

## 验证证据与复现

- Rust 服务：7 项测试通过；`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 通过。
- Rust `zero3-memory`：6 项单测和 1 项离线队列集成测试通过。
- JS：41 项通过、0 跳过，包含实际 PostgreSQL 服务上的事件和双客户端交接测试。
- 数据库：全部 5 个 SQL 测试文件与并发 version-zero 写入测试通过；使用独立测试库，未向生产库灌测试集合。
- 桌面：三个 TypeScript 配置的类型检查通过；未重置其他开发者正在修改的 upstream 工作树。
- 生产：`/health`、`/ready` 成功；Windows → AWS → DC 读取闭环成功。

```powershell
cargo fmt --manifest-path apps/memory-server/Cargo.toml -- --check
cargo clippy --locked --manifest-path apps/memory-server/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path apps/memory-server/Cargo.toml
cargo test --locked -p zero3-memory
# 仅指向隔离测试服务；不要使用生产令牌运行集成测试。
$env:ZERO3_MEMORY_TEST_URL = 'http://127.0.0.1:8793'
$env:ZERO3_MEMORY_TEST_TOKEN = '<隔离测试服务令牌>'
node --test apps/zero3-desktop/memory-sync-runtime/*.test.mjs apps/zero3-desktop/memory-v21-runtime/*.test.mjs apps/zero3-desktop/agent-memory-runtime/*.test.mjs apps/zero3-desktop/mcp-runtime/*.test.mjs
```

CI 配置为 `.github/workflows/memory-shared-integration.yml`，在独立 pgvector/PG16 服务上执行相同链路；推送触发的 CI 结果应以 GitHub 实际运行状态为准。

# Windows 验证通道（给网页端 GPT 等外部指挥官）

网页端 ChatGPT **没有**直连本机的能力：它不能访问 `localhost`，也不能执行本机命令。
但本项目已接入一条**异步邮箱通道**，网页端 GPT 可以用它在这台 Windows 开发机上
真实执行 `cargo` 构建/测试并回读结构化结果。

## 通道拓扑

```text
网页端 GPT
    |  写 pending/<id>.json（GitHub 网页或 API）
    v
GitHub: Taa965/zero3-commander-bridge   <-- 命令邮箱仓库（不是本仓库）
    |  本机执行器每 3 分钟轮询 pull
    v
Windows 开发机执行器  scripts_local/executor_windows.py
    |  在 C:/Users/aaaa/Documents/zero3-pilot 真实执行
    v
写回 results/<id>.json + status/<id>.json 并 push 回 GitHub
    |
    v
网页端 GPT 读结果
```

要点：

- **命令邮箱在 `Taa965/zero3-commander-bridge` 仓库，不在本仓库。** 本文档只是本项目
  这一侧的使用说明。协议全文见该仓库 `windows-verify/README.md`。
- 通道是**异步**的，不是 SSH、不是隧道、不是 MCP。一轮轮询 3 分钟，所以下发到拿到
  结果通常是 3~6 分钟，长构建更久。
- 执行器会**每 30 秒**把心跳写进 `windows-verify/status/<id>.json`，长任务可以据此跟进度，
  不必干等 `results/`。

## 对本项目下发命令

在邮箱仓库写 `windows-verify/pending/<id>.json`，`workdir` 固定指向本项目：

```json
{
  "id": "wv-pilot-20260903-001",
  "type": "shell",
  "command": "cargo test --workspace",
  "workdir": "C:/Users/aaaa/Documents/zero3-pilot",
  "timeout_s": 1500,
  "requested_by": "gpt-web",
  "created_at": "2026-09-03T05:30:00+08:00"
}
```

- `id` 全局唯一，重复会被拒（`status=error`）。建议前缀 `wv-pilot-` 以便和其他项目的
  任务区分。
- `type` 四选一：`shell` / `file_check` / `git_status` / `flutter_analyze`
  （本项目是 Rust，用前三个）。
- `timeout_s` 上限 1800。冷构建的 `cargo build --workspace` 可能跑好几分钟，
  给足余量，不要用默认 300。
- `command` 经 **git-bash** 执行，写 POSIX 语法，不要写 PowerShell 语法。

## 可用的 Rust 工具链

执行器的子进程 PATH 已注入 `C:/Users/aaaa/.cargo/bin`，以下命令可直接裸写：

| 命令 | 用途 |
|---|---|
| `cargo build --workspace --all-targets` | 构建（CI 同款） |
| `cargo test --workspace` | 测试（CI 同款） |
| `cargo fmt --all -- --check` | 格式检查（CI 同款） |
| `cargo clippy --workspace` | lint |
| `bash scripts/dev-check.sh` | 一次跑齐上面三项（CI 的本地镜像） |

首次冷构建会下载并编译全部依赖，明显慢于后续增量构建。

## 读结果

结果信封在邮箱仓库 `windows-verify/results/<id>.json`：

```json
{
  "id": "wv-pilot-20260903-001",
  "status": "ok",
  "exit_code": 0,
  "stdout_tail": "…最后 4000 字符…",
  "stderr_tail": "…",
  "duration_s": 138.4,
  "executor": "hermes-windows-1"
}
```

`status`：`ok` / `fail`（exit_code≠0）/ `timeout` / `error`（信封不合法或白名单拒绝，带 `reason`）。

**`stdout_tail` 只保留最后 4000 字符。** cargo 的失败信息往往在很靠前的位置，会被截掉。
所以对长输出要在命令里自行收窄，例如：

```bash
cargo test --workspace 2>&1 | tail -c 3500
```

或者只跑单个 crate：`cargo test -p zero3-core`。

## 边界

- `workdir` 必须落在白名单前缀内（`C:/Users/aaaa/Documents/`、`C:/Users/aaaa/Desktop/0/`、
  `D:/GCaaaa/`）。本项目在第一条之内。越界返回 `status=error, reason=workdir_not_allowed`。
- 通道**不做**内容审查：`shell` 类型是任意命令执行。它信任的是邮箱仓库的写入权限，
  所以别把邮箱仓库的写权限给不该有的人。
- 通道依赖本机能访问 GitHub。历史审计日志里出现过瞬时
  `schannel: failed to receive handshake` 导致整轮跳过；下一轮会自动重试，不用人工干预。
- 执行器由 Hermes cron 每 3 分钟拉起一次。机器关机或 Hermes 网关没跑，通道就是停的。

## 与 Commander Bridge 的区别

另有一条 `Taa965/zero3-pilot-commander-bridge` → Zero3 Pilot Dev Executor 的通道，
那条走 HTTPS Commander Protocol，目标是**服务器上**的 `/opt/zero3-pilot-dev` 工作树，
能力受固定 allow-list 约束（`repo.*`/`file.*`/`git.*`/`test.*`/`ci.*`/`deploy.*`）。

本文档这条 windows-verify 通道打的是**本机 Windows 开发环境**，用来验证「在我这台机器上
到底能不能编译/跑通」——两条通道目标不同，不要混用。

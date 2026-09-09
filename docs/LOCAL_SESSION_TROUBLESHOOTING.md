# 本地 Codex / Claude 会话失败排查

2026-09-10 的本机验证记录：

- Codex 登录状态正常，但显式指定 `gpt-5.3-codex` 或日志中的 `gpt-5.6` 时，服务端返回该模型不支持当前 ChatGPT 账号。`Reading prompt from stdin...` 只是 stderr 进度提示，真正的错误在 stdout JSON 中。
- 不指定模型和思考强度、继承本机 Codex CLI 配置后，最小对话成功。原有 Zero3 失败会话通过“恢复本机默认设置”后，也成功收到真实回复并保存 runtime id。
- Claude `auth status` 返回已登录，但独立 CLI 最小请求同样返回 `Failed to authenticate. API Error: 403 Request not allowed`。后续对照测试确认：Windows 浏览器使用已启用的本地 HTTP 代理，而 CLI 没有代理环境变量。同一凭证、同一 CLI，经现有系统代理发送立即成功；无需再次登录。

## 恢复路径

Codex 失败会话可点击“恢复本机默认设置”，清除该会话的模型和思考强度覆盖。项目绑定、runtime id 和历史消息保留，最后一条用户消息回填到输入框，用户重新发送即可。新建会话不再提供静态 Codex 模型推荐；留空复用 CLI 配置，也可手动指定账号可用的模型。

Claude 在 Windows 上未显式配置代理时，Zero3 通过 Electron 的系统代理解析结果设置子进程 `HTTPS_PROXY` 和 `HTTP_PROXY`，使对话、登录和任务执行使用浏览器相同的网络路径。尊重进程及 Claude 用户配置中的显式代理、`NO_PROXY` 和自定义 API 端点；不改 Windows 代理设置。DIRECT 保持直连，SOCKS 等不支持的路由明确报错，代理解析失败不静默改为直连。

已运行的旧版本也可在 Claude 用户 `settings.json` 的 `env` 中配置已验证的现有系统代理。修改前备份，保留其他配置；这会应用于该用户的独立 CLI 和 Zero3 子进程。代理地址发生变化时需要同步更新显式配置，或移除这几个代理环境字段以使用新版本的自动继承。

Claude 401/403 仍提供“重新登录”入口，但登录成功后继续 403 应优先对比浏览器和 CLI 的网络路径。[Claude 官方网络配置文档](https://code.claude.com/docs/en/network-config)说明 CLI 的代理环境变量及用户配置支持。

历史会话中保存的 Electron IPC 包装和 Claude 原始 JSON 会在显示时提取为可读错误，不改写原始历史。失败日志仍有完整诊断输出；Claude 提示改走 stdin，避免出现在进程参数和日志的 args 字段。

## 验证

- `node --test apps/zero3-desktop/tests/local-turn-recovery.test.cjs apps/zero3-desktop/tests/zero3-api-agent-kernel.test.cjs apps/zero3-desktop/tests/windows-cli-resolution.test.cjs`：35 项通过，含真实 React 组件恢复并重发的交互测试。
- `node --experimental-transform-types --test apps/zero3-desktop/executor-runtime/external/claude-environment.test.ts apps/zero3-desktop/executor-runtime/external/claude-executor.test.ts`：13 项通过，覆盖代理继承、显式配置优先、DIRECT、PAC、IPv6、不支持路由和原有 Claude 执行器行为。
- 完整生成桌面源码后，桌面 workspace 的 `npm run typecheck` 通过。
- `node scripts/bundle-electron-main.mjs --dev` 编译通过。
- Windows Zero3 窗口实测原 Codex 会话恢复成功；Claude 通过临时代理和持久化用户设置的独立 CLI 请求均成功，`is_error=false`。
- 新建 Zero3 Claude 会话实测两轮成功：第一轮介绍身份并记住验证词，第二轮准确返回验证词，runtime id 保持一致。当前运行的桌面无需再次登录即可使用持久化代理配置。
- 独立 Electron 冒烟测试调用新增的环境解析代码，禁用测试输入中的显式代理，正确继承了 Windows 已启用的本地 HTTP 代理。

源码启动入口会应用全部 overlay。开发模式的界面可热更新，Electron 主进程修改需在下次正常重启 Zero3 后加载。

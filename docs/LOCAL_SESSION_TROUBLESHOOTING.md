# 本地 Codex / Claude 会话失败排查

2026-09-10 的本机验证记录：

- Codex 登录状态正常，但显式指定 `gpt-5.3-codex` 或日志中的 `gpt-5.6` 时，服务端返回该模型不支持当前 ChatGPT 账号。`Reading prompt from stdin...` 只是 stderr 进度提示，真正的错误在 stdout JSON 中。
- 不指定模型和思考强度、继承本机 Codex CLI 配置后，最小对话成功。原有 Zero3 失败会话通过“恢复本机默认设置”后，也成功收到真实回复并保存 runtime id。
- Claude `auth status` 返回已登录，但独立 CLI 最小请求同样返回 `Failed to authenticate. API Error: 403 Request not allowed`。Zero3 外也能复现；仅凭这一错误无法确定是账号权限、凭证还是网络访问限制。没有将“存在登录凭证”当作在线授权验证成功。

## 恢复路径

Codex 失败会话可点击“恢复本机默认设置”，清除该会话的模型和思考强度覆盖。项目绑定、runtime id 和历史消息保留，最后一条用户消息回填到输入框，用户重新发送即可。新建会话不再提供静态 Codex 模型推荐；留空复用 CLI 配置，也可手动指定账号可用的模型。

Claude 401/403 或认证错误显示“重新登录”入口。完成官方 CLI 登录后重新发送；若仍返回 403，需要进一步检查账号访问权限和网络。程序不会删除登录凭证、绕过拒绝或把错误文本当成成功回复。

历史会话中保存的 Electron IPC 包装和 Claude 原始 JSON 会在显示时提取为可读错误，不改写原始历史。失败日志仍有完整诊断输出；Claude 提示改走 stdin，避免出现在进程参数和日志的 args 字段。

## 验证

- `node --test apps/zero3-desktop/tests/local-turn-recovery.test.cjs apps/zero3-desktop/tests/zero3-api-agent-kernel.test.cjs apps/zero3-desktop/tests/windows-cli-resolution.test.cjs`：35 项通过，含真实 React 组件恢复并重发的交互测试。
- 完整生成桌面源码后，桌面 workspace 的 `npm run typecheck` 通过。
- `node scripts/bundle-electron-main.mjs --dev` 编译通过。
- Windows Zero3 窗口实测原 Codex 会话恢复成功；Claude 在线回复仍受 403 阻塞，未宣称其恢复成功。

源码启动入口会应用全部 overlay。开发模式的界面可热更新，Electron 主进程修改需在下次正常重启 Zero3 后加载。

# 本地 Codex / Claude 会话失败排查

## 新建会话检测策略

新建弹窗不再启动全平台检测。网页平台立即可选；本地 CLI 在首次选中时单独检测，互不等待。检测就绪或实际对话成功后，会保存该平台的就绪标记，后续打开弹窗、切换平台、普通窗口切回及应用重启都直接复用。标记仅存布尔值，不保存凭证或 CLI 输出。

明确的授权、连接或 CLI 缺失错误会清除对应平台标记，下次选中时重检；模型不支持等会话配置错误不会清除连接状态。未就绪结果仅在本次应用运行期间复用，用户可点“重新检测”。从弹窗打开官方授权后，返回窗口会重新检测该平台一次；如果返回过早，可在登录完成后手动重检。

API 配置列表独立读取，保存和删除配置不启动 CLI 检测。进行中的检测按平台合并；较早的检测结果不能覆盖其后成功对话或失败失效事件。

本次验证：包含 `provider-readiness.test.cjs` 的本地会话回归组共 38 项通过，覆盖重复挂载、持久化恢复、普通 focus、授权返回、手动重试、慢平台隔离及过期结果。完整桌面类型检查与 Electron 主进程/预加载构建通过。运行中的旧主进程需在启动控制台按 R 重载一次以启用按平台 IPC。

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

## Windows PowerShell 执行策略与 npm/pnpm 启动（2026-09-12）

症状：在 Zero3 Pilot 本体会话里让 Agent 启动一个前端项目（`npm run dev`、`pnpm dev`、`npx`）会失败，错误是 `npm.ps1 cannot be loaded because running scripts is disabled on this system`；同一台机器上同样一句话在官方 Codex 里可以直接执行成功。于是会话只能反过来给用户一段"自行开启执行策略"的手工命令，看起来像 Zero3 比官方客户端更弱。

根因：Node.js 在 Windows 上为 npm/npx/pnpm/yarn 安装了 `.ps1` 命令垫片。PowerShell 的有效执行策略为 Restricted 或 AllSigned 时拒绝加载未签名脚本（本机 MachinePolicy/UserPolicy/CurrentUser/LocalMachine 均为 Undefined，默认就是 Restricted）。上游 Codex 的 shell 工具固定以 `powershell.exe -NoLogo -NoProfile -Command <script>` 运行命令，从不传 `-ExecutionPolicy`，所以策略只能通过环境传进那个子进程：PowerShell 会把继承到的 `PSExecutionPolicyPreference` 当作自己的进程作用域策略。官方 Codex 桌面端正是用它自己进程的环境给内核设了这个偏好（在官方 Codex 会话里 `PSExecutionPolicyPreference=Bypass`，`Get-ExecutionPolicy -List` 的 Process 作用域为 Bypass），Zero3 之前没有设置，内核、内嵌 PowerShell 终端和 capability 执行都继承到机器默认的 Restricted，于是出现"换个客户端就失败"。

修复：Zero3 生成 Electron 主进程时，统一用同一个启动环境块给 Codex 内核补上 `PSExecutionPolicyPreference=Bypass`，并把同一偏好写进 Electron 主进程自身环境，因此 Codex 内核、内嵌 PowerShell 终端、capability 执行和 provider CLI 行为一致（`apps/zero3-desktop/scripts/apply-codex-transport.mjs`）。Zero3 的 Rust Codex 子代理在 Windows 上同样补这个变量（`crates/zero3-subagents/src/workers.rs`），除非配置里已显式给出同名变量。

边界：只设置进程作用域偏好，不写注册表、不改系统或用户执行策略；MachinePolicy、UserPolicy 仍高于进程作用域，管理员的全机限制不会被绕过；`ZERO3_KEEP_WINDOWS_POWERSHELL_POLICY=1` 可让环境中保留原样。已经准备好的 Electron 源码树会在下次启动时被 overlay 原地升级（重写旧的启动环境块），不会再注入第二份。

验证：

- `node --test apps/zero3-desktop/tests/windows-powershell-policy.test.cjs`：4 项通过，覆盖 Windows 加变量、非 Windows 不加、显式退出开关，以及"旧树原地升级且不重复注入"。
- 用与上游 Codex 完全相同的启动形式复现：`powershell.exe -NoLogo -NoProfile -Command "npm --version"`（清掉环境里的该变量）在 Windows PowerShell 下被策略拒绝，加入 `PSExecutionPolicyPreference=Bypass` 后返回 `11.17.0`、退出码 0。
- `node scripts/check-architecture.mjs` 通过，新增守卫要求 Codex 传输层始终保留该方法块。
- 生成树 `upstream/hermes-agent/apps/desktop` 的 `tsc -p tsconfig.electron.json --noEmit` 通过。

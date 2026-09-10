# 会话标题栏额度

标题栏在项目前显示本周、5 小时剩余百分比；Zero3 显示所绑定 API 配置的账户余额和币种。低于或等于 10% 的额度、零或负余额显示提醒色。悬停可查看查询时间、恢复时间和不可用原因。

## 数据来源与边界

- **Codex**：启动与本地对话相同的官方 `codex` CLI，清除 Zero3 内核的隔离 `CODEX_HOME`，只调用 `initialize` 和 `account/rateLimits/read`。读取 `codex` 通用额度桶，按服务端窗口长度 300 / 10080 分钟匹配，剩余百分比为 `100 - usedPercent`。不把其他模型的独立额度桶拼到通用额度中，不把缺失字段视为 100%。[官方协议](https://learn.chatgpt.com/docs/app-server)
- **Claude**：仅在官方订阅登录模式下读取本机 OAuth 凭证，向官方 `/api/oauth/usage` 查询 `five_hour` / `seven_day`。这些是账号共享额度，不是单个对话的 token 消耗。兼容显式代理和系统代理；API Key、代理服务、Bedrock / Vertex / Foundry 模式不冒充订阅账号。[官方额度字段说明](https://code.claude.com/docs/en/statusline)
- **Antigravity**：当前核实的 `agy` CLI 没有非交互的额度查询子命令，官方 `/usage` 打开交互式 TUI。因此两个位置显示“暂不可获取”，悬停提示官方查看入口。不自动发送 `/usage` 给模型，也不把模型 token 用量换算成账户百分比。[官方入口](https://www.antigravity.google/docs/cli/commands/usage)
- **Zero3**：按会话绑定的 API Profile 查询，支持 [DeepSeek `/user/balance`](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/) 和 [OpenRouter `/credits`](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)。后者可能要求管理密钥；普通推理密钥返回无查询权限时明确提示。其他兼容接口没有统一的余额标准，显示“暂不可获取”。不将 API Key 发往配置之外的服务商，也不从本地累计费用推算账户余额。

## 刷新与隐私

查询在后台执行，不阻塞会话创建或发送。主进程按平台 / API 配置及配置版本隔离缓存，成功结果缓存 5 分钟，失败结果缓存 1 分钟，同一查询合并并发请求。前台每 5 分钟更新，也在会话变化时读取缓存；手动刷新最短间隔为 30 秒。HTTP 请求限时 12 秒，Codex 子进程限时 15 秒，输出有大小限制。恢复时间来自服务端，不根据报错文本猜测额度百分比。

凭证仅在主进程读取并发送给对应官方服务，查询拒绝跨站重定向，不把原始响应、凭证、请求头或网络错误细节传给 UI。不刷新或改写登录凭证，不消费额度重置、不充值。此次新增主进程 IPC 后，运行中的旧开发版需按启动控制台 R 重载一次。

## 验证记录

2026-09-10，本机独立 Electron 只读查询取得 Claude 5 小时剩余 0%、周剩余 26%，以及各自恢复时间。Codex 通用额度桶返回周剩余 28%，没有 5 小时窗口；独立模型桶的数据没有被混用。数值仅代表验证时刻。

`provider-usage.test.cjs` 覆盖窗口匹配、未知值、真实零余额、缓存隔离和节流、官方凭证路由、错误脱敏、Codex 只读 RPC 与进程清理，以及切换平台时的 React 显示。结合原会话恢复和就绪缓存回归组共 32 项通过。

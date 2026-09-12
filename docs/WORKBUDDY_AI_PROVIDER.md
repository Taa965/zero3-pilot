# WorkBuddy AI 会话（本地 CLI 运行时）

新建会话弹窗的 `WorkBuddy AI` 卡片把 WorkBuddy AI 桌面应用内置的 CodeBuddy Code CLI 当作本地
Agent 运行时，与本地 Codex、Claude Code 处于同一层级：它调用本机已安装的官方 CLI、复用该
CLI 自己的官方登录，Zero3 不保存也不解析任何账号凭证。

## CLI 从哪来

WorkBuddy AI 不把 `codebuddy` 装到 PATH 上，而是随应用一起发布：

```
%LOCALAPPDATA%\Programs\WorkBuddyAI\resources\app.asar.unpacked\cli\bin\codebuddy
```

该入口是一个 Node 脚本（`#!/usr/bin/env node`，无扩展名、无 `.cmd` 垫片），所以不能直接
spawn：Windows 下会以 `ENOENT` 失败。运行时按下面的顺序解析，命中即用：

1. 环境变量 `ZERO3_CODEBUDDY_CLI_BIN` 指定的完整路径；
2. PATH 上的 `codebuddy` / `cbc` / `codebuddy-code`（含 npm 垫片，垫片指向的脚本会被读出）；
3. WorkBuddy AI 的默认安装位置（`%LOCALAPPDATA%`、`%ProgramFiles%`、`%ProgramFiles(x86)%`）。

解析结果分两种：`.exe` 直接 spawn；其余情况用 `process.execPath` 加 `ELECTRON_RUN_AS_NODE=1`
把 Electron 当作 Node 解释器来跑该脚本。这样 provider 不依赖机器上是否另装了 Node。

## 一次 turn 怎么跑

```
<node|codebuddy> <entry> -p --output-format json --permission-mode auto \
  [--model <model>] [--effort <low|medium|high|xhigh|max>] [--resume <sessionId>]
```

- 提示词走 stdin，不出现在进程参数或失败日志里。
- 会话延续复用 CLI 自己上报的 `session_id`：首个 turn 结束后写入会话的 `runtimeId`，后续 turn
  以 `--resume` 传入，实测第二轮能准确回忆起第一轮的内容。
- `--output-format json` 返回的是一个**事件数组**，最后一个 `type: "result"` 元素带
  `result`（助手文本）、`session_id` 与 `is_error`。旧版或管道调用可能输出逐行 JSON，因此两种
  形态都会被读取；解析不到 `result` 事件时按失败处理，而不是当成空回复。
- CLI 会在退出码为 0 的情况下用 `is_error: true` 报告被拒绝的请求，这种情况同样按失败处理。

## 权限模式为什么是 `auto`

`--permission-mode dontAsk` 看起来是"非交互场景的安全选择"，实测并非如此：该模式下工具调用被
直接拒绝，让 Agent 建一个文件，它回复"当前非交互模式无法获得授权"，整个 turn 就浪费了。
`--permission-mode auto` 才会在会话内真正放行工作，与本地 Codex 通过
`--sandbox workspace-write` 拿到的授权层级相当。这是实测结论，改动时请保留
`apps/zero3-desktop/tests/workbuddy-codebuddy-runtime.test.cjs` 中对应的断言。

## 就绪度检测

探测方式是执行 `--version`：这是 CLI 自带的快速路径，在加载 bundle 之前就打印版本号，因此一次
检测的成本只是启动一个进程，不走网络。

`--version` 不能证明登录有效，而 CodeBuddy Code 没有 `login status` 之类的子命令可查。因此该平台
报告 `available: true, authenticated: null`——"已安装，未验证"，而不是替用户猜一个答案。弹窗上
显示为"待检测"并附上 CLI 版本与来源；会话仍可创建，真实登录状态以首次发送的结果为准。未就绪
或授权失败时，卡片上的"打开官方 CLI 授权"会在终端里打开 CodeBuddy Code 自身的 TUI，用户可在其中
完成登录。

## 归档与额度

- 归档：CodeBuddy Code 没有受支持的会话归档接口，其磁盘上的 transcript 保持原样，Zero3 只维护
  自己这一侧的可见性标记（与 Claude Code 的处理一致）。
- 额度：CLI 未提供可读取的额度接口，额度徽标显示为"暂不可获取"，请在 WorkBuddy AI 中查看用量。

## 项目绑定

会话需要一个 Zero3 项目目录作为工作目录（`cwd`）。与 Codex 不同，本 provider 不参与项目目录的
原生绑定流程（`ProjectLinkAdapter`），运行时直接使用所选项目的 `rootPath`。

## 验证

- `node --test apps/zero3-desktop/tests/workbuddy-codebuddy-runtime.test.cjs`：6 项通过，覆盖内置
  CLI 解析、`ZERO3_CODEBUDDY_CLI_BIN` 覆盖、PATH 优先、缺失时报错可操作、两种输出形态解析、
  turn 参数契约，以及八个会话界面是否都注册了该平台。
- 完整 staging 后 Electron 主进程/preload 与渲染层类型检查均通过。
- 本机实测（WorkBuddy AI 内置 CodeBuddy Code 2.137.1）：
  - `--permission-mode auto` 下成功创建文件并回复 `done`；
  - 以 `--resume <session_id>` 发起的第二轮准确返回第一轮创建的文件名，`session_id` 保持一致；
  - `--effort medium` 与 `--model fast-model` 均被 CLI 接受。

## Overlay 说明

主进程侧的接线由 `apps/zero3-desktop/scripts/apply-session-provider-runtime.mjs` 注入，注入块用
带版本号的注释标记包裹（`zero3:session-provider-*-start v1`）。改动注入内容时请递增
`SESSION_PROVIDER_REVISION`：标记同时充当补丁引擎的"已应用"凭据，版本号递增后旧块会作为修复
候选被替换，已经 staging 过的工作树在下一次 prepare 时才会自动更新。

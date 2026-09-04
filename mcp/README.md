# mcp/

Zero3 Pilot 的 **project-level extension MCP** 位于这里。

架构边界保持不变：

- open-source Codex 仍是 Zero3 唯一 authoritative Agent Kernel；
- MCP 只承载 Zero3 自己的 project context / task handoff 等扩展状态；
- MCP 不接管 Codex Thread / Turn / Item / history / approval / shell / Git authority；
- GPT Web 仍由 `chatgpt.com` 自己拥有 conversation authority；
- Zero3 不通过 MCP 复制 ChatGPT 或 Codex 的完整聊天记录。

## zero3-project-context

`mcp/zero3-project-context/` 是第一版共享项目上下文与执行交接服务器。

当前工具：

```text
project_get_context
project_put_context
handoff_get
handoff_publish
```

其中：

- `project_get_context`：读取某个 Zero3 项目的 canonical project context；
- `project_put_context`：用 optimistic version control 更新 project context；
- `handoff_get`：读取某个任务最新的结构化执行交接；
- `handoff_publish`：发布 `zero3.pilot.execution-result.v1` 结果。

## 本地状态

服务要求：

```text
ZERO3_PROJECT_CONTEXT_DIR=<absolute local directory>
```

逻辑结构：

```text
<ZERO3_PROJECT_CONTEXT_DIR>/
├── projects/
│   └── <project_id>.json
└── handoffs/
    └── <task_id>.json
```

状态文件：

- 仅保存在指定本地目录；
- 使用原子临时文件 + rename 更新；
- 单文件上限 2 MiB；
- mutation 串行化；
- project/handoff 都带单调版本号；
- 写入接口可传 `expectedVersion`，拒绝 stale writer；
- 不保存浏览器 Cookie、OAuth token、ChatGPT access token 或完整聊天内容。

## 开发运行

```bash
cd mcp/zero3-project-context
npm install
ZERO3_PROJECT_CONTEXT_DIR=/absolute/path/to/state npm start
```

Windows PowerShell 示例：

```powershell
cd mcp/zero3-project-context
npm install
$env:ZERO3_PROJECT_CONTEXT_DIR = "C:\\Users\\<user>\\AppData\\Local\\Zero3Pilot\\project-context"
npm start
```

## Codex 接入原则

Codex 通过原生 MCP client seam 使用本服务器；不要新增第二个 Node Agent runtime。

V1 的正式接线顺序：

```text
Zero3 Project Extension State
        ↕ MCP
pinned Codex App Server / Codex Thread
```

桌面打包层必须显式决定 MCP server 的 executable/bundle 生命周期后再默认启用，不能假定终端里存在全局 `node` / `tsx` / `npm`。

因此当前提交先落地 **协议与本地 server implementation**；Windows packaged-runtime wiring 必须在统一真实性验收前完成并验证。

## GPT Web 接入原则

ChatGPT Web 侧未来通过 Zero3 App / MCP 访问相同的 project context / handoff 数据。

它不会获得或要求：

```text
ChatGPT conversation private API
ChatGPT cookies
ChatGPT access token
DOM-level message scraping
```

因此 GPT Web 与 Codex 所谓“共同记忆”指的是：

> 同一个 Zero3 canonical project context 与 handoff state，
> 而不是同步两边全部聊天记录。

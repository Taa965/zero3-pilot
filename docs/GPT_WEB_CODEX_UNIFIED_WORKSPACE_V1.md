# Zero3 Pilot GPT Web × Codex Local 统一工作区架构 V1

> 状态：实施基线  
> 日期：2026-09-04  
> 基线：`main@c93a3f1198e31e98b1e5caf6f72dd8a77f7b3733`

## 1. 目标

Zero3 Pilot 在同一个项目侧栏中统一展示两类会话入口：

- `GPT Web`：真实 `chatgpt.com` 网页会话，由 Zero3 内嵌浏览器承载；
- `Codex Local`：真实 Codex App Server Thread，由现有 `window.zero3Codex` / `codex app-server --stdio` 承载。

用户看到统一的项目工作区，但底层权威保持分离：

```text
Zero3 Project Workspace
├─ 🌐 GPT Web binding  -> chatgpt.com/c/<id>
└─ ◇ Codex Thread     -> Codex app-server Thread
```

目标交互：

```text
GPT Web
  -> Zero3 Task/Handoff
  -> Codex Local
  -> Windows / Git / verification
  -> Zero3 Result
  -> GPT Web audit / decision
```

## 2. 与架构宪法的关系

本功能不得引入第二个 Agent Kernel。

`docs/ARCHITECTURE_CONSTITUTION.md` 继续是最高优先级约束：

- Codex 仍是 Zero3 唯一 authoritative Agent Kernel；
- Codex Thread / Turn / Item、context/history、tool、approval、Git/worktree execution 继续归 Codex core path；
- GPT Web 不成为 Zero3 的第二个 agent runtime；
- Zero3 不复制或接管 ChatGPT 云端 conversation semantics；
- Hermes 继续只承担 Electron/React UI shell。

因此本方案不再使用“Zero3 Session Hub 接管所有 session lifecycle”的表述。

统一层正式命名为：

```text
Zero3 Workspace Entry Registry
```

它只管理“UI 导航入口与项目绑定”，不替代 provider 自己的 conversation/session authority。

## 3. 权威边界

### 3.1 Codex Entry

权威来源：Codex App Server。

Zero3 只保存/投影：

```text
thread_id
project binding
workspace/cwd
presentation metadata
running state projection
```

创建、恢复、历史、Turn、Item、approval、interrupt 仍由现有 Codex transport 完成。

### 3.2 GPT Web Entry

权威来源：`chatgpt.com`。

Zero3 只保存：

```text
entry_id
project_id
browser_profile_id
conversation_url
current_url
page_title
local_display_title
last_active_at
```

Zero3 不声称拥有 ChatGPT conversation API，不读取/导出 ChatGPT cookie/access token，不依赖私有 backend API。

### 3.3 Project Context

Project-level memory/context 是 Zero3 extension capability，可通过 Codex-native extension seams（MCP / skills / hooks / deliberate app-server extension）接入。

它不得替代 Codex Thread 自身的 context/history。

## 4. Desktop Browser Provider

Windows V1 使用 Electron 40 的 `WebContentsView` + persistent `session` partition。

推荐 partition：

```text
persist:zero3-chatgpt
```

原则：

- 一个 ChatGPT 账号/profile 对应一个 persistent partition；
- 多个 GPT Web Entry 共享该 profile；
- Browser Profile 只保存在本机 Electron userData；
- Zero3 不读取 cookie/token 内容；
- 不使用 iframe；
- 不通过 DOM 注入实现核心流程。

### 4.1 允许监听

- navigation URL；
- page title；
- loading state；
- renderer bounds / visibility；
- crash / navigation error。

### 4.2 禁止依赖

- ChatGPT DOM selector；
- ChatGPT 私有 API；
- 自动抓取完整聊天文本；
- 自动模拟用户发送消息作为正式控制面；
- 提取浏览器认证机密。

## 5. Workspace Entry 数据模型

```ts
type Zero3WorkspaceEntryKind = 'codex' | 'gpt_web'

type Zero3WorkspaceEntry = {
  id: string
  projectId: string
  kind: Zero3WorkspaceEntryKind
  title: string
  lastActiveAt: string

  codex?: {
    threadId: string
  }

  gptWeb?: {
    browserProfileId: string
    conversationUrl: string | null
    currentUrl: string
    pageTitle: string | null
    localDisplayTitle: string | null
  }
}
```

Codex Thread 本身不复制进 Zero3 数据库；这里只保存 UI binding。

## 6. 统一侧栏

目标：同一 Recents/Project 列表混排。

```text
🌐 空间模块总体方案
🌐 UI2 SceneTwin 适配
◇ P12 Scanner          ●
◇ P13 Registry         ✓
🌐 Wave 4 总控
```

- GPT Web 使用蓝色互联网图标；
- Codex 使用 Codex/本地图标；
- provider 色与运行状态色分离。

## 7. 新建入口

```text
+ 新建会话

🌐 GPT Web
   使用真实 ChatGPT 网页

◇ Codex
   使用本地 Codex App Server
```

GPT Web：

```text
create workspace entry
-> show WebContentsView
-> navigate https://chatgpt.com/
-> observe first /c/<id> navigation
-> bind conversation URL
-> observe title
-> update sidebar label
```

Codex：继续调用现有 `thread/start`。

## 8. Task / Handoff

优先复用当前 Remote Host 已存在的 `zero3.pilot.remote-task.v1` 与 task -> Codex Thread mapping，而不是重新制造第二套 Task runtime。

新增字段应通过协议版本演进或 envelope 扩展完成，重点覆盖：

```text
project/context reference
base ref / commit evidence
acceptance criteria
verification requirements
completion evidence
result/handoff summary
```

控制面继续保持：

```text
Web/Commander -> H5 Control Plane -> Remote Host -> pinned Codex
```

Commander Bridge 不获得 shell/Git/Codex runtime authority。

## 9. Git / Worktree

不新增独立通用 Git Agent Kernel。

现有架构已经把 Git/worktree integration 定义为 Codex core responsibility。

后续需要的是：

- Codex-authoritative Git preflight；
- task base ref verification；
- clean-worktree evidence；
- commit/push/result evidence；
- parallel worktree isolation policy。

这些能力必须通过 Codex core/app-server/skills/hooks 或受审查的窄宿主接口实现，不能重新建立一个绕过 Codex 的通用 shell/Git executor。

## 10. GPT Web ↔ Codex 流转

### V1 transport

先复用已有 GitHub / Commander / H5 Remote Host 链路。

```text
GPT Web
-> Zero3 control task
-> H5 / Remote Host
-> Codex Thread
-> result/evidence
-> Zero3
-> GPT Web
```

### V2 transport

Zero3 MCP 暴露 project/task/handoff/result read/write contract；ChatGPT Web App 与 Codex 使用同一 project extension source。

MCP 只承载 Zero3 project extension state，不接管 Codex primary conversation runtime。

## 11. Completion Gate

Gate 必须以真实 authority evidence 为输入：

```text
Codex Turn terminal state
required verification evidence
Git/base/head evidence
remote result delivery state
known blockers
```

不得根据自然语言“完成了”直接标记 COMPLETE。

## 12. 并行模型

顶层 P12-P17 等 write-heavy parallelism 由 Zero3 control plane / Remote Host 的 workspace isolation 管理，每个任务映射独立 workspace + Codex Thread。

Codex subagents 只作为单任务内部协作，不替代顶层任务隔离。

## 13. 实施顺序

### P01 Workspace Entry Core

- entry registry/types；
- Codex projection adapter；
- GPT Web binding metadata；
- provider-independent sidebar contract。

### P02 GPT Web Browser Provider

- WebContentsView；
- persistent partition；
- URL/title observation；
- create/open/hide/destroy；
- external-browser fallback。

### P03 Codex Runtime Extension

- 复用现有 app-server transport；
- 补齐本功能需要的 typed operations/events；
- 禁止 generic JSON-RPC renderer proxy。

### P04 Project Context / Handoff

- 复用 Remote Task；
- context refs；
- handoff/result schema；
- MCP contract landing。

### P05 Git / Worktree / Verification Evidence

- Codex-authoritative preflight；
- base/head evidence；
- verification evidence；
- completion gate。

### P06 Unified UI

- 新建会话 provider picker；
- 蓝色 GPT Web 图标；
- mixed recents；
- GPT/Codex surface switch；
- task handoff controls。

## 14. 验收原则

GPT 网页会话只做静态审查；不在 Linux 环境声明 Windows 真实性 PASS。

最终统一 Windows 验收至少覆盖：

1. ChatGPT Web 首次登录；
2. 重启后 profile 登录态仍存在；
3. GPT 新会话 URL/title 可绑定；
4. 混排侧栏正确；
5. GPT/Codex 切换不丢状态；
6. Codex Thread restart persistence 不回归；
7. 六路独立 workspace/thread 不串线；
8. task -> Codex -> result/evidence 闭环；
9. local/remote Git evidence 一致；
10. 不出现第二 Agent Kernel / Node primary runtime 回归。

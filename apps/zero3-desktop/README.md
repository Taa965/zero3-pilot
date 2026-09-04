# Zero3 Desktop — 唯一三栏 UI + Codex Agent Kernel

`apps/zero3-desktop` 现在只有一个产品 Renderer：Zero3 Pilot 自己维护的三栏式工作台。

## 最终产品边界

```text
Zero3 三栏式 UI（唯一）
        |
        +--------------------+---------------------+
        |                    |                     |
window.zero3Codex     window.zero3GptWeb    window.zero3GeminiWeb
        |                    |                     |
typed preload IPC     WebContentsView       WebContentsView
        |                    |                     |
Codex app-server      chatgpt.com session   Gemini session / Antigravity
        |
open-source Codex runtime
```

### UI 所有权

- `apps/zero3-desktop/renderer-v2/` — **唯一需要继续维护的产品 UI**。
- Codex 开源项目自带 UI — **废弃，不打包、不挂载**；只保留 Codex app-server / CLI Runtime。
- Hermes React UI — **废弃，不导入、不挂载**。
- Hermes 当前只作为过渡期的 Electron/Vite 构建宿主与部分已审查 main/preload 基础设施；这不是产品 UI，也不再承接新 UI 功能。
- `apps/desktop` 旧 Rust/Tao/Wry 桌面 — 历史/回滚用途，不是目标桌面。

`apply-zero3-three-column-ui.mjs` 在所有 Runtime overlay 完成后最后执行，并把上游 `index.html` 直接指向 `/src/zero3-shell-entry.tsx`。因此 Hermes 的 `src/main.tsx` 不进入实际产品 Renderer 模块图。

## 三栏 UI 的真实功能

### 1. 左侧：统一工作台 / 会话列表

会话数据不再是演示数据：

- Codex：`thread/list`
- GPT Web：`zero3Workspace.list()` 中的 `gpt_web` 条目
- Gemini Web：`zero3Workspace.list()` 中的 `gemini_web` 条目

支持按 `全部 / Codex / GPT / Gemini` 筛选、搜索、创建真实会话，并持久化最近选择的工作区。

### 2. 中间：真实主工作区

#### Codex

直接使用 `window.zero3Codex`：

```text
status / start
thread.start
thread.resume
thread.list
thread.read
turn.start
turn.interrupt
respondToServerRequest
onEvent
```

主工作区从 Codex Thread / Turn / Item 生成内容，不再展示写死的“执行计划 / grep_search / replace_file_content”演示卡片。

当前 Renderer 已处理：

- userMessage / agentMessage
- reasoning
- commandExecution
- fileChange
- mcpToolCall / dynamicToolCall
- plan
- webSearch
- Turn 运行/完成/中断
- agent message / reasoning / command delta
- command/file approval
- `item/tool/requestUserInput`

Composer 直接 `turn/start`；停止按钮直接 `turn/interrupt`。

#### GPT Web

通过 `window.zero3GptWeb` 创建/显示/隐藏/调整 `WebContentsView`，真实 ChatGPT 会话直接嵌入当前三栏工作区，左侧会话和中心 WebContentsView 使用同一个 workspace entry。

#### Gemini Web

通过 `window.zero3GeminiWeb` 创建/显示/隐藏/调整 `WebContentsView`，真实 Gemini 会话直接嵌入当前三栏工作区。既有 Gemini/Antigravity/MCP Runtime 保持在 Electron main/preload 侧，不再为它维护第二套 Renderer。

### 3. 右侧：属性面板

右侧属性面板显示并控制当前真实会话：

- provider / workspace ID / 状态
- Codex cwd
- sandbox
- approval policy
- model provider / model
- Ollama 本机模型发现
- Codex Core running / initialized / PID / stderr tail
- GPT/Gemini reload / open external / suspend

WebContentsView 的 bounds 由中间工作区 DOM 实时计算，并通过 `ResizeObserver` 跟随窗口尺寸和属性面板开合变化。

## Runtime 权威性

### Codex

Codex Thread / Turn / Item 和 app-server notification/server request 是本地 Agent Kernel 的唯一权威来源。

Renderer 不暴露 generic JSON-RPC proxy，不启动第二套 agent loop，也不回退到 Hermes Runtime 执行 Codex 主聊天。

### GPT / Gemini

GPT/Gemini Web 会话通过各自持久 Electron partition 与 workspace registry 管理。认证状态留在 Electron Session 中；UI 不读取登录凭证。

## 过渡宿主说明

本次改造首先完成 **Renderer 断开**：用户看到和维护的 UI 已经完全归 Zero3 所有。

当前构建仍借用 pinned Hermes Desktop 的 Electron/Vite package，原因是现有以下 Runtime 已经通过经过审查的 overlay 集成在它的 main/preload 中：

- Codex app-server transport
- workspace registry
- GPT Web provider
- Gemini Web provider
- Control Plane / Remote Host / Agent Routing / Artifact / Development Group 等已合并 Runtime

后续可以把这些 Zero3-owned main/preload Runtime 抽到 `apps/zero3-desktop` 自己的 Electron host，然后彻底删除 Hermes package 依赖。这个迁移不再要求重写产品 UI。

## Pinned upstreams

准确 SHA 由 `scripts/config.mjs` / manifest 校验：

```text
Codex            94311d447587411789533c47601fd8bc9d81eb48
Hermes Agent     f7c79efbac19ae18e8dee7c79a4e4c0935299b5f  # temporary host only
DeepSeek-Harness cd5ef8148158c3a752a658978873241fdf8e2bbc
```

## 命令

```powershell
npm run prepare
npm run typecheck
npm run dev
npm run dist:win
```

`prepare-codex-upstream.mjs` 会在 Runtime overlays 完成后最后调用 `applyZero3ThreeColumnUi()`，因此 `npm run prepare`、`npm run dev`、`npm run typecheck`、`npm run dist:win` 走的是同一个 Renderer cutover。

## Windows 真实性验收

网页侧只做静态审查。Windows 本地统一真实性验收建议至少覆盖：

```powershell
cd <zero3-pilot>\apps\zero3-desktop
npm run reset
npm run prepare
npm run typecheck
npm run dev
```

启动后验证：

1. 左侧出现真实 Codex/GPT/Gemini 会话，而不是固定演示条目；
2. Codex 新建会话得到真实 Thread ID；
3. Composer 发送后出现真实 Turn / Item / 工具输出；
4. Stop 能中断 active Turn；
5. GPT tab 创建并嵌入真实 ChatGPT WebContentsView；
6. Gemini tab 创建并嵌入真实 Gemini WebContentsView；
7. 属性面板开合时 WebContentsView bounds 正常跟随；
8. 重启桌面后 workspace entries 和 Web 登录 Session 保留；
9. 页面中不再出现 Hermes 产品 UI，也不存在 Codex OSS UI 入口。

## 不再接受的新增工作

以下方向从本次切换起停止：

- 给 Hermes React UI 新增 Zero3 页面/按钮；
- 给 Codex OSS UI 做 Zero3 定制；
- 同一个功能分别维护 Zero3 UI / Hermes UI / Codex UI；
- 为演示截图写死假会话、假工具调用、假执行状态。

所有新 UI 功能只进入 `apps/zero3-desktop/renderer-v2/`。

> 迁移期 CI 兼容标记：`Hermes UI shell over Codex core` 是 U1 之前已废弃的历史标题，只为旧架构守卫完成迁移前保留文本匹配；它不是当前产品架构。
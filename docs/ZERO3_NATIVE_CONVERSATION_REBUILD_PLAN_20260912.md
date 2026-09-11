# Zero3 本体原生会话重构执行方案

> 目标：将 Zero3 本体 API 会话从简化聊天执行器升级为以 Codex App Server 为原生会话内核、支持结构化流式时间线、会话内模型/思考强度/API 服务商切换、共享记忆与未覆盖上下文自动交接的统一会话系统。
>
> 原则：优先复用当前锁定的开源 Codex 协议、事件、Thread / Turn / Item 语义，不重复维护简化版本。

## 1. 最终产品目标

Zero3 本体页面只存在一个逻辑会话。用户在同一页面中可以切换模型、思考强度、API Profile、API 服务商，并查看 Codex 原生结构化执行时间线；恢复历史会话；Provider 切换后继续原任务，不需要用户手工解释上下文；共享记忆未覆盖最新聊天内容时，由 Zero3 自动补齐未覆盖部分。

必须满足：
- 切模型、思考强度、API Profile、API 服务商均不新建可见会话页面。
- 页面历史消息、命令、文件修改、结果全部保留。
- Provider 切换后下一轮继承有效上下文。
- 内部交接包不能伪装为普通用户消息。

## 2. 总体架构

```text
Zero3 Logical Session
├── logicalSessionId
├── Session Event Store
│   ├── userMessage / agentMessage / reasoning
│   ├── commandExecution / commandOutputDelta
│   ├── fileChange / mcpToolCall / approval / artifact
│   └── providerSwitch / turnState
├── Codex App Server
│   └── Thread / Turn / Item
├── Runtime Binding
│   └── provider / profileId / model / effort / runtimeThreadId
├── Shared Memory
│   └── project/task authority + context manifest + sequences
└── Provider Handoff
    └── shared memory refs + uncovered session delta + runtime state
```

Logical Session 是用户看到的会话；Runtime Thread 只是某个 Provider 当前的执行实例。一个 logicalSessionId 可以先绑定 OpenAI Runtime Thread，再切 DeepSeek/Anthropic Runtime Thread，页面始终是同一个 Zero3 会话。

## 3. 停止继续扩展旧实现

- 停止把简单字符串 progress log 当主要执行展示，禁止依赖 `detail.includes('命令')` 猜事件类型。
- 停止把 `turn/start -> 等 turn/completed -> 取最后 agentMessage -> return string` 作为 Zero3 本体主要会话接口。
- API Profile 只保存连接/Provider/凭证/默认值；会话自身保存当前 provider/profile/model/effort。
- Provider native thread 只能作为 working memory，不能成为 Zero3 项目/任务权威上下文。

## 4. Phase A：统一 Session Event Store

新增建议目录：

```text
apps/zero3-desktop/session-runtime/
  session-event-types.ts
  session-event-store.ts
  session-runtime-binding.ts
  session-context-coverage.ts
  session-provider-handoff.ts
  session-provider-switch.ts
```

核心事件至少包含 userMessage、agentMessage、reasoning、command started/output/completed、fileChange、mcpToolCall、approval、artifact、providerSwitch、turnState。

每个事件至少包含：

```ts
{
  eventId: string
  logicalSessionId: string
  sessionSeq: number
  turnId?: string
  itemId?: string
  runtimeThreadId?: string
  providerId?: string
  createdAt: string
  type: string
}
```

`sessionSeq` 严格单调递增。`LocalSessionRecord.messages[]` 只作为迁移兼容层，最终页面从 Session Event Store 读取。

## 5. Phase B：Codex 原生结构化流式事件

直接消费锁定 Codex App Server 的原生事件，包括：

```text
item/started
item/agentMessage/delta
item/commandExecution/outputDelta
item/completed
turn/completed
```

及当前版本已经支持的其它 Item 类型。

命令卡片支持：命令、cwd、执行状态、实时 stdout/stderr、退出码、耗时、展开/收起、失败状态；同一个 itemId 更新同一张卡片。

文件修改支持：文件路径、added/modified/deleted、diff、状态。

优先复用现有 `apply-codex-item-rendering.mjs` 的 command/fileChange/MCP 映射，不维护第三套 mapper。reasoning/commentary 与最终回答分开。

## 6. Phase C：真正 API 流式转发

当前任何 `stream:false -> 完整等待 -> 再包装 SSE` 的伪流式路径需要替换。

- OpenAI-compatible：上游 `stream=true`，增量解析并转发。
- Anthropic：接入 content block/message 原生流式事件。
- Gemini：接入 streaming endpoint。
- Provider 确实不支持流式时允许工具事件实时、最终回答一次性返回，但禁止前端打字动画冒充真实流式。

## 7. Phase D：会话内模型与思考强度切换

输入区提供统一 Runtime Config：`[Provider] [Model] [Effort]`。

Codex 原生模型优先走 `model/list`，使用 displayName、supportedReasoningEfforts、defaultReasoningEffort、isDefault、hidden、serviceTiers；不要手写固定模型清单。

会话/Runtime Binding 保存 providerId、profileId、model、reasoningEffort、serviceTier（如适用）。同 Provider 下保持 logicalSessionId/runtimeThreadId，下一次 `turn/start` 用 Codex 原生 model/effort override。已经开始的 Turn 不伪装成中途已换模型，只改变下一 Turn 配置。

## 8. Phase E：API 服务商切换

例如 OpenAI GPT -> DeepSeek V4 时：页面、logicalSessionId、历史全部不变。禁止新建可见会话、清空聊天、要求用户重新描述任务。

切换时生成内部协议 `zero3.session-provider-handoff.v1`，至少包含：

```yaml
logical_session_id:
project_id:
from: { provider, profile_id, model, runtime_thread_id }
to:   { provider, profile_id, model }
shared_memory:
  context_manifest_ref:
  project_sequence:
  task_sequence:
  authority_refs:
  retrieval_refs:
  status:
coverage:
  covered_session_seq:
  covered_ranges:
uncovered_session_delta:
  start_seq:
  end_seq:
  events:
runtime_state:
  current_goal:
  completed_work:
  remaining_work:
  verified_results:
  blockers:
  active_files:
  artifacts:
  commit_refs:
handoff:
  generated_at:
  source_runtime_generation:
  target_runtime_generation:
```

## 9. Phase F：共享记忆 + 未覆盖 Session Delta

完整交接必须是：`Shared Memory + Uncovered Session Delta`。

共享记忆写入成功时记录 coverage（至少 `covered_session_seq`，后续支持 `covered_ranges`）。Provider 切换时按 sessionSeq 精确求差集，仅打包尚未进入共享记忆的事件；禁止依靠 LLM 猜哪些内容已记住，也不要抓 React DOM，必须从 Session Event Store 提取结构化内容。

## 10. Phase G：切换前 Memory Flush

标准流程：

```text
1 Pause new turn dispatch
2 Flush 当前待写入共享记忆
3 获取最新 project/task sequences
4 更新 coverage
5 计算 uncovered delta
6 构造 handoff
7 验证 handoff freshness
8 切换 Runtime Binding
9 resume 或创建目标 Runtime Thread
10 注入内部 handoff context
11 恢复发送
```

Shared Memory 不可用时不能直接丢上下文，也不能无条件阻止用户继续：使用 latest known shared memory + 全部未覆盖 delta，并标记 `shared_memory_status=stale/unavailable`。

## 11. Phase H：Runtime Thread 策略

能安全复用时优先 `thread/resume`，使用 Codex 原生 `modelProvider/model/config/cwd/developerInstructions` 等 override。

不同服务商无法安全复用原 runtime thread 时，内部创建新 runtime thread，但 logicalSessionId 不变：

```text
logicalSessionId
├── Runtime Thread #1 OpenAI
├── Runtime Thread #2 DeepSeek
└── Runtime Thread #3 Anthropic
```

## 12. Handoff 注入

交接信息不作为普通 User Message。按 Zero3 authority 优先级作为 internal/developer context 注入。页面最多展示轻量系统状态，例如“已切换至 DeepSeek V4；已继承共享记忆 + 7 条未同步上下文”。

## 13. Runtime Binding 与 generation

新增类似：

```ts
type Zero3SessionRuntimeBinding = {
  logicalSessionId: string
  generation: number
  provider: string
  profileId: string
  model: string
  reasoningEffort: string | null
  runtimeThreadId: string | null
  projectId: string
  cwd: string
  memoryProjectSequence: number
  memoryTaskSequence: number
  coveredSessionSeq: number
  updatedAt: string
}
```

每次 Provider 切换 generation +1，防止旧 Provider 切换完成后继续写入。

## 14. Writer Gate

Provider 切换状态机至少包含 ACTIVE / HANDOFF_PENDING / HANDOFF_VERIFYING / SWITCHING / FAILED。HANDOFF_PENDING/SWITCHING 时旧 Runtime 不能开新 Turn，新 Runtime 在验证完成前不能获得写权限；只能有一个 active writer。

## 15. 共享记忆治理保持不变

继续使用现有 `zero3.memory.handoff.v2`、project/task authority、native working memory、context manifest、sequence freshness。必须保持 `Zero3 authority > Provider native memory`，Provider native memory 永远 `working_memory_only`，不能自动覆盖用户决定、项目权威、任务权威。

## 16. 历史恢复

重开 Zero3 会话：加载 Logical Session + Event Store + Runtime Binding + Memory Coverage；可 resume 则恢复，不可 resume 则自动构造 recovery handoff。结构化历史必须恢复，不能退化成只有 user/assistant 纯文本。

## 17. UI

输入区建议：`[Provider] [Model · Effort]`。Provider 菜单来源于 Zero3 API Profiles；模型菜单按 Profile/Provider 能力过滤。时间线达到 Codex 风格：阶段说明、命令卡片（含耗时/输出）、文件修改/diff、最终回答按真实事件顺序显示。

## 18. 主要代码区域

重点现有路径：

```text
apps/zero3-desktop/ui-v2/conversations/LocalConversationSurface.tsx
apps/zero3-desktop/ui-v2/adapters/LocalSessionAdapter.ts
apps/zero3-desktop/ui-v2/conversations/session-types.ts
apps/zero3-desktop/ui-v2/conversations/SessionProviderPickerDialog.tsx
apps/zero3-desktop/scripts/apply-session-provider-runtime.mjs
apps/zero3-desktop/scripts/apply-codex-item-rendering.mjs
apps/zero3-desktop/agent-memory-runtime/
apps/zero3-desktop/executor-runtime/handoff/
```

Codex Renderer 必须改造为可复用真实数据 Renderer，清除 mock 依赖。

## 19. 数据迁移

旧 `LocalSessionRecord.messages[]` 首次打开时迁移为 Session Events，并记录 schemaVersion/migrationVersion；原数据短期只读保留用于回滚。

## 20. 测试矩阵

至少覆盖：同 Provider 切模型/effort；OpenAI→DeepSeek→Anthropic；Shared Memory 正常/离线；切换时旧 Turn 仍运行；Runtime 可/不可 resume；App 重启历史恢复；command 流式；file diff；API 不支持 stream；handoff sequence 落后；handoff hash/identity 错误；Writer Gate 防双写。

## 21. 实施优先级

P0：Session Event Store → Codex native event mapping → 结构化 UI → command/file/tool renderer → API 真流式。

P1：model/effort switching → Runtime Binding → Provider/Profile Picker → Provider Switch state machine。

P2：Memory Coverage → Uncovered Delta → Provider Handoff → Memory Flush → Writer Gate/generation。

P3：历史恢复 → 老数据迁移 → 异常恢复 → UI polish。

## 22. 完成标准

全部满足才算完成：
- Zero3 本体不再以纯字符串进度日志作为主要展示。
- Codex Item 生命周期完整进入 UI，命令流式、文件 diff 可恢复。
- API 上游支持时必须真流式。
- 会话内可切 model/effort/API Profile/API Provider。
- Provider 切换页面与 logicalSessionId 不变。
- 自动 handoff 同时包含共享记忆引用/sequence 与未覆盖 Session Delta。
- Delta 来源于 Event Store，不读 DOM。
- Shared Memory 离线可降级交接。
- Provider native memory 不覆盖 Zero3 authority。
- 切换期间始终只有一个 active writer。
- App 重启后结构化历史恢复。
- 静态检查、相关 unit/integration tests、UI build/architecture checks 全部通过。
- 最终形成 PR，完成审查后合并 `main` 并 push GitHub。

## 23. 执行规则

本任务是完整实现任务，不是调研或只写方案。开始前基于任务分支读取 `AGENTS.md` 和相关架构文档；开发时严格遵守 Zero3 项目规则。若任务过大，应在同一 GitHub execution branch 内分阶段 commit，不得以“已给方案”作为完成。交付必须给出 BASE_SHA、HEAD_SHA、PR_URL、变更文件、测试证据、未执行项、迁移/回滚、风险；只有完成标准全部满足才可声明 DONE。
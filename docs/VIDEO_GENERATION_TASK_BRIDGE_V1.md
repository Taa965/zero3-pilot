# Video Generation Task Bridge V1（video-generation-v1 生产闭环）

> 状态：已实现并通过本地全链路 E2E（`workflow-runtime/video-generation-task-bridge.test.ts`，6 例）。
> 本文描述 `video-generation-v1 / 视频生成任务` 从任务看板到完成看板的执行闭环与 fail-closed 语义。

## 1. 组成部分（不新增第二套状态系统）

| 层 | 模块 | 职责 |
|---|---|---|
| Workflow（模板） | `execution-runtime/workflows/video-generation.ts` | 8 步模板：intake → rewrite → visual → plan-production → image-production → cloud-production → jianying → final-verify |
| Task（实例） | `execution-runtime/` Execution Runtime | 唯一权威状态：Task / Step / Assignment / Session / Event Ledger / Completion Gate |
| 桥接驱动器 | `workflow-runtime/video-generation-task-bridge.ts` | 把 ZERO3 步骤桥接到 Worker Protocol v2，把工位结果回写 Execution Runtime |
| Worker v2 | `worker-runtime/v2/workflow-worker-runtime.ts` | WorkflowRun / StageRun / Claim / 租约 / 工件门禁；GPT Web 工位经 Station Manager 供给 |

架构原则：任务看板是 Task 实例的操作面；Workflow 只是模板。桥接驱动器不持有任何独立状态，
每次 reconcile 都从两个持久化权威（Execution Runtime JSON + Worker v2 SQLite）读取。

## 2. 步骤逐个闭环说明

| 步骤 | Executor | 执行方式 | 完成条件 |
|---|---|---|---|
| intake | HUMAN | 用户在任务看板「分配执行 → 登记产物（video-production-inputs.json）→ 提交审核 → 通过」 | 人工审核（required_outputs 门禁强制校验产物） |
| rewrite / visual | ZERO3 | 驱动器创建 Assignment + Session Binding，并 `installVideoGenerationWorkflow`（幂等）安装 Worker v2 运行；GPT Web 工位经真实 claim/commit 协议完成 Stage | 全部 Stage COMPLETED 且产物齐全 |
| plan-production | ZERO3 | 驱动器本地读取 visual JSON 产物 → `materializeVideoGenerationProductionPlan`（幂等，按 ≤10 张/批生成 image-batch + image-package Stage）→ 登记 production-plan.json | 自动门禁 |
| image-production | ZERO3 | 同 rewrite/visual，监控 image-batch / image-package Stage | 全部 Stage COMPLETED |
| cloud-production / jianying | ZERO3 | `hostCapability.run()` 端口；当前宿主能力未注册 → **fail closed（blocked，含 `BLOCKED_BY_EXTERNAL_CAPABILITY`）**；接入 Remote Compute / 剪映导出能力后自动推进 | 自动门禁 |
| final-verify | ZERO3 | 汇总六个前置步骤的真实产物清单，登记 production-manifest.json 后停在 verifying | **人工审核**（不可自动通过） |

## 3. 幂等 / 重启 / 并发安全

- Assignment：步骤已有 assignment 则跳过；attempt 预算由 Execution Runtime 强制（`maxAttempts`）。
- 安装/物化：`ensureWorkflowRun` + `addWorkItems(idempotencyKey)` 幂等，重放安全。
- 产物回写：确定性 `eventId`（task + step + assignment + logicalName 哈希），重放不产生重复事件。
- 重复执行：同一 Stage 不会重复 dispatch（claim 租约 + `attempts < max_attempts`）；驱动器按任务串行（per-task tail）。
- App 重启：驱动器无内存状态，tick 时从两个权威存储重建现场（有测试覆盖「新实例恢复」）。

## 4. 当前外部能力阻塞（BLOCKED_BY_EXTERNAL_CAPABILITY）

| 能力 | 状态 | 说明 |
|---|---|---|
| 真实 GPT Web 工位 | 待生产环境 | 需要桌面 app 运行、ChatGPT 登录会话与工位 Skill；协议层已由 E2E 用真实 Worker v2 API 验证 |
| 云端 GPU / Remotion（cloud-production） | **阻塞** | capability registry 未注册对应能力；驱动器按 fail-closed 进入 blocked，接入 Remote Compute 后解除 |
| 剪映导出（jianying） | **阻塞** | 同上，需要宿主剪映导出能力注册 |

真实 GPT Web 全链路生产验证需人工在桌面 app 中完成（涉及外部账号操作），本仓库 CI 不做伪造。

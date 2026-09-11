# Task archive & delete (V1)

任务模块的列表此前只能创建与查看，任务一旦产生就无法从列表中收走。本次为任务卡片补上右键菜单：**归档 / 取消归档 / 删除**。

## 语义

- **归档**是软性的“从日常视野里收走”：任务的定义、步骤、会话绑定、产物与事件历史全部保留，仅写入一条独立侧车记录并追加 `task.archived` / `task.unarchived` 审计事件。归档不改变任务定义版本，也不改变任何执行状态，因此可以在任务仍在执行时归档。
- **删除**是硬删除：整棵任务目录（`snapshot.json`、`events.jsonl`、`archive.json`）被移除，不可恢复。为防止外部执行方在无主任务上继续回报，只要仍有步骤处于活动状态（`dispatching` / `running` / `waiting_report` / `verifying`），删除会被拒绝并提示先取消或归档。

## 存储

归档标记存放在任务目录内的 `archive.json`（`zero3.pilot.execution-task-archive.v1`，原子写 + 校验和），**不进入**受 `validateExecutionWorkflowDefinition` 严格校验的快照契约。这样做有两个好处：

- 归档不需要递增 workflow revision，避免与执行状态写入互相覆盖；
- 老任务目录缺少该文件时自然回落为“未归档”，无需迁移。

## 契约与桥接

| 层 | 变更 |
| --- | --- |
| `execution-runtime/contracts.ts` | 新增 `ZERO3_EXECUTION_TASK_ARCHIVE`、`ExecutionTaskArchiveState`、`task.archived` / `task.unarchived` 事件类型；`ExecutionTaskSnapshot` 增加必填 `archived: boolean` |
| `execution-runtime/store.ts` | `readArchive` / `writeArchive` / `deleteTask`（拒绝删除执行库根目录之外的内容） |
| `execution-runtime/runtime.ts` | `setTaskArchived`（幂等）、`deleteTask`（活动步骤守卫）、`snapshot` 合并归档标记 |
| `desktop/{desktop-port,desktop-runtime,desktop-ipc}.ts` | 新增 `zero3:execution:set-task-archived`、`zero3:execution:delete-task` 两个 IPC 通道，参数在 IPC 边界做布尔与 ID 校验 |
| `scripts/apply-execution-runtime-bridge.mjs` | preload 桥接与 `global.d.ts` 声明同步新增 `setTaskArchived` / `deleteTask` |
| `ui-v2/tasks/*` | `TaskAdapter` 新增桥接方法与 `archived` 校验；`task-model` 新增 `archived` 筛选；`TaskList` 右键菜单 + 删除二次确认；`TaskWorkspace` 显示归档标记与事件标签 |

## 自动调度

归档是操作者“不要再调度它”的信号，因此两个自动化入口都会跳过归档任务：

- `worker-runtime/v2/autonomous-task-loop.ts`：`listTasks` 过滤中排除 `archived === true`；
- `worker-runtime/v2/lifecycle-runtime.ts`：`resolveTaskForSession` 的候选任务排除归档任务（仍可用显式 `taskId` 读取历史）。

## 界面行为

- 卡片右键打开菜单，菜单在列表面板内自动避让边界；点击别处、滚动、失焦或按 `Esc` 关闭。
- 新增「归档」筛选标签。归档任务只出现在该筛选下，其余筛选（全部 / 运行中 / 待审核 / 异常 / 已完成）一律不显示。
- 删除需要二次确认，对话框明确写出将永久删除的范围与不可撤销。
- 归档状态在卡片与详情页头以「已归档」标签呈现。

## 验证

```sh
node --experimental-transform-types --test \
  apps/zero3-desktop/tests/task-workspace.test.ts \
  apps/zero3-desktop/execution-runtime/execution-runtime.test.ts \
  apps/zero3-desktop/execution-runtime/execution-reporter.test.ts \
  apps/zero3-desktop/execution-runtime/execution-desktop-runtime.test.ts \
  apps/zero3-desktop/execution-runtime/workflows/workflows.test.ts \
  apps/zero3-desktop/worker-runtime/v2/autonomous-task-loop.test.ts \
  apps/zero3-desktop/worker-runtime/v2/lifecycle-runtime.test.ts

node --experimental-transform-types apps/zero3-desktop/tests/task-workspace.browser.mjs
```

单元测试覆盖：归档跨进程重启持久化、审计事件、幂等性、归档后从各活动筛选消失、删除清空持久化目录、活动步骤存在时拒绝删除。

浏览器验收在既有端到端流程之后追加：右键菜单出现、归档后从「全部」消失并在「归档」下可见、取消归档回到「全部」、确认删除后列表与持久化数据同时减少。

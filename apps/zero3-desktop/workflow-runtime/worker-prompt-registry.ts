const PROMPT_RULES: Record<string, string> = {
  'cognitive-store-script-worker.v1': '处理脚本重构 Claim；必须使用 Claim 指定 Skill，输出结构化脚本 Artifact。',
  'cognitive-store-visual-worker.v1': '处理视觉规划 Claim；必须依据上游脚本 Artifact，输出完整视觉规划 Artifact。',
  'cognitive-store-image-worker.v1': '处理图片生产 Claim；严格按 Claim 批次生成，不得自行扩大图片数量或扫描队列。'
}

export type WorkerBootstrapPromptInput = {
  workflowRunId: string
  workerDefinitionId: string
  workerSlotId: string
  role: string | null
  promptRevision: string | null
  bindingTicket: string
}

function text(value: unknown, label: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized
}

export function buildWorkerBootstrapPrompt(input: WorkerBootstrapPromptInput): string {
  const workflowRunId = text(input.workflowRunId, 'workflowRunId', 256)
  const workerSlotId = text(input.workerSlotId, 'workerSlotId', 256)
  const workerDefinitionId = text(input.workerDefinitionId, 'workerDefinitionId', 256)
  const ticket = text(input.bindingTicket, 'bindingTicket', 16_384)
  const revision = input.promptRevision?.trim() || 'zero3-worker-default.v1'
  const role = input.role?.trim() || workerDefinitionId
  const roleRule = PROMPT_RULES[revision] ?? '只执行 Zero3 Claim 返回的工作，所有状态以 Zero3 为准。'
  const prompt = [
    '你正在启动 Zero3 长期 Workflow 工位。',
    `岗位：${role}`,
    `WorkflowRun：${workflowRunId}`,
    `WorkerSlot：${workerSlotId}`,
    `PromptRevision：${revision}`,
    roleRule,
    `BindingTicket: ${ticket}`,
    '立即调用 bootstrap_worker(bindingTicket)，成功后调用 claim_work(bindingTicket,idempotencyKey)。',
    '禁止扫描队列、修改 Workflow、调 Codex/GPU/Shell；NO_WORK_AVAILABLE 时结束本轮并等待 Zero3 Wakeup。'
  ].join('\n')
  if (prompt.length > 2048) throw new Error('worker bootstrap prompt exceeds GPT wakeup message limit')
  return prompt
}

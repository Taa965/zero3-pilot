import type { ExecutionStepDefinition, ExecutionTaskDefinition, ExecutionTaskSnapshot } from '../../execution-runtime/contracts.ts'

export type TaskFilter = 'all' | 'running' | 'review' | 'error' | 'completed'
export type StepDraft = Omit<ExecutionStepDefinition, 'contract' | 'taskId' | 'createdAt'>
export type TaskInput = { task: Omit<ExecutionTaskDefinition, 'contract' | 'createdAt'>; steps: StepDraft[] }
export const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', pending: '待处理', waiting_dependency: '等待依赖', ready: '待执行',
  dispatching: '待启动', running: '运行中', waiting_report: '等待回报', verifying: '待审核',
  fix_required: '需要修改', waiting_human: '等待人工', blocked: '阻塞', failed: '失败',
  outcome_unknown: '结果未知', completed: '已完成', cancelled: '已取消'
}
export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status
export const percent = (progress: number) => `${Math.round(Math.max(0, Math.min(1, progress || 0)) * 100)}%`
export function matchesTask(task: ExecutionTaskSnapshot, filter: TaskFilter, query: string, projectId: string): boolean {
  const definition = task.definition.task
  if (projectId && (definition.projectId ?? '') !== projectId) return false
  if (!`${definition.taskId} ${definition.title} ${definition.goal}`.toLowerCase().includes(query.trim().toLowerCase())) return false
  const states = [task.runtime.task.status, ...task.runtime.steps.map(step => step.status)]
  if (filter === 'review') return states.some(state => ['verifying', 'waiting_human'].includes(state))
  if (filter === 'error') return states.some(state => ['blocked', 'failed', 'fix_required', 'outcome_unknown'].includes(state))
  if (filter === 'running') return states.some(state => ['dispatching', 'running', 'waiting_report'].includes(state)) && !['completed', 'cancelled'].includes(task.runtime.task.status)
  if (filter === 'completed') return task.runtime.task.status === 'completed'
  return true
}
export function makeStep(
  title: string,
  executor: StepDraft['executor'],
  dependsOn: string[] = [],
  requiredSkills: string[] = [],
  optionalSkills: string[] = []
): StepDraft {
  if (!title.trim()) throw new Error('请填写步骤目标')
  return { stepId: `step-${crypto.randomUUID()}`, title: title.trim(), objective: title.trim(), executor,
    dependsOn, requiredSkills, optionalSkills, inputArtifacts: [], expectedOutputs: [], completionGate: ['human_review'], maxAttempts: 3, metadata: {} }
}
export function makeTask(title: string, goal: string, projectId: string | null, steps: StepDraft[]): TaskInput {
  if (!title.trim() || !goal.trim() || steps.length === 0) throw new Error('请填写任务名称、目标和至少一个步骤')
  return { task: { taskId: `task-${crypto.randomUUID()}`, title: title.trim(), goal: goal.trim(), projectId,
    workflowId: null, maxParallelSteps: 1, createdBySessionId: null, metadata: { source: 'task-workspace' } }, steps }
}
export function taskArtifacts(snapshot: ExecutionTaskSnapshot, stepId?: string) {
  return snapshot.events.filter(event => event.type === 'artifact.produced' && (!stepId || event.stepId === stepId))
}
export function requiredOutputGaps(snapshot: ExecutionTaskSnapshot, stepId: string): string[] {
  const step = snapshot.definition.steps.find(item => item.stepId === stepId)
  const assignmentId = snapshot.runtime.steps.find(item => item.stepId === stepId)?.assignmentId
  const artifacts = taskArtifacts(snapshot, stepId).filter(event => event.assignmentId === assignmentId)
  return (step?.expectedOutputs ?? []).filter(output => {
    if (!output.required) return false
    const ids = new Set(artifacts.filter(event => event.payload?.logicalName === output.logicalName).map(event => event.payload?.artifactId ?? event.eventId))
    return ids.size < (output.minCount ?? 1)
  }).map(output => output.logicalName)
}

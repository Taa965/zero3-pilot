import { useEffect, useState, type FormEvent } from 'react'
import type { ExecutionTaskSnapshot } from '../../execution-runtime/contracts.ts'
import { allowedStepTransitions } from '../../execution-runtime/state-machine'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { autonomousBridge, readTaskSnapshots, readTaskWorkflows, taskBridge, type TaskWorkflowSummary } from './TaskAdapter'
import { useTasks } from './TaskContext'
import { percent, requiredOutputGaps, statusLabel, taskArtifacts } from './task-model'

const inputClass = 'w-full rounded border border-(--ui-border) bg-background p-2 text-sm'
const buttonClass = 'rounded border border-(--ui-border) px-3 py-1.5 text-sm hover:bg-(--ui-control-hover-background) disabled:cursor-not-allowed disabled:opacity-40'
const tabs = [['overview', '总览'], ['autonomy', '自主编排'], ['execution', '执行过程'], ['changes', '代码变更'], ['artifacts', '产物'], ['verification', '验证'], ['review', '审核'], ['timeline', '时间轴']]
const gateLabels: Record<string, string> = { human_review: '人工审核', required_outputs: '必需产物齐全' }
const eventLabels: Record<string, string> = {
  'task.created': '创建任务', 'task.state_changed': '任务状态更新', 'step.added': '添加步骤',
  'step.state_changed': '步骤状态更新', 'assignment.created': '创建执行分配', 'skill.preflight': 'Skill 能力预检', 'session.bound': '绑定会话',
  'session.state_changed': '会话状态更新', 'progress.updated': '进度回报', 'artifact.produced': '产物回报',
  'completion.requested': '提交审核', 'gate.passed': '审核通过', 'gate.failed': '要求修改',
  blocked: '标记阻塞', waiting_human: '转人工', outcome_unknown: '结果未知', 'task.completed': '任务完成',
  'task.archived': '归档任务', 'task.unarchived': '取消归档'
}
function JsonDetail({ value }: { value: unknown }) {
  return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-(--ui-pane-background) p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
}
function EventList({ events, empty }: { events: ExecutionTaskSnapshot['events']; empty: string }) {
  if (!events.length) return <p className="text-sm text-(--ui-text-secondary)">{empty}</p>
  return <div className="space-y-3">{[...events].reverse().map(event => <article key={event.eventId} className="rounded border border-(--ui-border) p-3">
    <div className="flex flex-wrap justify-between gap-2 text-sm"><span>#{event.sequence} {eventLabels[event.type] ?? event.type}</span><time className="text-xs text-(--ui-text-secondary)">{new Date(event.at).toLocaleString()}</time></div>
    {event.stepId && <div className="my-2 break-all text-xs text-(--ui-text-secondary)">步骤：{event.stepId}</div>}
    {event.payload && <div className="space-y-2 text-sm">
      {event.payload.source === 'human_task_review' && <p className="text-xs text-(--ui-text-secondary)">人工审核</p>}
      {['note', 'reason', 'activity', 'logicalName'].map(key => typeof event.payload?.[key] === 'string' ? <p key={key} className="whitespace-pre-wrap break-words">{String(event.payload[key])}</p> : null)}
      {typeof event.payload.to === 'string' && <p>{typeof event.payload.from === 'string' ? `${statusLabel(event.payload.from)} → ` : ''}{statusLabel(event.payload.to)}</p>}
      {typeof event.payload.progress === 'number' && <p>进度：{percent(event.payload.progress)}</p>}
      {typeof event.payload.diff === 'string' && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-(--ui-pane-background) p-3 text-xs">{event.payload.diff}</pre>}
      <details className="text-xs text-(--ui-text-secondary)"><summary className="cursor-pointer">查看完整记录</summary><JsonDetail value={event.payload} /></details>
    </div>}
  </article>)}</div>
}
function CreateAutonomousGoal({ project }: { project: Zero3ProjectRecord | null }) {
  const { busy, mutate, select, setCreating } = useTasks()
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [importance, setImportance] = useState<'low' | 'normal' | 'high' | 'critical'>('normal')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!project) return
    let id = ''
    const success = await mutate(async () => {
      const created = await autonomousBridge().createGoal({
        title, goal, projectId: project.id, workspace: project.rootPath ?? null, importance,
        requiredCapabilities: capabilities.split(',').map(item => item.trim()).filter(Boolean)
      })
      id = readTaskSnapshots([created])[0].definition.task.taskId
    })
    if (success) { select(id); setCreating(false) }
  }
  return <form onSubmit={event => void submit(event)} className="mx-auto max-w-2xl space-y-5 p-6">
    <div className="space-y-1"><h2 className="text-lg font-medium">新建自主目标</h2><p className="text-xs text-(--ui-text-secondary)">只定义最终目标。Zero3 会自动路由 Agent、派发会话、处理执行中发现的问题并持续恢复主线，直到 Completion Gate 完成。</p></div>
    {!project && <p className="rounded border border-amber-500/30 p-3 text-sm text-amber-600">自主目标必须归属一个项目，请先选择项目。</p>}
    <label className="block space-y-1 text-sm"><span>目标名称</span><input required value={title} onChange={event => setTitle(event.target.value)} className={inputClass} /></label>
    <label className="block space-y-1 text-sm"><span>最终目标</span><textarea required rows={8} value={goal} onChange={event => setGoal(event.target.value)} placeholder="描述最终要达成什么；不需要手动拆步骤。" className={inputClass} /></label>
    <label className="block space-y-1 text-sm"><span>所需能力（可选，逗号分隔）</span><input value={capabilities} onChange={event => setCapabilities(event.target.value)} placeholder="例如 software.development, git" className={inputClass} /></label>
    <label className="block space-y-1 text-sm"><span>重要级别</span><select value={importance} onChange={event => setImportance(event.target.value as typeof importance)} className={inputClass}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="critical">关键</option></select></label>
    <div className="flex gap-2"><button disabled={busy || !project} className={buttonClass}>{busy ? '正在启动…' : '启动自主目标'}</button><button type="button" disabled={busy} onClick={() => setCreating(false)} className={buttonClass}>取消</button></div>
  </form>
}

function obj(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(obj) : [] }

function CreateTask({ project }: { project: Zero3ProjectRecord | null }) {
  const { busy, mutate, select, setCreating } = useTasks()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [workflowId, setWorkflowId] = useState('')
  const [workflows, setWorkflows] = useState<TaskWorkflowSummary[]>([])
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void taskBridge().listTaskWorkflows().then(value => {
      if (!active) return
      const rows = readTaskWorkflows(value)
      setWorkflows(rows)
      setWorkflowId(current => current || rows[0]?.id || '')
    }).catch(error => {
      if (active) setWorkflowError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [])
  const selectedWorkflow = workflows.find(item => item.id === workflowId) ?? null
  const needsProductionProfile = selectedWorkflow?.requiresProductionProfile === true
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (needsProductionProfile && !project) return
    let id = ''
    const success = await mutate(async () => {
      const created = await taskBridge().createWorkflowTask({
        title, description, projectId: project?.id ?? null,
        workspace: project?.rootPath ?? null, workflowId
      })
      id = readTaskSnapshots([created])[0].definition.task.taskId
    })
    if (success) { select(id); setCreating(false) }
  }
  return <form onSubmit={event => void submit(event)} className="mx-auto max-w-2xl space-y-5 p-6">
    <div className="space-y-1">
      <h2 className="text-lg font-medium">新建任务</h2>
      <p className="text-xs text-(--ui-text-secondary)">所属项目：{project?.name ?? '无项目'}。工作流模块会自动生成执行步骤、Agent、Skill、依赖与审核规则。</p>
    </div>
    {needsProductionProfile && !project && <p role="alert" className="rounded border border-amber-500/30 p-3 text-sm text-amber-600">该工作流需要项目生产配置，请先在「项目」中选择一个项目，再创建任务。</p>}
    <label className="block space-y-1 text-sm"><span>任务名称</span><input required value={title} onChange={event => setTitle(event.target.value)} className={inputClass} /></label>
    <label className="block space-y-1 text-sm"><span>任务说明</span><textarea required rows={6} value={description} onChange={event => setDescription(event.target.value)} placeholder="说明要完成什么、背景、约束和期望结果" className={inputClass} /></label>
    <label className="block space-y-1 text-sm">
      <span>工作流</span>
      <select aria-label="工作流" required value={workflowId} disabled={!workflows.length} onChange={event => setWorkflowId(event.target.value)} className={inputClass}>
        {!workflows.length && <option value="">正在加载工作流…</option>}
        {workflows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    {selectedWorkflow && <div className="rounded border border-(--ui-border) bg-(--ui-pane-background) p-3 text-xs text-(--ui-text-secondary)">
      <div className="font-medium text-foreground">{selectedWorkflow.name}</div>
      <div className="mt-1">{selectedWorkflow.description}</div>
      {needsProductionProfile && <div className="mt-2 rounded border border-amber-500/30 p-2 text-amber-600">此工作流要求生产配置：第一步「生产输入与项目配置」由人工完成——任务创建后，请在该步骤登记生产输入（video-production-inputs.json），Zero3 之后的步骤才会自动推进。</div>}
      <div className="mt-2 text-(--ui-text-tertiary)">分类：{selectedWorkflow.category} · 模块版本：{selectedWorkflow.revision}</div>
    </div>}
    {workflowError && <p role="alert" className="text-sm text-red-500">{workflowError}</p>}
    <div className="flex gap-2"><button disabled={busy || !workflowId || (needsProductionProfile && !project)} className={buttonClass}>{busy ? '正在创建…' : '创建任务'}</button><button type="button" disabled={busy} onClick={() => setCreating(false)} className={buttonClass}>取消</button></div>
  </form>
}
function AutonomousPanel({ snapshot }: { snapshot: ExecutionTaskSnapshot }) {
  const { busy, mutate } = useTasks()
  const [dashboard, setDashboard] = useState<Record<string, unknown> | null>(null)
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const projectId = snapshot.definition.task.projectId
  const lineage = obj(snapshot.definition.task.metadata?.autonomousLineage)
  const rootTaskId = typeof lineage.rootTaskId === 'string' ? lineage.rootTaskId : snapshot.definition.task.metadata?.autonomousRootGoal === true ? snapshot.definition.task.taskId : null
  const load = async () => {
    if (!projectId) return
    try {
      setDashboard(obj(await autonomousBridge().dashboard(projectId, rootTaskId)))
      setDashboardError(null)
    } catch (error) { setDashboardError(error instanceof Error ? error.message : String(error)) }
  }
  useEffect(() => { void load() }, [projectId, rootTaskId, snapshot.runtime.task.updatedAt])
  if (!projectId) return <p className="text-sm text-(--ui-text-secondary)">此任务没有项目归属，无法启用自主编排。</p>
  const review = obj(dashboard?.dailyReview)
  const status = obj(dashboard?.status)
  const plugin = obj(status.pluginBaseline)
  const plan = obj(dashboard?.plan)
  const graph = obj(dashboard?.executionGraph)
  const attention = rows(dashboard?.humanAttention)
  const actions = rows(plan.actions)
  const nodes = rows(graph.nodes)
  const edges = rows(graph.edges)
  const reconcile = () => { void mutate(() => autonomousBridge().reconcileProject(projectId)).then(() => void load()) }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium">自主编排</h3><p className="text-xs text-(--ui-text-secondary)">Zero3 按 Root Goal 持续协调任务、Agent、会话和计划外问题。</p></div><button type="button" disabled={busy} onClick={reconcile} className={buttonClass}>{busy ? '协调中…' : '立即协调'}</button></div>
    {dashboardError && <p className="rounded border border-red-500/30 p-3 text-sm text-red-500">{dashboardError}</p>}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[['Root任务', review.userRootTasks], ['自动任务', review.autonomousTasks], ['发现问题', review.discoveredCandidates], ['需要介入', review.humanAttention]].map(([label, value]) => <div key={String(label)} className="rounded border border-(--ui-border) p-3"><div className="text-xs text-(--ui-text-secondary)">{String(label)}</div><div className="mt-1 text-xl font-medium">{Number(value ?? 0)}</div></div>)}
    </div>
    <div className="rounded border border-(--ui-border) p-3 text-sm"><div className="font-medium">能力基线</div><div className="mt-1 text-xs text-(--ui-text-secondary)">{plugin.ready === true ? '已就绪：统一 Agent Dispatch / Session / Memory 能力可用于自主执行。' : `未完全就绪：${Array.isArray(plugin.missing) ? plugin.missing.join('、') : '状态未知'}`}</div></div>
    <section className="space-y-2"><h4 className="text-sm font-medium">Human Attention · {attention.length}</h4>{attention.length === 0 ? <p className="text-xs text-(--ui-text-secondary)">当前没有必须由你处理的问题。</p> : attention.map(item => <div key={String(item.sourceKey)} className="rounded border border-amber-500/30 p-3 text-sm"><div className="font-medium text-amber-600">{String(item.reason ?? '需要人工处理')}</div><div className="mt-1 text-xs text-(--ui-text-secondary)">{String(item.taskId ?? item.sourceKey ?? '')}</div></div>)}</section>
    <section className="space-y-2"><h4 className="text-sm font-medium">下一步计划 · {actions.length}</h4>{actions.length === 0 ? <p className="text-xs text-(--ui-text-secondary)">当前没有新的计划动作。</p> : actions.map(action => <div key={String(action.actionId)} className="rounded border border-(--ui-border) p-3 text-sm"><div className="flex justify-between gap-2"><span className="font-medium">{String(action.title ?? '')}</span><span className="text-xs text-blue-500">{String(action.type ?? '')}</span></div><p className="mt-1 text-xs text-(--ui-text-secondary)">{String(action.reason ?? '')}</p></div>)}</section>
    <section className="space-y-2"><h4 className="text-sm font-medium">Execution Graph · {nodes.length} 节点 / {edges.length} 关系</h4><div className="max-h-72 space-y-1 overflow-y-auto rounded border border-(--ui-border) p-3 text-xs">{nodes.map(node => <div key={String(node.id)} className="flex justify-between gap-2"><span className="truncate">{String(node.kind)} · {String(node.label)}</span><span className="shrink-0 text-(--ui-text-tertiary)">{String(node.status ?? '')}</span></div>)}</div></section>
  </div>
}

function StepControl({ snapshot, stepId, review }: { snapshot: ExecutionTaskSnapshot; stepId: string; review: boolean }) {
  const { busy, mutate } = useTasks()
  const step = snapshot.definition.steps.find(item => item.stepId === stepId)!
  const state = snapshot.runtime.steps.find(item => item.stepId === stepId)!
  const [reason, setReason] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [artifactName, setArtifactName] = useState('')
  const [artifactContent, setArtifactContent] = useState('')
  const routedExecutor = state.skillPreflight?.executor ?? null
  const needsSkillRouting = step.executor === 'AUTO' || Boolean(step.requiredSkills?.length || step.optionalSkills?.length)
  const transitions = allowedStepTransitions(state.status)
  const terminal = ['completed', 'cancelled'].includes(snapshot.runtime.task.status)
  const gaps = requiredOutputGaps(snapshot, stepId)
  const assignment = snapshot.runtime.assignments.find(item => item.assignmentId === state.assignmentId)
  const bindings = snapshot.runtime.sessionBindings.filter(item => item.assignmentId === state.assignmentId)
  const dependencyCancelled = state.status === 'waiting_dependency' && step.dependsOn.some(id => snapshot.runtime.steps.find(item => item.stepId === id)?.status === 'cancelled')
  const canReportArtifacts = !terminal && Boolean(assignment) && step.expectedOutputs.length > 0 &&
    ['dispatching', 'running', 'waiting_report', 'fix_required'].includes(state.status)
  const run =(operation: () => Promise<unknown>) => { void mutate(operation).then(ok => { if (ok) { setReason(''); setArtifactContent('') } }) }
  const assign = async () => {
    const bridge = taskBridge()
    if (!needsSkillRouting) return bridge.createAssignment(snapshot.definition.task.taskId, stepId, step.executor)
    await bridge.refreshSkillPreflight(snapshot.definition.task.taskId)
    if (step.executor === 'AUTO') return bridge.createRoutedAssignment(snapshot.definition.task.taskId, stepId)
    return bridge.createAssignment(snapshot.definition.task.taskId, stepId, step.executor)
  }
  return <article className="space-y-3 rounded-lg border border-(--ui-border) p-4">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-medium">{step.title}</h3><span className="text-xs text-blue-500">{statusLabel(state.status)} · {percent(state.progress)}</span></div>
    <p className="whitespace-pre-wrap text-sm text-(--ui-text-secondary)">{step.objective}</p>
    <p className="text-xs text-(--ui-text-secondary)">{step.executor} · 尝试 {state.attempt}/{step.maxAttempts} · 前置：{step.dependsOn.map(id => snapshot.definition.steps.find(item => item.stepId === id)?.title ?? id).join('、') || '无'}</p>
    {!!(step.requiredSkills?.length || step.optionalSkills?.length) && <div className="flex flex-wrap gap-1 text-[10px]">
      {(step.requiredSkills ?? []).map(skill => <span key={`r:${skill}`} className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-500">必需 · {skill}</span>)}
      {(step.optionalSkills ?? []).map(skill => <span key={`o:${skill}`} className="rounded bg-(--ui-control-active-background) px-1.5 py-0.5 text-(--ui-text-secondary)">可选 · {skill}</span>)}
    </div>}
    {state.skillPreflight && <p className={`text-xs ${state.skillPreflight.state === 'blocked' ? 'text-amber-500' : 'text-(--ui-text-secondary)'}`}>Skill 预检：{state.skillPreflight.state} · {state.skillPreflight.adapterMode} · 推荐 {state.skillPreflight.executor ?? '未路由'}{state.skillPreflight.missingRequiredSkills.length ? ` · 缺少 ${state.skillPreflight.missingRequiredSkills.join('、')}` : ''}</p>}
    {state.currentActivity && <p className="text-sm">{state.currentActivity}</p>}
    {state.blocker && <p className="whitespace-pre-wrap text-sm text-amber-500">{state.blocker}</p>}
    {dependencyCancelled && <p className="text-sm text-amber-500">前置步骤已取消，此步骤无法开始；如不再需要，请填写说明后取消此步骤。</p>}
    {review ? <>
      <p className="text-xs">验收规则：{step.completionGate.map(gate => gateLabels[gate] ?? gate).join('、') || '未指定'}</p>
      <p className="text-xs">预期产物：{step.expectedOutputs.map(output => `${output.logicalName}${output.required ? '（必需）' : ''}`).join('、') || '未指定'}</p>
      {gaps.length > 0 && <p className="text-xs text-amber-500">尚缺本次执行的产物回报：{gaps.join('、')}</p>}
      <EventList events={snapshot.events.filter(event => event.stepId === stepId && ['completion.requested', 'gate.passed', 'gate.failed'].includes(event.type))} empty="尚无审核记录。" />
    </> : <>
      {bindings.map(binding => <p key={binding.bindingId} className="break-all text-xs">会话：{binding.logicalSessionId} · {binding.state}</p>)}
      {!terminal && ['ready', 'fix_required'].includes(state.status) && <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {needsSkillRouting && <button type="button" disabled={busy} className={buttonClass} onClick={() => run(() => taskBridge().refreshSkillPreflight(snapshot.definition.task.taskId))}>重新预检 Skill</button>}
          <button type="button" disabled={busy || state.attempt >= step.maxAttempts} className={buttonClass} onClick={() => run(assign)}>{!needsSkillRouting ? '分配执行' : step.executor === 'AUTO' ? `自动路由并分配${routedExecutor ? ` · ${routedExecutor}` : ''}` : `预检并分配 · ${step.executor}`}</button>
        </div>
        {needsSkillRouting && <p className="text-xs text-(--ui-text-secondary)">Required Skills 未通过预检时禁止分配；AUTO 只使用能力预检推荐的 Agent。</p>}
      </div>}
      {!terminal && assignment && !['completed', 'cancelled', 'failed'].includes(state.status) && !bindings.some(binding => binding.state !== 'closed') && <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); run(() => taskBridge().bindSession(assignment.assignmentId, { logicalSessionId: sessionId.trim() })) }}>
        <input required aria-label={`${step.title}会话编号`} value={sessionId} onChange={event => setSessionId(event.target.value)} placeholder="执行方的真实会话编号" className={inputClass} />
        <button disabled={busy || !sessionId.trim()} className={buttonClass}>绑定会话</button>
      </form>}
      {canReportArtifacts && <form className="space-y-2 rounded border border-(--ui-border) p-3" onSubmit={event => {
        event.preventDefault()
        const logicalName = artifactName.trim()
        if (!logicalName) return
        run(() => taskBridge().recordArtifact(snapshot.definition.task.taskId, stepId, {
          logicalName,
          kind: /json$/i.test(logicalName) ? 'json' : 'text',
          mimeType: /json$/i.test(logicalName) ? 'application/json' : 'text/plain',
          content: artifactContent.trim() || undefined,
          reportedBy: 'task-board'
        }))
      }}>
        <p className="text-xs text-(--ui-text-secondary)">人工步骤产物登记：填写预期产物名并粘贴内容，登记后才能通过完成门禁。尚缺：{gaps.length ? gaps.join('、') : '无'}</p>
        <div className="flex flex-wrap gap-2">
          <input required aria-label={`${step.title}产物名称`} list={`${stepId}-outputs`} value={artifactName} onChange={event => setArtifactName(event.target.value)} placeholder="产物名称（如 video-production-inputs.json）" className={`${inputClass} max-w-xs flex-1`} />
          <datalist id={`${stepId}-outputs`}>{step.expectedOutputs.map(output => <option key={output.logicalName} value={output.logicalName} />)}</datalist>
          <button disabled={busy || !artifactName.trim()} className={buttonClass}>登记产物</button>
        </div>
        <textarea aria-label={`${step.title}产物内容`} rows={4} value={artifactContent} onChange={event => setArtifactContent(event.target.value)} placeholder="产物内容（JSON 或文本；也可留空仅登记名称）" className={inputClass} />
      </form>}
    </>}
    {!terminal && transitions.length > 0 && <>
      <textarea aria-label={`${step.title}处理说明`} rows={2} value={reason} onChange={event => setReason(event.target.value)} placeholder={review ? '填写审核依据或要求修改的原因' : '填写状态处理原因'} className={inputClass} />
      <div className="flex flex-wrap gap-2">
        {review && state.status === 'verifying' && <>
          <button type="button" disabled={busy || !reason.trim() || gaps.length > 0} className={buttonClass} onClick={() => run(() => taskBridge().gatePassed(snapshot.definition.task.taskId, stepId, { source: 'human_task_review', note: reason.trim(), assignmentId: state.assignmentId }))}>通过</button>
          <button type="button" disabled={busy || !reason.trim()} className={buttonClass} onClick={() => run(() => taskBridge().gateFailed(snapshot.definition.task.taskId, stepId, reason.trim()))}>要求修改</button>
        </>}
        {(['blocked', 'waiting_human', 'ready', 'running', 'verifying', 'cancelled'] as const).filter(target => (!review || target === 'blocked' || target === 'waiting_human') && (!['running', 'verifying'].includes(target) || !!assignment) && !(target === 'ready' && state.status === 'waiting_dependency') && transitions.includes(target)).map(target => <button key={target} type="button" disabled={busy || !reason.trim()} className={buttonClass} onClick={() => run(() => taskBridge().transitionStep(snapshot.definition.task.taskId, stepId, target, reason.trim()))}>
          {({ blocked: '标记阻塞', waiting_human: '转人工', ready: '恢复待执行', running: '恢复执行', verifying: '提交审核', cancelled: '取消步骤' })[target]}
        </button>)}
      </div>
    </>}
  </article>
}
export function TaskWorkspace({ project = null }: { project?: Zero3ProjectRecord | null }) {
  const { tasks, selectedId, creating, setCreating, creatingMode, setCreatingMode, loading, error } = useTasks()
  const [activeTab, setActiveTab] = useState('overview')
  const snapshot = tasks.find(task => task.definition.task.taskId === selectedId)
  if (creating) return <div className="h-full overflow-y-auto">{creatingMode === 'goal' ? <CreateAutonomousGoal project={project} /> : <CreateTask project={project} />}</div>
  if (!snapshot) return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-(--ui-text-secondary)"><p>{loading ? '正在加载任务…' : error ? '任务服务暂不可用，请刷新重试。' : '选择一个任务查看详情，或创建新任务。'}</p><div className="flex gap-2"><button type="button" onClick={() => { setCreatingMode('goal'); setCreating(true) }} className={buttonClass}>自主目标</button><button type="button" onClick={() => { setCreatingMode('task'); setCreating(true) }} className={buttonClass}>新建任务</button></div></div>
  const task = snapshot.definition.task
  const artifacts = taskArtifacts(snapshot)
  const changes = artifacts.filter(event => /diff|patch|code.?change/i.test(String(event.payload?.kind ?? '')) || typeof event.payload?.diff === 'string' || Array.isArray(event.payload?.changedFiles))
  return <div className="flex h-full min-w-0 flex-col bg-background">
    <header className="shrink-0 space-y-2 border-b border-(--ui-border) px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-lg font-medium">{task.title}</h2>
          {task.metadata?.autonomousRootGoal === true && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600">自主目标</span>}
          {task.metadata?.autonomous === true && task.metadata?.autonomousRootGoal !== true && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-500">AUTO</span>}
          {snapshot.archived && <span className="rounded bg-(--ui-control-active-background) px-1.5 py-0.5 text-[11px] text-(--ui-text-secondary)">已归档</span>}
        </div>
        <span className="text-sm text-blue-500">{statusLabel(snapshot.runtime.task.status)} · {percent(snapshot.runtime.task.progress)}</span>
      </div>
      <div className="break-all text-xs text-(--ui-text-tertiary)">{task.taskId}</div>
    </header>
    <nav aria-label="任务详情页签" className="flex shrink-0 gap-5 overflow-x-auto border-b border-(--ui-border) px-6">{tabs.map(([id, label]) => <button type="button" key={id} aria-current={activeTab === id ? 'page' : undefined} onClick={() => setActiveTab(id)} className={`whitespace-nowrap border-b-2 py-3 text-sm ${activeTab === id ? 'border-blue-500 text-blue-500' : 'border-transparent text-(--ui-text-secondary)'}`}>{label}</button>)}</nav>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6" key={`${task.taskId}:${activeTab}`}>
      {activeTab === 'overview' && <>
        <h3 className="font-medium">任务说明</h3><p className="whitespace-pre-wrap text-sm">{task.goal}</p>
        <div className="grid gap-3 text-sm sm:grid-cols-2"><p>项目：{task.projectId ?? '无项目'}</p><p>工作流：{String(task.metadata.workflowName ?? task.workflowId ?? '自定义任务')}</p><p>步骤：{snapshot.runtime.steps.filter(step => step.status === 'completed').length}/{snapshot.runtime.steps.length} 已完成</p><p>最大并行步骤：{task.maxParallelSteps}</p><p>创建：{new Date(task.createdAt).toLocaleString()}</p><p>更新：{new Date(snapshot.runtime.task.updatedAt).toLocaleString()}</p></div>
        {[...snapshot.runtime.task.blockers, ...snapshot.runtime.steps.flatMap(step => step.blocker ? [step.blocker] : [])].map((blocker, index) => <p key={index} className="text-sm text-amber-500">{blocker}</p>)}
        <h3 className="font-medium">步骤状态</h3>{snapshot.definition.steps.map(step => { const state = snapshot.runtime.steps.find(item => item.stepId === step.stepId)!; return <div key={step.stepId} className="space-y-1 border-b border-(--ui-border) py-2 text-sm"><div className="flex justify-between gap-3"><span>{step.title}</span><span>{statusLabel(state.status)}</span></div>{!!step.requiredSkills?.length && <div className="text-xs text-blue-500">Required Skills：{step.requiredSkills.join('、')}</div>}{state.skillPreflight?.executor && <div className="text-xs text-(--ui-text-tertiary)">推荐 Agent：{state.skillPreflight.executor} · {state.skillPreflight.adapterMode}</div>}</div>})}
      </>}
      {activeTab === 'autonomy' && <AutonomousPanel snapshot={snapshot} />}
      {(activeTab === 'execution' || activeTab === 'review') && <>
        {snapshot.definition.steps.length === 0 && <p className="text-sm text-(--ui-text-secondary)">尚未添加步骤。</p>}
        {snapshot.definition.steps.map(step => <StepControl key={step.stepId} snapshot={snapshot} stepId={step.stepId} review={activeTab === 'review'} />)}
      </>}
      {activeTab === 'changes' && <EventList events={changes} empty="尚未收到代码差异回报。执行方可将 diff、patch 或 changedFiles 随产物回报记录。" />}
      {activeTab === 'artifacts' && <><p className="text-xs text-(--ui-text-secondary)">以下为执行方回报的产物记录。文件是否已归档以产物中的存储证据为准。</p><EventList events={artifacts} empty="尚未收到产物回报。" /></>}
      {activeTab === 'verification' && <><p className="text-xs text-(--ui-text-secondary)">验证依据来自完成请求和审核记录；人工审核与自动测试结果分别以记录内容为准。</p><EventList events={snapshot.events.filter(event => ['completion.requested', 'gate.passed', 'gate.failed'].includes(event.type))} empty="尚无验证证据。" /></>}
      {activeTab === 'timeline' && <EventList events={snapshot.events} empty="尚无事件。" />}
    </div>
  </div>
}

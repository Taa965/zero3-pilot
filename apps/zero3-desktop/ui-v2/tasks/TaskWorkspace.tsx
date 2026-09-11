import { useState, type FormEvent } from 'react'
import type { ExecutionExecutorTarget, ExecutionTaskSnapshot } from '../../execution-runtime/contracts.ts'
import { allowedStepTransitions } from '../../execution-runtime/state-machine'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { taskBridge } from './TaskAdapter'
import { useTasks } from './TaskContext'
import { makeStep, makeTask, percent, requiredOutputGaps, statusLabel, taskArtifacts } from './task-model'

const inputClass = 'w-full rounded border border-(--ui-border) bg-background p-2 text-sm'
const buttonClass = 'rounded border border-(--ui-border) px-3 py-1.5 text-sm hover:bg-(--ui-control-hover-background) disabled:cursor-not-allowed disabled:opacity-40'
const executors: ExecutionExecutorTarget[] = ['AUTO', 'CODEX', 'GPT_WEB', 'GEMINI_WEB', 'CLAUDE', 'ANTIGRAVITY', 'ZERO3', 'REMOTE_COMPUTE', 'HUMAN']
const skillList = (value: string) => [...new Set(value.split(/[，,\n]/u).map(item => item.trim()).filter(Boolean))]
const tabs = [['overview', '总览'], ['execution', '执行过程'], ['changes', '代码变更'], ['artifacts', '产物'], ['verification', '验证'], ['review', '审核'], ['timeline', '时间轴']]
const gateLabels: Record<string, string> = { human_review: '人工审核', required_outputs: '必需产物齐全' }
const eventLabels: Record<string, string> = {
  'task.created': '创建任务', 'task.state_changed': '任务状态更新', 'step.added': '添加步骤',
  'step.state_changed': '步骤状态更新', 'assignment.created': '创建执行分配', 'skill.preflight': 'Skill 能力预检', 'session.bound': '绑定会话',
  'session.state_changed': '会话状态更新', 'progress.updated': '进度回报', 'artifact.produced': '产物回报',
  'completion.requested': '提交审核', 'gate.passed': '审核通过', 'gate.failed': '要求修改',
  blocked: '标记阻塞', waiting_human: '转人工', outcome_unknown: '结果未知', 'task.completed': '任务完成'
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
function CreateTask({ project }: { project: Zero3ProjectRecord | null }) {
  const { busy, mutate, select, setCreating } = useTasks()
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [stepText, setStepText] = useState('')
  const [executor, setExecutor] = useState<ExecutionExecutorTarget>('AUTO')
  const [requiredSkills, setRequiredSkills] = useState('')
  const [optionalSkills, setOptionalSkills] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    let id = ''
    const success = await mutate(async () => {
      const required = skillList(requiredSkills)
      const optional = skillList(optionalSkills)
      const steps = stepText.split('\n').map(line => line.trim()).filter(Boolean).map(line => makeStep(line, executor, [], required, optional))
      for (let i = 1; i < steps.length; i++) steps[i].dependsOn = [steps[i - 1].stepId]
      const input = makeTask(title, goal, project?.id ?? null, steps)
      id = input.task.taskId
      await taskBridge().createTask(input)
    })
    if (success) { select(id); setCreating(false) }
  }
  return <form onSubmit={event => void submit(event)} className="mx-auto max-w-2xl space-y-4 p-6">
    <h2 className="text-lg font-medium">新建任务</h2>
    <p className="text-xs text-(--ui-text-secondary)">所属项目：{project?.name ?? '无项目'}。创建后可在执行过程中分配步骤、绑定执行会话。</p>
    <label className="block space-y-1 text-sm"><span>任务名称</span><input required value={title} onChange={event => setTitle(event.target.value)} className={inputClass} /></label>
    <label className="block space-y-1 text-sm"><span>目标与验收要求</span><textarea required rows={4} value={goal} onChange={event => setGoal(event.target.value)} className={inputClass} /></label>
    <label className="block space-y-1 text-sm"><span>执行方</span><select value={executor} onChange={event => setExecutor(event.target.value as ExecutionExecutorTarget)} className={inputClass}>{executors.map(item => <option key={item}>{item}</option>)}</select></label>
    <label className="block space-y-1 text-sm"><span>Required Skills（逗号分隔）</span><input value={requiredSkills} onChange={event => setRequiredSkills(event.target.value)} placeholder="cognitive-store-script" className={inputClass} /></label>
    <label className="block space-y-1 text-sm"><span>Optional Skills（逗号分隔）</span><input value={optionalSkills} onChange={event => setOptionalSkills(event.target.value)} placeholder="可留空" className={inputClass} /></label>
    <label className="block space-y-1 text-sm"><span>步骤（每行一个，按顺序执行）</span><textarea required rows={5} value={stepText} onChange={event => setStepText(event.target.value)} className={inputClass} /></label>
    <div className="flex gap-2"><button disabled={busy} className={buttonClass}>{busy ? '正在保存…' : '创建任务'}</button><button type="button" disabled={busy} onClick={() => setCreating(false)} className={buttonClass}>取消</button></div>
  </form>
}
function AddStep({ snapshot }: { snapshot: ExecutionTaskSnapshot }) {
  const { busy, mutate } = useTasks()
  const [title, setTitle] = useState('')
  const [dependency, setDependency] = useState('')
  const [executor, setExecutor] = useState<ExecutionExecutorTarget>('AUTO')
  const [requiredSkills, setRequiredSkills] = useState('')
  const [optionalSkills, setOptionalSkills] = useState('')
  return <form className="space-y-2 rounded border border-(--ui-border) p-3" onSubmit={event => {
    event.preventDefault()
    void mutate(() => taskBridge().addSteps(snapshot.definition.task.taskId, [makeStep(title, executor, dependency ? [dependency] : [], skillList(requiredSkills), skillList(optionalSkills))])).then(ok => { if (ok) { setTitle(''); setRequiredSkills(''); setOptionalSkills('') } })
  }}>
    <h3 className="text-sm font-medium">添加步骤</h3>
    <input aria-label="新增步骤目标" required value={title} onChange={event => setTitle(event.target.value)} placeholder="步骤目标" className={inputClass} />
    <input aria-label="新增步骤 Required Skills" value={requiredSkills} onChange={event => setRequiredSkills(event.target.value)} placeholder="Required Skills，逗号分隔" className={inputClass} />
    <input aria-label="新增步骤 Optional Skills" value={optionalSkills} onChange={event => setOptionalSkills(event.target.value)} placeholder="Optional Skills，逗号分隔" className={inputClass} />
    <div className="flex flex-wrap gap-2">
      <select aria-label="新增步骤执行方" value={executor} onChange={event => setExecutor(event.target.value as ExecutionExecutorTarget)} className={inputClass}>{executors.map(item => <option key={item}>{item}</option>)}</select>
      <select aria-label="前置步骤" value={dependency} onChange={event => setDependency(event.target.value)} className={inputClass}><option value="">无前置步骤</option>{snapshot.definition.steps.map(step => <option key={step.stepId} value={step.stepId}>{step.title}</option>)}</select>
      <button disabled={busy} className={buttonClass}>添加步骤</button>
    </div>
  </form>
}
function StepControl({ snapshot, stepId, review }: { snapshot: ExecutionTaskSnapshot; stepId: string; review: boolean }) {
  const { busy, mutate } = useTasks()
  const step = snapshot.definition.steps.find(item => item.stepId === stepId)!
  const state = snapshot.runtime.steps.find(item => item.stepId === stepId)!
  const [reason, setReason] = useState('')
  const [sessionId, setSessionId] = useState('')
  const routedExecutor = state.skillPreflight?.executor ?? null
  const transitions = allowedStepTransitions(state.status)
  const terminal = ['completed', 'cancelled'].includes(snapshot.runtime.task.status)
  const gaps = requiredOutputGaps(snapshot, stepId)
  const assignment = snapshot.runtime.assignments.find(item => item.assignmentId === state.assignmentId)
  const bindings = snapshot.runtime.sessionBindings.filter(item => item.assignmentId === state.assignmentId)
  const dependencyCancelled = state.status === 'waiting_dependency' && step.dependsOn.some(id => snapshot.runtime.steps.find(item => item.stepId === id)?.status === 'cancelled')
  const run =(operation: () => Promise<unknown>) => { void mutate(operation).then(ok => { if (ok) setReason('') }) }
  const assign = async () => {
    const bridge = taskBridge()
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
          <button type="button" disabled={busy} className={buttonClass} onClick={() => run(() => taskBridge().refreshSkillPreflight(snapshot.definition.task.taskId))}>重新预检 Skill</button>
          <button type="button" disabled={busy || state.attempt >= step.maxAttempts} className={buttonClass} onClick={() => run(assign)}>{step.executor === 'AUTO' ? `自动路由并分配${routedExecutor ? ` · ${routedExecutor}` : ''}` : `预检并分配 · ${step.executor}`}</button>
        </div>
        <p className="text-xs text-(--ui-text-secondary)">Required Skills 未通过预检时禁止分配；AUTO 只使用能力预检推荐的 Agent。</p>
      </div>}
      {!terminal && assignment && !['completed', 'cancelled', 'failed'].includes(state.status) && !bindings.some(binding => binding.state !== 'closed') && <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); run(() => taskBridge().bindSession(assignment.assignmentId, { logicalSessionId: sessionId.trim() })) }}>
        <input required aria-label={`${step.title}会话编号`} value={sessionId} onChange={event => setSessionId(event.target.value)} placeholder="执行方的真实会话编号" className={inputClass} />
        <button disabled={busy || !sessionId.trim()} className={buttonClass}>绑定会话</button>
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
  const { tasks, selectedId, creating, setCreating, loading, error } = useTasks()
  const [activeTab, setActiveTab] = useState('overview')
  const snapshot = tasks.find(task => task.definition.task.taskId === selectedId)
  if (creating) return <div className="h-full overflow-y-auto"><CreateTask project={project} /></div>
  if (!snapshot) return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-(--ui-text-secondary)"><p>{loading ? '正在加载任务…' : error ? '任务服务暂不可用，请刷新重试。' : '选择一个任务查看详情，或创建新任务。'}</p><button type="button" onClick={() => setCreating(true)} className={buttonClass}>新建任务</button></div>
  const task = snapshot.definition.task
  const artifacts = taskArtifacts(snapshot)
  const changes = artifacts.filter(event => /diff|patch|code.?change/i.test(String(event.payload?.kind ?? '')) || typeof event.payload?.diff === 'string' || Array.isArray(event.payload?.changedFiles))
  return <div className="flex h-full min-w-0 flex-col bg-background">
    <header className="shrink-0 space-y-2 border-b border-(--ui-border) px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-medium">{task.title}</h2><span className="text-sm text-blue-500">{statusLabel(snapshot.runtime.task.status)} · {percent(snapshot.runtime.task.progress)}</span></div>
      <div className="break-all text-xs text-(--ui-text-tertiary)">{task.taskId}</div>
    </header>
    <nav aria-label="任务详情页签" className="flex shrink-0 gap-5 overflow-x-auto border-b border-(--ui-border) px-6">{tabs.map(([id, label]) => <button type="button" key={id} aria-current={activeTab === id ? 'page' : undefined} onClick={() => setActiveTab(id)} className={`whitespace-nowrap border-b-2 py-3 text-sm ${activeTab === id ? 'border-blue-500 text-blue-500' : 'border-transparent text-(--ui-text-secondary)'}`}>{label}</button>)}</nav>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6" key={`${task.taskId}:${activeTab}`}>
      {activeTab === 'overview' && <>
        <h3 className="font-medium">目标与验收要求</h3><p className="whitespace-pre-wrap text-sm">{task.goal}</p>
        <div className="grid gap-3 text-sm sm:grid-cols-2"><p>项目：{task.projectId ?? '无项目'}</p><p>工作流：{task.workflowId ?? '自定义任务'}</p><p>步骤：{snapshot.runtime.steps.filter(step => step.status === 'completed').length}/{snapshot.runtime.steps.length} 已完成</p><p>最大并行步骤：{task.maxParallelSteps}</p><p>创建：{new Date(task.createdAt).toLocaleString()}</p><p>更新：{new Date(snapshot.runtime.task.updatedAt).toLocaleString()}</p></div>
        {[...snapshot.runtime.task.blockers, ...snapshot.runtime.steps.flatMap(step => step.blocker ? [step.blocker] : [])].map((blocker, index) => <p key={index} className="text-sm text-amber-500">{blocker}</p>)}
        <h3 className="font-medium">步骤状态</h3>{snapshot.definition.steps.map(step => { const state = snapshot.runtime.steps.find(item => item.stepId === step.stepId)!; return <div key={step.stepId} className="space-y-1 border-b border-(--ui-border) py-2 text-sm"><div className="flex justify-between gap-3"><span>{step.title}</span><span>{statusLabel(state.status)}</span></div>{!!step.requiredSkills?.length && <div className="text-xs text-blue-500">Required Skills：{step.requiredSkills.join('、')}</div>}{state.skillPreflight?.executor && <div className="text-xs text-(--ui-text-tertiary)">推荐 Agent：{state.skillPreflight.executor} · {state.skillPreflight.adapterMode}</div>}</div>})}
      </>}
      {(activeTab === 'execution' || activeTab === 'review') && <>
        {snapshot.definition.steps.length === 0 && <p className="text-sm text-(--ui-text-secondary)">尚未添加步骤。</p>}
        {snapshot.definition.steps.map(step => <StepControl key={step.stepId} snapshot={snapshot} stepId={step.stepId} review={activeTab === 'review'} />)}
        {activeTab === 'execution' && !['completed', 'cancelled'].includes(snapshot.runtime.task.status) && <AddStep snapshot={snapshot} />}
      </>}
      {activeTab === 'changes' && <EventList events={changes} empty="尚未收到代码差异回报。执行方可将 diff、patch 或 changedFiles 随产物回报记录。" />}
      {activeTab === 'artifacts' && <><p className="text-xs text-(--ui-text-secondary)">以下为执行方回报的产物记录。文件是否已归档以产物中的存储证据为准。</p><EventList events={artifacts} empty="尚未收到产物回报。" /></>}
      {activeTab === 'verification' && <><p className="text-xs text-(--ui-text-secondary)">验证依据来自完成请求和审核记录；人工审核与自动测试结果分别以记录内容为准。</p><EventList events={snapshot.events.filter(event => ['completion.requested', 'gate.passed', 'gate.failed'].includes(event.type))} empty="尚无验证证据。" /></>}
      {activeTab === 'timeline' && <EventList events={snapshot.events} empty="尚无事件。" />}
    </div>
  </div>
}

import { useEffect, useMemo, useState } from 'react'

import { ZERO3_ACTIVE_PROJECT_CHANGED } from './ProjectDock'

type Target = 'CODEX' | 'GEMINI'
type TaskType = 'DESIGN' | 'IMPLEMENT' | 'VERIFY' | 'FIX' | 'REVIEW' | 'INTEGRATE' | 'RESEARCH'

type Project = {
  id: string
  name: string
  repositoryPath: string
  defaultWorktreePath: string | null
  defaultBranch: string | null
  baseRef: string | null
  contextSummary: string | null
}

type WorkspaceEntry = {
  id: string
  kind: 'gpt_web' | 'gemini_web'
  projectId: string | null
  pageTitle: string | null
  localDisplayTitle: string | null
}

type AgentDispatchResult = {
  taskId: string
  executionId: string
  target: 'CODEX' | 'GEMINI'
  logicalSessionId?: string | null
  webEntryId?: string | null
}

type AgentTaskBridge = {
  dispatch(request: { taskSpec: Record<string, unknown>; originEntryId: string }): Promise<AgentDispatchResult>
}

type AgentTaskAuthorityBridge = {
  get(request: { taskId: string }): Promise<unknown>
}

type ProjectBridge = { getActive(): Promise<Project | null> }
type ControlBridge = {
  status(): Promise<{ configured: boolean; baseUrl: string | null }>
  tasks: { dispatchCodex(request: { task: Record<string, unknown>; extension?: { project_context?: unknown; handoff?: unknown } }): Promise<unknown> }
}

type HandoffWindow = Window & {
  zero3Workspace?: {
    list(): Promise<WorkspaceEntry[]>
    setProject(request: { id: string; projectId: string | null }): Promise<WorkspaceEntry>
  }
  zero3Projects?: ProjectBridge
  zero3AgentTasks?: AgentTaskBridge
  zero3AgentTask?: AgentTaskAuthorityBridge
  zero3Control?: ControlBridge
}

const TASK_TYPES: TaskType[] = ['DESIGN', 'IMPLEMENT', 'VERIFY', 'FIX', 'REVIEW', 'INTEGRATE', 'RESEARCH']

function api(): HandoffWindow { return window as HandoffWindow }
function uid() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}` }
function entryTitle(entry: WorkspaceEntry) { return entry.localDisplayTitle || entry.pageTitle || 'GPT Web 会话' }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

export function HandoffDock() {
  const bridges = useMemo(api, [])
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [sourceId, setSourceId] = useState('')
  const [project, setProject] = useState<Project | null>(null)
  const [target, setTarget] = useState<Target>('CODEX')
  const [taskType, setTaskType] = useState<TaskType>('IMPLEMENT')
  const [taskId, setTaskId] = useState(() => `gpt-${uid().slice(0, 12)}`)
  const [goal, setGoal] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [taskSnapshot, setTaskSnapshot] = useState<Record<string, unknown> | null>(null)

  const source = useMemo(() => entries.find(entry => entry.id === sourceId) ?? null, [entries, sourceId])

  const applyProjectDefaults = (next: Project | null) => {
    setProject(next)
    setWorkspace(next?.defaultWorktreePath ?? '')
    setBaseRef(next?.baseRef ?? next?.defaultBranch ?? '')
  }

  const loadContext = async () => {
    const [all, active] = await Promise.all([
      bridges.zero3Workspace?.list() ?? Promise.resolve([]),
      bridges.zero3Projects?.getActive() ?? Promise.resolve(null)
    ])
    const gpt = all.filter(entry => entry.kind === 'gpt_web')
    setEntries(gpt)
    setSourceId(current => current && gpt.some(entry => entry.id === current) ? current : gpt[0]?.id ?? '')
    applyProjectDefaults(active)
  }

  useEffect(() => {
    if (!open) return
    void loadContext().catch(reason => setError(`任务上下文读取失败：${errorMessage(reason)}`))
  }, [open])

  useEffect(() => {
    const changed = (event: Event) => {
      const next = (event as CustomEvent<{ project?: Project | null }>).detail?.project ?? null
      applyProjectDefaults(next)
    }
    window.addEventListener(ZERO3_ACTIVE_PROJECT_CHANGED, changed)
    return () => window.removeEventListener(ZERO3_ACTIVE_PROJECT_CHANGED, changed)
  }, [])

  useEffect(() => {
    if (!source || goal.trim()) return
    setGoal(entryTitle(source))
  }, [source, goal])

  const setTargetAndDefaults = (next: Target) => {
    setTarget(next)
    setTaskType(next === 'GEMINI' ? 'DESIGN' : 'IMPLEMENT')
    setError(null)
    setResult(null)
  }

  const ensureProjectBinding = async (): Promise<WorkspaceEntry> => {
    if (!source) throw new Error('请选择一个真实 GPT Web 来源会话。')
    if (!project) throw new Error('尚未设置当前 Zero3 Project。请先打开“Project / Workspace”创建并启用项目。')
    if (source.projectId === project.id) return source
    if (!bridges.zero3Workspace) throw new Error('Workspace bridge 不可用。')
    const updated = await bridges.zero3Workspace.setProject({ id: source.id, projectId: project.id })
    setEntries(current => current.map(entry => entry.id === updated.id ? updated : entry))
    return updated
  }

  const inspect = async (id = taskId.trim()) => {
    if (!id || !bridges.zero3AgentTask) return
    try { setTaskSnapshot(record(await bridges.zero3AgentTask.get({ taskId: id }))) }
    catch (reason) { setError(`任务状态读取失败：${errorMessage(reason)}`) }
  }

  const dispatch = async () => {
    if (busy) return
    setBusy(true); setError(null); setResult(null); setTaskSnapshot(null)
    try {
      if (!project) throw new Error('尚未设置当前 Zero3 Project。')
      const dispatchSource = await ensureProjectBinding()
      const id = taskId.trim()
      const objective = goal.trim()
      const cwd = workspace.trim()
      const requestedBase = baseRef.trim()
      if (!id || !objective) throw new Error('Task ID 和目标不能为空。')
      if (!cwd) throw new Error('当前 Project 没有默认独立 Worktree；请在 Project Manager 配置，或在高级覆盖中填写。')

      const executionId = uid()
      const taskSpec = {
        protocol: 'zero3.pilot.task-spec.v2',
        taskId: id,
        executionId,
        projectId: project.id,
        target,
        type: taskType,
        title: objective.slice(0, 160),
        goal: objective,
        contextVersion: 1,
        repo: project.repositoryPath,
        branch: project.defaultBranch,
        baseSha: requestedBase || null,
        worktreePath: cwd,
        requirements: [],
        constraints: [
          'Do not use ChatGPT/Gemini web DOM as the task transport.',
          'Preserve provider/runtime authority boundaries and publish structured evidence.',
          'Commit intended changes and leave the isolated task worktree clean before reporting completion.'
        ],
        requiredContracts: [], inputArtifacts: [], expectedOutputs: [], verification: [],
        completionGate: ['result.summary', 'git.clean', 'verification.no-failures', 'artifact.hashes'],
        reviewPolicy: { required: true, reviewer: 'GPT_WEB', maxCycles: 5 },
        createdBySessionId: dispatchSource.id,
        createdAt: new Date().toISOString()
      }

      if (bridges.zero3AgentTasks) {
        const dispatched = await bridges.zero3AgentTasks.dispatch({ taskSpec, originEntryId: dispatchSource.id })
        setResult(`已派发 ${dispatched.taskId} → ${dispatched.target}，Execution ${dispatched.executionId}`)
        setTaskId(dispatched.taskId)
        await inspect(dispatched.taskId)
        window.dispatchEvent(new CustomEvent('zero3:task-changed', { detail: { taskId: dispatched.taskId, projectId: project.id } }))
        return
      }

      if (target === 'GEMINI') throw new Error('当前构建尚未装载 Zero3 Agent Router / Antigravity dispatch bridge。')
      if (!bridges.zero3Control) throw new Error('当前构建尚未装载 Zero3 Control Plane Bridge。')
      const status = await bridges.zero3Control.status()
      if (!status.configured) throw new Error('Zero3 Control Plane 尚未配置。')
      await bridges.zero3Control.tasks.dispatchCodex({
        task: {
          protocol: 'zero3.pilot.remote-task.v1', task_id: id, execution_id: executionId, objective,
          target: { workspace: cwd, ...(requestedBase ? { base_ref: requestedBase } : {}) }, permission_profile: 'standard',
          constraints: ['Open-source Codex remains the authoritative execution kernel.', 'Inspect the real repository before modifying it.'],
          acceptance_criteria: ['Complete the requested objective and publish authoritative execution evidence.'],
          execution: { max_turns: 1, timeout_seconds: 3600, require_clean_worktree: true }
        },
        extension: {
          project_context: { project_id: project.id, source_entry_id: dispatchSource.id, source_kind: 'gpt_web' },
          handoff: { result_protocol: 'zero3.pilot.execution-result.v1', return_entry_id: dispatchSource.id, required_evidence: ['codex.turn.completed', 'git.preflight', 'git.postflight', 'execution.result'] }
        }
      })
      setResult(`已通过兼容 Control Plane 派发 ${id} → CODEX，Execution ${executionId}`)
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }

  return (
    <>
      <button aria-label="真实任务派发" className="handoff-rail-button" onClick={() => { setOpen(true); setError(null); setResult(null) }} title="GPT → Codex / Gemini 任务派发" type="button"><span>↗</span></button>
      {open ? (
        <div className="handoff-backdrop" role="presentation">
          <section aria-modal="true" className="handoff-modal" role="dialog">
            <header className="handoff-head"><div><h2>真实任务派发</h2><p>当前 Project 自动提供 projectId、仓库、Worktree 与 Base Ref；TaskSpecV2 直接进入 Agent Router。</p></div><button aria-label="关闭" onClick={() => setOpen(false)} type="button">×</button></header>
            <div className="handoff-project-context">
              <strong>{project ? project.name : '未选择 Project'}</strong>
              <span>{project ? `${project.id} · ${project.repositoryPath}` : '请先在 Project / Workspace 中创建并启用项目'}</span>
            </div>
            <div className="handoff-targets"><button className={target === 'CODEX' ? 'active' : ''} onClick={() => setTargetAndDefaults('CODEX')} type="button">交给 Codex</button><button className={target === 'GEMINI' ? 'active' : ''} onClick={() => setTargetAndDefaults('GEMINI')} type="button">交给 Gemini</button></div>
            <div className="handoff-grid">
              <label><span>来源 GPT Web 会话</span><select onChange={event => { setSourceId(event.target.value); setGoal('') }} value={sourceId}><option value="">请选择真实会话</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{entryTitle(entry)}{entry.projectId ? ` · ${entry.projectId}` : ''}</option>)}</select></label>
              <div className="handoff-row"><label><span>Task ID</span><input onChange={event => setTaskId(event.target.value)} value={taskId} /></label><label><span>Task Type</span><select onChange={event => setTaskType(event.target.value as TaskType)} value={taskType}>{TASK_TYPES.map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>
              <label><span>目标</span><textarea onChange={event => setGoal(event.target.value)} value={goal} /></label>
              <details className="handoff-advanced"><summary>高级覆盖（默认从 Project 自动读取）</summary><label><span>独立 Worktree / Workspace</span><input onChange={event => setWorkspace(event.target.value)} value={workspace} /></label><label><span>Base Ref / SHA</span><input onChange={event => setBaseRef(event.target.value)} value={baseRef} /></label></details>
            </div>
            {error ? <div className="handoff-error">{error}</div> : null}{result ? <div className="handoff-result">{result}</div> : null}
            {taskSnapshot ? <details className="handoff-task-snapshot"><summary>查看权威任务状态</summary><pre>{JSON.stringify(taskSnapshot, null, 2)}</pre></details> : null}
            <footer className="handoff-actions"><button className="handoff-secondary" disabled={!bridges.zero3AgentTask || !taskId.trim()} onClick={() => void inspect()} type="button">刷新任务状态</button><button className="handoff-primary" disabled={busy || !project} onClick={() => void dispatch()} type="button">{busy ? '派发中…' : `确认派发给 ${target === 'GEMINI' ? 'Gemini' : 'Codex'}`}</button></footer>
          </section>
        </div>
      ) : null}
    </>
  )
}

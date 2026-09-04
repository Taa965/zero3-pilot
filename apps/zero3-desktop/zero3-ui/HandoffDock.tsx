import { useEffect, useMemo, useState } from 'react'

type Target = 'CODEX' | 'GEMINI'
type TaskType = 'DESIGN' | 'IMPLEMENT' | 'VERIFY' | 'FIX' | 'REVIEW' | 'INTEGRATE' | 'RESEARCH'

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

type ControlBridge = {
  status(): Promise<{ configured: boolean; baseUrl: string | null }>
  tasks: {
    dispatchCodex(request: {
      task: Record<string, unknown>
      extension?: { project_context?: unknown; handoff?: unknown }
    }): Promise<unknown>
  }
}

type HandoffWindow = Window & {
  zero3Workspace?: {
    list(): Promise<WorkspaceEntry[]>
    setProject(request: { id: string; projectId: string | null }): Promise<WorkspaceEntry>
  }
  zero3AgentTasks?: AgentTaskBridge
  zero3AgentTask?: AgentTaskAuthorityBridge
  zero3Control?: ControlBridge
}

const TASK_TYPES: TaskType[] = ['DESIGN', 'IMPLEMENT', 'VERIFY', 'FIX', 'REVIEW', 'INTEGRATE', 'RESEARCH']

function api(): HandoffWindow {
  return window as HandoffWindow
}

function uid() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function entryTitle(entry: WorkspaceEntry) {
  return entry.localDisplayTitle || entry.pageTitle || 'GPT Web 会话'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function HandoffDock() {
  const bridges = useMemo(api, [])
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [sourceId, setSourceId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [target, setTarget] = useState<Target>('CODEX')
  const [taskType, setTaskType] = useState<TaskType>('IMPLEMENT')
  const [taskId, setTaskId] = useState(() => `gpt-${uid().slice(0, 12)}`)
  const [goal, setGoal] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [baseSha, setBaseSha] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [taskSnapshot, setTaskSnapshot] = useState<Record<string, unknown> | null>(null)

  const source = useMemo(() => entries.find(entry => entry.id === sourceId) ?? null, [entries, sourceId])

  const loadEntries = async () => {
    if (!bridges.zero3Workspace) {
      setEntries([])
      return
    }
    try {
      const all = await bridges.zero3Workspace.list()
      const gpt = all.filter(entry => entry.kind === 'gpt_web')
      setEntries(gpt)
      setSourceId(current => current && gpt.some(entry => entry.id === current) ? current : gpt[0]?.id ?? '')
    } catch (reason) {
      setError(`无法读取 GPT Web 会话：${errorMessage(reason)}`)
    }
  }

  useEffect(() => {
    if (!open) return
    void loadEntries()
  }, [open])

  useEffect(() => {
    setProjectId(source?.projectId ?? '')
    if (!source || goal.trim()) return
    setGoal(entryTitle(source))
  }, [source, goal])

  const setTargetAndDefaults = (next: Target) => {
    setTarget(next)
    setTaskType(next === 'GEMINI' ? 'DESIGN' : 'IMPLEMENT')
    setError(null)
    setResult(null)
  }

  const bindProject = async (): Promise<WorkspaceEntry | null> => {
    if (!source || !bridges.zero3Workspace) return null
    const nextProjectId = projectId.trim()
    if (!nextProjectId) throw new Error('Project ID 不能为空。')
    const updated = await bridges.zero3Workspace.setProject({ id: source.id, projectId: nextProjectId })
    setEntries(current => current.map(entry => entry.id === updated.id ? updated : entry))
    setProjectId(updated.projectId ?? '')
    setResult(`已将 ${entryTitle(updated)} 绑定到 Project ${updated.projectId}`)
    return updated
  }

  const inspect = async (id = taskId.trim()) => {
    if (!id || !bridges.zero3AgentTask) return
    try {
      const snapshot = record(await bridges.zero3AgentTask.get({ taskId: id }))
      setTaskSnapshot(snapshot)
    } catch (reason) {
      setError(`任务状态读取失败：${errorMessage(reason)}`)
    }
  }

  const dispatch = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    setTaskSnapshot(null)
    try {
      const id = taskId.trim()
      const objective = goal.trim()
      const cwd = workspace.trim()
      if (!source) throw new Error('请选择一个真实 GPT Web 来源会话。')
      let dispatchSource = source
      if (!dispatchSource.projectId || dispatchSource.projectId !== projectId.trim()) {
        const rebound = await bindProject()
        if (rebound) dispatchSource = rebound
      }
      if (!dispatchSource.projectId) throw new Error('该 GPT Web 会话还没有绑定 Zero3 Project。')
      if (!id || !objective || !cwd) throw new Error('Task ID、目标和独立 Worktree / Workspace 都是必填项。')

      const executionId = uid()
      const taskSpec = {
        protocol: 'zero3.pilot.task-spec.v2',
        taskId: id,
        executionId,
        projectId: dispatchSource.projectId,
        target,
        type: taskType,
        title: objective.slice(0, 160),
        goal: objective,
        contextVersion: 1,
        baseSha: baseSha.trim() || null,
        worktreePath: cwd,
        requirements: [],
        constraints: [
          'Do not use ChatGPT/Gemini web DOM as the task transport.',
          'Preserve provider/runtime authority boundaries and publish structured evidence.',
          'Commit intended changes and leave the isolated task worktree clean before reporting completion.'
        ],
        requiredContracts: [],
        inputArtifacts: [],
        expectedOutputs: [],
        verification: [],
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
        return
      }

      if (target === 'GEMINI') {
        throw new Error('当前构建尚未装载 Zero3 Agent Router / Antigravity dispatch bridge。')
      }
      if (!bridges.zero3Control) throw new Error('当前构建尚未装载 Zero3 Control Plane Bridge。')
      const status = await bridges.zero3Control.status()
      if (!status.configured) throw new Error('Zero3 Control Plane 尚未配置。')
      await bridges.zero3Control.tasks.dispatchCodex({
        task: {
          protocol: 'zero3.pilot.remote-task.v1',
          task_id: id,
          execution_id: executionId,
          objective,
          target: { workspace: cwd, ...(baseSha.trim() ? { base_ref: baseSha.trim() } : {}) },
          permission_profile: 'standard',
          constraints: [
            'Open-source Codex remains the authoritative execution kernel.',
            'Inspect the real repository before modifying it.'
          ],
          acceptance_criteria: ['Complete the requested objective and publish authoritative execution evidence.'],
          execution: { max_turns: 1, timeout_seconds: 3600, require_clean_worktree: true }
        },
        extension: {
          project_context: { project_id: dispatchSource.projectId, source_entry_id: dispatchSource.id, source_kind: 'gpt_web' },
          handoff: {
            result_protocol: 'zero3.pilot.execution-result.v1',
            return_entry_id: dispatchSource.id,
            required_evidence: ['codex.turn.completed', 'git.preflight', 'git.postflight', 'execution.result']
          }
        }
      })
      setResult(`已通过兼容 Control Plane 派发 ${id} → CODEX，Execution ${executionId}`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        aria-label="真实任务派发"
        className="handoff-rail-button"
        onClick={() => { setOpen(true); setError(null); setResult(null) }}
        title="GPT → Codex / Gemini 任务派发"
        type="button"
      >
        <span>↗</span>
      </button>

      {open ? (
        <div className="handoff-backdrop" role="presentation">
          <section aria-modal="true" className="handoff-modal" role="dialog">
            <header className="handoff-head">
              <div>
                <h2>真实任务派发</h2>
                <p>通过 Zero3 TaskSpecV2 / Agent Router 派发，不读取 ChatGPT/Gemini DOM。</p>
              </div>
              <button aria-label="关闭" onClick={() => setOpen(false)} type="button">×</button>
            </header>

            <div className="handoff-targets">
              <button className={target === 'CODEX' ? 'active' : ''} onClick={() => setTargetAndDefaults('CODEX')} type="button">交给 Codex</button>
              <button className={target === 'GEMINI' ? 'active' : ''} onClick={() => setTargetAndDefaults('GEMINI')} type="button">交给 Gemini</button>
            </div>

            <div className="handoff-grid">
              <label>
                <span>来源 GPT Web 会话</span>
                <select onChange={event => { setSourceId(event.target.value); setGoal('') }} value={sourceId}>
                  <option value="">请选择真实会话</option>
                  {entries.map(entry => <option key={entry.id} value={entry.id}>{entryTitle(entry)}{entry.projectId ? ` · ${entry.projectId}` : ' · 未绑定项目'}</option>)}
                </select>
              </label>

              <div className="handoff-project-row">
                <label><span>Zero3 Project ID</span><input onChange={event => setProjectId(event.target.value)} placeholder="例如 zero3-pilot" value={projectId} /></label>
                <button disabled={!source || !projectId.trim()} onClick={() => void bindProject().catch(reason => setError(errorMessage(reason)))} type="button">绑定项目</button>
              </div>

              <div className="handoff-row">
                <label><span>Task ID</span><input onChange={event => setTaskId(event.target.value)} value={taskId} /></label>
                <label><span>Task Type</span><select onChange={event => setTaskType(event.target.value as TaskType)} value={taskType}>{TASK_TYPES.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
              </div>

              <label><span>目标</span><textarea onChange={event => setGoal(event.target.value)} value={goal} /></label>
              <label><span>独立 Worktree / Workspace</span><input onChange={event => setWorkspace(event.target.value)} placeholder="C:\\workspace\\task-worktree" value={workspace} /></label>
              <label><span>Base SHA（可选）</span><input onChange={event => setBaseSha(event.target.value)} value={baseSha} /></label>
            </div>

            {error ? <div className="handoff-error">{error}</div> : null}
            {result ? <div className="handoff-result">{result}</div> : null}
            {taskSnapshot ? (
              <details className="handoff-task-snapshot">
                <summary>查看权威任务状态</summary>
                <pre>{JSON.stringify(taskSnapshot, null, 2)}</pre>
              </details>
            ) : null}

            <footer className="handoff-actions">
              <button className="handoff-secondary" disabled={!bridges.zero3AgentTask || !taskId.trim()} onClick={() => void inspect()} type="button">刷新任务状态</button>
              <button className="handoff-primary" disabled={busy} onClick={() => void dispatch()} type="button">{busy ? '派发中…' : `确认派发给 ${target === 'GEMINI' ? 'Gemini' : 'Codex'}`}</button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  )
}

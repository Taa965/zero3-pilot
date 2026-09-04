import { useEffect, useMemo, useState } from 'react'

type TaskTarget = 'CODEX' | 'GEMINI'
type TaskType = 'DESIGN' | 'IMPLEMENT' | 'VERIFY' | 'FIX' | 'REVIEW' | 'INTEGRATE' | 'RESEARCH'
type JsonRecord = Record<string, unknown>

type GeminiEntry = {
  id: string
  logicalSessionId: string
}

type AgentTaskBridge = {
  dispatch(request: {
    task: Record<string, unknown>
    context: {
      targetLogicalSessionId: string
      reviewSessionId?: string | null
      runtimeConversationId?: string | null
    }
  }): Promise<unknown>
  get(request: { taskId: string }): Promise<unknown>
}

type GeminiBridge = {
  create(request?: { projectId?: string | null }): Promise<GeminiEntry>
}

type Runtime = Window & {
  zero3AgentTask?: AgentTaskBridge
  zero3GeminiWeb?: GeminiBridge
}

const runtime = window as Runtime
const UI_STATE_STORAGE_KEY = 'zero3.three-column-ui.v1'

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function uid(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function activeEntryId(): string | null {
  try {
    const stored = window.localStorage.getItem(UI_STATE_STORAGE_KEY)
    if (!stored) return null
    const value = JSON.parse(stored) as JsonRecord
    return text(value.activeId) || null
  } catch {
    return null
  }
}

function taskStateLabel(value: unknown): string {
  const task = record(value)
  return text(task.state) || text(task.status) || text(record(task.runtime).state) || '状态未知'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return '任务派发失败'
}

export function AgentTaskDock() {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<TaskTarget>('CODEX')
  const [taskType, setTaskType] = useState<TaskType>('IMPLEMENT')
  const [taskId, setTaskId] = useState(() => `zero3-${uid().slice(0, 12)}`)
  const [projectId, setProjectId] = useState('')
  const [goal, setGoal] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [baseSha, setBaseSha] = useState('')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [lastTaskId, setLastTaskId] = useState<string | null>(null)
  const [lastTaskState, setLastTaskState] = useState<string | null>(null)
  const [createdGeminiEntryId, setCreatedGeminiEntryId] = useState<string | null>(null)

  const available = useMemo(() => Boolean(runtime.zero3AgentTask), [])

  useEffect(() => {
    if (!open || !lastTaskId || !runtime.zero3AgentTask) return
    let cancelled = false
    const refresh = async () => {
      try {
        const task = await runtime.zero3AgentTask?.get({ taskId: lastTaskId })
        if (!cancelled) setLastTaskState(taskStateLabel(task))
      } catch {}
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [lastTaskId, open])

  const switchTarget = (next: TaskTarget) => {
    setTarget(next)
    setTaskType(next === 'GEMINI' ? 'DESIGN' : 'IMPLEMENT')
    setError(null)
    setResult(null)
    setCreatedGeminiEntryId(null)
  }

  const dispatch = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    setCreatedGeminiEntryId(null)

    try {
      const bridge = runtime.zero3AgentTask
      if (!bridge) throw new Error('当前构建未加载 Zero3 Agent Task Bridge。')

      const cleanTaskId = taskId.trim()
      const cleanProjectId = projectId.trim()
      const cleanGoal = goal.trim()
      const cleanWorkspace = workspace.trim()
      if (!cleanTaskId || !cleanProjectId || !cleanGoal || !cleanWorkspace) {
        throw new Error('Task ID、项目 ID、目标和独立 Workspace 都是必填项。')
      }

      const executionId = uid()
      const reviewSessionId = activeEntryId()
      let targetLogicalSessionId = `codex-task:${cleanTaskId}:${executionId}`
      let geminiEntryId: string | null = null

      if (target === 'GEMINI') {
        if (!runtime.zero3GeminiWeb) throw new Error('当前构建未加载 Gemini Web Bridge。')
        const entry = await runtime.zero3GeminiWeb.create({ projectId: cleanProjectId })
        if (!entry?.logicalSessionId || !entry.id) throw new Error('Gemini 会话创建后未返回有效绑定。')
        targetLogicalSessionId = entry.logicalSessionId
        geminiEntryId = entry.id
      }

      const task = {
        protocol: 'zero3.pilot.task-spec.v2',
        taskId: cleanTaskId,
        executionId,
        projectId: cleanProjectId,
        target,
        type: taskType,
        title: cleanGoal.slice(0, 160),
        goal: cleanGoal,
        contextVersion: 1,
        repo: null,
        baseSha: baseSha.trim() || null,
        branch: branch.trim() || null,
        worktreePath: cleanWorkspace,
        requirements: [],
        constraints: [
          'Open-source Codex remains the authoritative execution kernel.',
          'Do not use ChatGPT/Gemini web DOM as the task transport.',
          'Inspect the real repository/worktree before modifying it.',
          'Publish structured verification and artifact evidence.'
        ],
        requiredContracts: [],
        inputArtifacts: [],
        expectedOutputs: [],
        verification: [],
        completionGate: ['result.summary', 'git.clean', 'verification.no-failures', 'artifact.hashes'],
        reviewPolicy: {
          required: true,
          reviewer: reviewSessionId ? 'GPT_WEB' : 'HUMAN',
          maxCycles: 5
        },
        createdBySessionId: reviewSessionId || `zero3-three-column:${uid()}`,
        createdAt: new Date().toISOString()
      }

      const dispatched = await bridge.dispatch({
        task,
        context: {
          targetLogicalSessionId,
          reviewSessionId
        }
      })
      const state = taskStateLabel(dispatched)
      setLastTaskId(cleanTaskId)
      setLastTaskState(state)
      setCreatedGeminiEntryId(geminiEntryId)
      setResult(`已派发 ${cleanTaskId} → ${target === 'GEMINI' ? 'Gemini' : 'Codex'}，Execution ${executionId}`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const openCreatedGemini = () => {
    if (!createdGeminiEntryId) return
    try {
      const currentRaw = window.localStorage.getItem(UI_STATE_STORAGE_KEY)
      const current = currentRaw ? record(JSON.parse(currentRaw)) : {}
      window.localStorage.setItem(
        UI_STATE_STORAGE_KEY,
        JSON.stringify({ ...current, activeId: createdGeminiEntryId, filter: 'gemini' })
      )
    } catch {}
    window.location.reload()
  }

  return <>
    <button
      className={`z3-agent-dock-toggle ${available ? '' : 'unavailable'}`}
      onClick={() => setOpen(value => !value)}
      title={available ? '任务派发与多 Agent 协作' : 'Agent Task Bridge 未加载'}
      type="button"
    >
      <span>⚡</span>
      <small>任务</small>
    </button>

    {open ? <aside className="z3-agent-dock" aria-label="Zero3 任务派发">
      <header>
        <div>
          <strong>任务派发</strong>
          <span>同一套 Zero3 Runtime，不读取网页 DOM</span>
        </div>
        <button onClick={() => setOpen(false)} type="button">×</button>
      </header>

      {!available ? <div className="z3-agent-alert error">当前构建未暴露 zero3AgentTask，无法派发真实任务。</div> : null}

      <div className="z3-agent-targets">
        <button className={target === 'CODEX' ? 'active' : ''} onClick={() => switchTarget('CODEX')} type="button">交给 Codex</button>
        <button className={target === 'GEMINI' ? 'active gemini' : ''} onClick={() => switchTarget('GEMINI')} type="button">交给 Gemini</button>
      </div>

      <div className="z3-agent-form">
        <label><span>Task ID</span><input value={taskId} onChange={event => setTaskId(event.target.value)} /></label>
        <label><span>任务类型</span><select value={taskType} onChange={event => setTaskType(event.target.value as TaskType)}>{['DESIGN','IMPLEMENT','VERIFY','FIX','REVIEW','INTEGRATE','RESEARCH'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>项目 ID</span><input value={projectId} onChange={event => setProjectId(event.target.value)} placeholder="Zero3 Project ID" /></label>
        <label><span>目标</span><textarea value={goal} onChange={event => setGoal(event.target.value)} placeholder="描述要完成的真实任务" /></label>
        <label><span>独立 Workspace / Worktree</span><input value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="C:\\workspace\\task-worktree" /></label>
        <label><span>Base SHA（可选）</span><input value={baseSha} onChange={event => setBaseSha(event.target.value)} /></label>
        <label><span>分支（可选）</span><input value={branch} onChange={event => setBranch(event.target.value)} /></label>
      </div>

      {error ? <div className="z3-agent-alert error">{error}</div> : null}
      {result ? <div className="z3-agent-alert success">{result}</div> : null}
      {lastTaskId ? <div className="z3-agent-status"><span>最近任务</span><b>{lastTaskId}</b><em>{lastTaskState || '读取中…'}</em></div> : null}

      <footer>
        {createdGeminiEntryId ? <button className="secondary" onClick={openCreatedGemini} type="button">打开新 Gemini 会话</button> : null}
        <button className="primary" disabled={busy || !available} onClick={() => void dispatch()} type="button">{busy ? '派发中…' : `确认派发给 ${target === 'GEMINI' ? 'Gemini' : 'Codex'}`}</button>
      </footer>
    </aside> : null}
  </>
}

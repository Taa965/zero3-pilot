import { useEffect, useMemo, useState } from 'react'

import { ZERO3_ACTIVE_PROJECT_CHANGED } from './ProjectDock'

type Project = { id: string; name: string }
type ReviewAutomation = {
  status: 'IDLE' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  reviewerSessionId: string | null
  cycle: number | null
  attempts: number
  lastError: string | null
  updatedAt: string
}
type TaskRecord = {
  task: {
    taskId: string
    executionId: string
    projectId: string
    title: string
    goal: string
    contextVersion: number
    reviewPolicy?: { reviewer?: string }
  }
  resolvedTarget: 'CODEX' | 'GEMINI'
  state: string
  binding: Record<string, unknown> | null
  result: Record<string, unknown> | null
  reviewAutomation: ReviewAutomation | null
  createdAt: string
  updatedAt: string
}

type ReviewRecord = {
  taskId: string
  state: string
  binding: Record<string, unknown>
  cycles: Array<{
    cycle: number
    packet: {
      reviewId: string
      taskId: string
      cycle: number
      originalGoal: string
      provider: 'CODEX' | 'GEMINI'
      resultSummary: string
      changedFiles: string[]
      verification: Array<Record<string, unknown>>
      knownIssues: string[]
      blockers: string[]
    }
    decision: Record<string, unknown> | null
    fixRequest: Record<string, unknown> | null
  }>
}

type TaskBridge = {
  list(request?: { projectId?: string | null; states?: string[] | null; limit?: number | null }): Promise<unknown>
  reviewGet(request: { taskId: string }): Promise<unknown>
  reviewGptWeb(request: { taskId: string }): Promise<unknown>
  reviewDecision(request: { taskId: string; contextVersion: number; decision: Record<string, unknown> }): Promise<unknown>
}

type ProjectBridge = { getActive(): Promise<Project | null> }
type TaskWindow = Window & { zero3AgentTask?: TaskBridge; zero3Projects?: ProjectBridge }

function api() {
  const target = window as TaskWindow
  return { tasks: target.zero3AgentTask ?? null, projects: target.zero3Projects ?? null }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function reviewAutomation(value: unknown): ReviewAutomation | null {
  const raw = record(value)
  const status = text(raw.status)
  if (!['IDLE', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'].includes(status)) return null
  const attempts = typeof raw.attempts === 'number' && Number.isSafeInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0
  const cycle = typeof raw.cycle === 'number' && Number.isSafeInteger(raw.cycle) && raw.cycle >= 1 ? raw.cycle : null
  return {
    status: status as ReviewAutomation['status'],
    reviewerSessionId: typeof raw.reviewerSessionId === 'string' ? raw.reviewerSessionId : null,
    cycle,
    attempts,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    updatedAt: text(raw.updatedAt)
  }
}

function taskRecord(value: unknown): TaskRecord | null {
  const raw = record(value)
  const task = record(raw.task)
  const taskId = text(task.taskId).trim()
  const projectId = text(task.projectId).trim()
  if (!taskId || !projectId) return null
  const contextVersion = typeof task.contextVersion === 'number' && Number.isSafeInteger(task.contextVersion)
    ? task.contextVersion
    : 1
  return {
    task: {
      taskId,
      executionId: text(task.executionId),
      projectId,
      title: text(task.title, taskId),
      goal: text(task.goal),
      contextVersion,
      reviewPolicy: record(task.reviewPolicy) as TaskRecord['task']['reviewPolicy']
    },
    resolvedTarget: raw.resolvedTarget === 'GEMINI' ? 'GEMINI' : 'CODEX',
    state: text(raw.state, 'UNKNOWN'),
    binding: raw.binding && typeof raw.binding === 'object' ? record(raw.binding) : null,
    result: raw.result && typeof raw.result === 'object' ? record(raw.result) : null,
    reviewAutomation: reviewAutomation(raw.reviewAutomation),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt)
  }
}

function reviewRecord(value: unknown): ReviewRecord | null {
  const raw = record(value)
  if (!text(raw.taskId) || !Array.isArray(raw.cycles)) return null
  return raw as unknown as ReviewRecord
}

function stateLabel(state: string) {
  const labels: Record<string, string> = {
    DRAFT: '草稿', DISPATCHED: '已派发', RUNNING: '执行中', RESULT_READY: '结果就绪', REVIEW_PENDING: '等待审核',
    REVIEWING: '审核中', FIX_DISPATCHED: '返工中', COMPLETE: '已完成', BLOCKED: '阻塞', ESCALATE_HUMAN: '需人工介入',
    OUTCOME_UNKNOWN: '结果未知', FAILED: '失败'
  }
  return labels[state] ?? state
}

function automationLabel(status: ReviewAutomation['status'] | null) {
  if (status === 'QUEUED') return '等待同一 GPT 会话的前序审核'
  if (status === 'RUNNING') return 'GPT Web 正在自动审核'
  if (status === 'SUCCEEDED') return '上一轮 GPT Web 审核成功'
  if (status === 'FAILED') return 'GPT Web 自动审核失败'
  if (status === 'IDLE') return '等待自动审核'
  return '尚未启动自动审核'
}

function stateClass(state: string) {
  if (state === 'COMPLETE') return 'complete'
  if (state === 'RUNNING' || state === 'FIX_DISPATCHED') return 'running'
  if (state === 'REVIEW_PENDING' || state === 'REVIEWING') return 'review'
  if (state === 'FAILED' || state === 'BLOCKED' || state === 'OUTCOME_UNKNOWN') return 'danger'
  return ''
}

function uid() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function TaskDock() {
  const bridges = useMemo(api, [])
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState<Project | null>(null)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [review, setReview] = useState<ReviewRecord | null>(null)
  const [fixes, setFixes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(() => tasks.find(task => task.task.taskId === selectedId) ?? null, [selectedId, tasks])
  const pendingCount = tasks.filter(task => task.state === 'REVIEW_PENDING' || task.state === 'RUNNING' || task.state === 'FIX_DISPATCHED').length

  const refresh = async () => {
    if (!bridges.tasks) return
    const active = bridges.projects ? await bridges.projects.getActive() : null
    setProject(active)
    const values = await bridges.tasks.list({ projectId: active?.id ?? null, limit: 300 })
    const rows = Array.isArray(values) ? values.map(taskRecord).filter((value): value is TaskRecord => Boolean(value)) : []
    setTasks(rows)
    setSelectedId(current => current && rows.some(task => task.task.taskId === current) ? current : rows[0]?.task.taskId ?? '')
  }

  const loadReview = async (taskId: string) => {
    if (!bridges.tasks || !taskId) {
      setReview(null)
      return
    }
    try {
      setReview(reviewRecord(await bridges.tasks.reviewGet({ taskId })))
    } catch (reason) {
      setError(`审核包读取失败：${errorMessage(reason)}`)
    }
  }

  useEffect(() => {
    if (!bridges.tasks) return
    void refresh().catch(reason => setError(errorMessage(reason)))
    const changed = () => void refresh().catch(reason => setError(errorMessage(reason)))
    window.addEventListener(ZERO3_ACTIVE_PROJECT_CHANGED, changed)
    return () => window.removeEventListener(ZERO3_ACTIVE_PROJECT_CHANGED, changed)
  }, [bridges.tasks])

  useEffect(() => {
    if (!open || !bridges.tasks) return
    void refresh().catch(reason => setError(errorMessage(reason)))
    const timer = window.setInterval(() => void refresh().catch(reason => setError(errorMessage(reason))), 2_000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    void loadReview(selectedId)
    setFixes('')
  }, [selectedId])

  const submitDecision = async (decisionKind: 'APPROVED' | 'CHANGES_REQUESTED') => {
    if (!bridges.tasks || !selected || !review || busy) return
    const current = review.cycles.at(-1)
    if (!current) return
    const requiredFixes = fixes.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (decisionKind === 'CHANGES_REQUESTED' && requiredFixes.length === 0) {
      setError('要求返工时至少填写一条必改项。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await bridges.tasks.reviewDecision({
        taskId: selected.task.taskId,
        contextVersion: selected.task.contextVersion,
        decision: {
          protocol: 'zero3.pilot.review-decision.v1',
          reviewId: current.packet.reviewId,
          taskId: selected.task.taskId,
          cycle: current.cycle,
          decision: decisionKind,
          findings: [],
          requiredFixes,
          optionalSuggestions: [],
          reviewerSessionId: `human:${uid()}`,
          createdAt: new Date().toISOString()
        }
      })
      await refresh()
      await loadReview(selected.task.taskId)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const retryGptWebReview = async () => {
    if (!bridges.tasks || !selected || busy) return
    setBusy(true)
    setError(null)
    try {
      await bridges.tasks.reviewGptWeb({ taskId: selected.task.taskId })
      await refresh()
      await loadReview(selected.task.taskId)
    } catch (reason) {
      setError(`GPT Web 自动审核失败：${errorMessage(reason)}`)
      await refresh().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  const copyReviewPacket = async () => {
    const current = review?.cycles.at(-1)
    if (!current) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(current.packet, null, 2))
    } catch (reason) {
      setError(`复制审核包失败：${errorMessage(reason)}`)
    }
  }

  if (!bridges.tasks) return null

  const latestCycle = review?.cycles.at(-1) ?? null
  const resultSummary = selected ? text(selected.result?.summary) : ''
  const automation = selected?.reviewAutomation ?? null
  const reviewerBusy = automation?.status === 'QUEUED' || automation?.status === 'RUNNING'
  const gptReviewTask = selected?.task.reviewPolicy?.reviewer === 'GPT_WEB'

  return (
    <>
      <button aria-label="任务总控台" className="task-rail-button" onClick={() => setOpen(true)} title="任务总控台" type="button">
        <span>✓</span>{pendingCount > 0 ? <b>{Math.min(99, pendingCount)}</b> : null}
      </button>

      {open ? (
        <div className="task-backdrop" role="presentation">
          <section aria-modal="true" className="task-modal" role="dialog">
            <header className="task-head">
              <div><h2>任务总控台</h2><p>{project ? `当前项目：${project.name}` : '当前未选择 Project'} · 状态来自 durable Task Store，不使用模拟数据。</p></div>
              <button aria-label="关闭" onClick={() => setOpen(false)} type="button">×</button>
            </header>

            <div className="task-layout">
              <aside className="task-list">
                <div className="task-list-head"><strong>任务</strong><button onClick={() => void refresh()} type="button">刷新</button></div>
                {tasks.length ? tasks.map(task => (
                  <button className={selectedId === task.task.taskId ? 'active' : ''} key={task.task.taskId} onClick={() => setSelectedId(task.task.taskId)} type="button">
                    <span className={`task-state-dot ${stateClass(task.state)}`} />
                    <span><strong>{task.task.title}</strong><small>{task.resolvedTarget} · {stateLabel(task.state)}</small></span>
                  </button>
                )) : <div className="task-empty">当前项目还没有任务。</div>}
              </aside>

              <div className="task-detail">
                {selected ? (
                  <>
                    <div className="task-title-row"><div><h3>{selected.task.title}</h3><p>{selected.task.taskId} · {selected.task.executionId}</p></div><span className={`task-state-pill ${stateClass(selected.state)}`}>{stateLabel(selected.state)}</span></div>
                    <section className="task-section"><h4>目标</h4><p>{selected.task.goal}</p></section>
                    {resultSummary ? <section className="task-section"><h4>执行结果</h4><p>{resultSummary}</p></section> : null}
                    {latestCycle ? (
                      <section className="task-section task-review-section">
                        <div className="task-section-heading"><h4>审核 Cycle {latestCycle.cycle}</h4><button onClick={() => void copyReviewPacket()} type="button">复制 Review Packet</button></div>
                        <p>{latestCycle.packet.resultSummary}</p>
                        {latestCycle.packet.changedFiles?.length ? <div className="task-files"><strong>Changed files</strong>{latestCycle.packet.changedFiles.map(file => <code key={file}>{file}</code>)}</div> : null}
                        {gptReviewTask ? (
                          <div className="task-human-fallback">
                            <strong>GPT Web 自动审核 · {automationLabel(automation?.status ?? null)}</strong>
                            <p>自动审核使用绑定的真实 ChatGPT 会话，并串行处理同一会话的多个任务。发给 GPT 的审核包会尽量附带由 Codex read-only command/exec 采集的真实 Git diff。</p>
                            {automation ? <p>尝试次数：{automation.attempts}{automation.cycle ? ` · 最近 Cycle ${automation.cycle}` : ''}{automation.reviewerSessionId ? ` · Reviewer ${automation.reviewerSessionId}` : ''}</p> : null}
                            {automation?.lastError ? <div className="task-error">{automation.lastError}</div> : null}
                            {selected.state === 'REVIEW_PENDING' ? <div><button className="task-primary" disabled={busy || reviewerBusy} onClick={() => void retryGptWebReview()} type="button">{reviewerBusy ? '自动审核进行中…' : '重试 GPT Web 自动审核'}</button></div> : null}
                          </div>
                        ) : null}
                        {selected.state === 'REVIEW_PENDING' ? (
                          <div className="task-human-fallback">
                            <strong>人工兜底 ReviewDecision</strong>
                            <p>GPT Web 自动审核采用 Chromium Accessibility/Input，不调用私有 ChatGPT API，也不覆盖已有草稿。若自动通道失败或证据不足，可在这里人工批准或提交必改项；CHANGES_REQUESTED 仍进入同 Provider 自动返工链路。</p>
                            <textarea onChange={event => setFixes(event.target.value)} placeholder={'每行一条必改项\n例如：补充异常处理\n补充对应测试'} value={fixes} />
                            <div><button className="task-secondary" disabled={busy} onClick={() => void submitDecision('CHANGES_REQUESTED')} type="button">要求返工</button><button className="task-primary" disabled={busy} onClick={() => void submitDecision('APPROVED')} type="button">人工批准</button></div>
                          </div>
                        ) : null}
                      </section>
                    ) : selected.state === 'REVIEW_PENDING' ? <section className="task-section"><p>正在等待 Review Packet 写入。</p></section> : null}
                    <details className="task-raw"><summary>权威任务记录</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
                  </>
                ) : <div className="task-empty-detail">选择一个真实任务查看执行与审核状态。</div>}
                {error ? <div className="task-error">{error}<button onClick={() => setError(null)} type="button">×</button></div> : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

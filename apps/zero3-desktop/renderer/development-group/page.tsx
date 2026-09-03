import { useCallback, useEffect, useMemo, useState } from 'react'

type SessionStatus =
  | 'planned' | 'waiting_dependencies' | 'ready' | 'starting' | 'running' | 'waiting_input'
  | 'delivering' | 'delivered' | 'integrating' | 'integrated' | 'verified' | 'paused'
  | 'blocked' | 'outcome_unknown' | 'failed' | 'cancelled' | 'superseded'

type GroupSnapshot = {
  view: {
    summary: {
      groupId: string
      goal: string
      repository: string
      status: string
      activeWaveId?: string
      attentionCount: number
      progress: { verifiedRequirements: number; totalRequirements: number; verifiedSessions: number; totalSessions: number }
    }
    sessions: Array<{
      sessionId: string
      objective: string
      waveId: string
      status: SessionStatus
      attempt: number
      branch: string
      worktree: string
      requirements: readonly string[]
      dependencies: readonly string[]
      needsAttention: boolean
      blocker?: string
      executorSessionId?: string
    }>
    requirements: Array<{
      requirementId: string
      title: string
      mandatory: boolean
      ownerSessionId?: string
      deliveryStatus: string
      integrated: boolean
      verified: boolean
      testEvidence: readonly string[]
    }>
    waves: Array<{ waveId: string; ordinal: number; sessionIds: readonly string[]; dependencies: readonly string[]; integrated: boolean }>
    verifications: Array<{ verificationRunId: string; integrationSha: string; status: string; passed: number; failed: number; notRun: number }>
    failures: readonly unknown[]
    repairs: readonly unknown[]
    integrations: Array<{ integrationRunId: string; headSha: string; status: string; mergedSessionIds: readonly string[]; conflicts: readonly string[] }>
  }
  completion?: { finalIntegrationSha: string; generatedAt: string }
  verificationPolicy: { revision: string; mandatoryTests: readonly string[] }
}

type ProductEvent = {
  type: 'group.changed' | 'executor.event' | 'runtime.error'
  groupId: string
  sessionId?: string
  detail?: string
  event?: {
    type: string
    requestId?: string
    description?: string
    allowSessionApproval?: boolean
  }
}

type PendingPermission = {
  groupId: string
  sessionId: string
  requestId: string
  description: string
  allowSessionApproval: boolean
}

const inputClass = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40'
const buttonClass = 'inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
const primaryButtonClass = 'inline-flex items-center justify-center rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'

function statusTone(status: string): string {
  if (['completed', 'verified', 'passed', 'integrated', 'delivered'].includes(status)) return 'text-emerald-600 dark:text-emerald-400'
  if (['failed', 'blocked', 'outcome_unknown'].includes(status)) return 'text-red-600 dark:text-red-400'
  if (['running', 'starting', 'integrating', 'verifying', 'waiting_input'].includes(status)) return 'text-amber-600 dark:text-amber-400'
  return 'text-muted-foreground'
}

function JsonEvidencePanel({ snapshot, onRefresh }: { snapshot: GroupSnapshot; onRefresh: () => Promise<void> }) {
  const [sessionId, setSessionId] = useState(snapshot.view.sessions[0]?.sessionId ?? '')
  const [delivery, setDelivery] = useState('')
  const [handoff, setHandoff] = useState('')
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!snapshot.view.sessions.some(session => session.sessionId === sessionId)) {
      setSessionId(snapshot.view.sessions[0]?.sessionId ?? '')
    }
  }, [sessionId, snapshot])

  const submit = async () => {
    setBusy(true)
    setResult('')
    try {
      const parsedDelivery = JSON.parse(delivery)
      const parsedHandoff = JSON.parse(handoff)
      if (parsedDelivery.sessionId !== sessionId) throw new Error('Delivery sessionId 与当前选择的 Session 不一致')
      const response = await window.zero3DevelopmentGroups.acceptDelivery({
        groupId: snapshot.view.summary.groupId,
        delivery: parsedDelivery,
        handoff: parsedHandoff
      })
      if (!response.accepted) {
        setResult(`DELIVERY_REJECT\n${response.gate.reasons.join('\n')}`)
      } else {
        setResult('DELIVERY_ACCEPT')
        await onRefresh()
      }
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="rounded-lg border border-border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">提交 Delivery / Handoff 证据</summary>
      <div className="grid gap-3 border-t border-border p-4">
        <select className={inputClass} value={sessionId} onChange={event => setSessionId(event.target.value)}>
          {snapshot.view.sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.sessionId} · {session.status}</option>)}
        </select>
        <textarea className={`${inputClass} min-h-32 font-mono text-xs`} placeholder="zero3.pilot.development-delivery.v1 JSON" value={delivery} onChange={event => setDelivery(event.target.value)} />
        <textarea className={`${inputClass} min-h-32 font-mono text-xs`} placeholder="zero3.pilot.handoff.v1 checkpoint JSON" value={handoff} onChange={event => setHandoff(event.target.value)} />
        <div className="flex items-center gap-2">
          <button className={primaryButtonClass} disabled={busy || !delivery.trim() || !handoff.trim()} onClick={() => void submit()}>{busy ? '校验中…' : '校验并接收'}</button>
          <span className="text-xs text-muted-foreground">仅 Git / ownership / handoff / hash 全部通过后才进入集成队列。</span>
        </div>
        {result ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{result}</pre> : null}
      </div>
    </details>
  )
}

export function DevelopmentGroupPage() {
  const [groups, setGroups] = useState<GroupSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [repositoryRoot, setRepositoryRoot] = useState('')
  const [goal, setGoal] = useState('')
  const [plan, setPlan] = useState('')
  const [requirements, setRequirements] = useState('')
  const [busy, setBusy] = useState<string>('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<PendingPermission | null>(null)
  const [activity, setActivity] = useState<string[]>([])

  const refresh = useCallback(async () => {
    const next = await window.zero3DevelopmentGroups.list()
    setGroups(next)
    setSelectedId(current => current && next.some(group => group.view.summary.groupId === current) ? current : (next[0]?.view.summary.groupId ?? ''))
  }, [])

  useEffect(() => {
    void refresh().catch(err => setError(err instanceof Error ? err.message : String(err)))
    return window.zero3DevelopmentGroups.onEvent((event: ProductEvent) => {
      if (event.type === 'executor.event' && event.event?.type === 'permission.requested' && event.sessionId && event.event.requestId) {
        setPending({
          groupId: event.groupId,
          sessionId: event.sessionId,
          requestId: event.event.requestId,
          description: event.event.description ?? 'Codex 请求权限',
          allowSessionApproval: event.event.allowSessionApproval === true
        })
      }
      const detail = event.event?.type ?? event.detail ?? event.type
      setActivity(current => [`${new Date().toLocaleTimeString()} · ${event.groupId}${event.sessionId ? `/${event.sessionId}` : ''} · ${detail}`, ...current].slice(0, 40))
      void refresh().catch(() => undefined)
    })
  }, [refresh])

  const selected = useMemo(() => groups.find(group => group.view.summary.groupId === selectedId), [groups, selectedId])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    setError('')
    try {
      await action()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  const create = async () => {
    const requirementList = requirements.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (!repositoryRoot.trim() || !goal.trim() || requirementList.length === 0) {
      setError('请填写本地 Git 仓库路径、总目标，并至少提供一条 Requirement。')
      return
    }
    await run('create', async () => {
      const snapshot = await window.zero3DevelopmentGroups.create({
        repositoryRoot,
        masterGoal: goal,
        developmentPlan: plan.trim() || goal,
        requirements: requirementList.map(title => ({ title, description: title, acceptanceCriteria: [`${title} 完成并通过验证`] }))
      })
      setSelectedId(snapshot.view.summary.groupId)
      setGoal('')
      setPlan('')
      setRequirements('')
    })
  }

  const answerPermission = async (decision: 'approve_once' | 'approve_session' | 'deny') => {
    if (!pending) return
    await run('permission', () => window.zero3DevelopmentGroups.respondPermission({
      groupId: pending.groupId,
      sessionId: pending.sessionId,
      response: { requestId: pending.requestId, decision }
    }))
    setPending(null)
  }

  return (
    <div className="h-full overflow-auto bg-background text-foreground">
      <div className="mx-auto grid max-w-7xl gap-4 p-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h1 className="text-base font-semibold">开发组</h1>
                <p className="text-xs text-muted-foreground">Development Group V1</p>
              </div>
              <button className={buttonClass} onClick={() => void refresh()}>刷新</button>
            </div>
            <div className="space-y-2">
              {groups.length === 0 ? <p className="text-sm text-muted-foreground">还没有开发组。</p> : groups.map(group => {
                const summary = group.view.summary
                return (
                  <button key={summary.groupId} onClick={() => setSelectedId(summary.groupId)} className={`w-full rounded-md border p-3 text-left transition-colors ${selectedId === summary.groupId ? 'border-foreground/30 bg-muted' : 'border-border hover:bg-muted/60'}`}>
                    <div className="truncate text-sm font-medium">{summary.goal}</div>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="truncate text-muted-foreground">{summary.groupId}</span>
                      <span className={statusTone(summary.status)}>{summary.status}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">新建开发组</h2>
            <div className="space-y-2">
              <input className={inputClass} placeholder="本地 Git 仓库绝对路径" value={repositoryRoot} onChange={event => setRepositoryRoot(event.target.value)} />
              <input className={inputClass} placeholder="总目标" value={goal} onChange={event => setGoal(event.target.value)} />
              <textarea className={`${inputClass} min-h-20`} placeholder="开发计划（可选）" value={plan} onChange={event => setPlan(event.target.value)} />
              <textarea className={`${inputClass} min-h-28`} placeholder={'Requirements：每行一条\n例如：完成开发组产品接线\n增加 Windows 集成验收'} value={requirements} onChange={event => setRequirements(event.target.value)} />
              <button className={`${primaryButtonClass} w-full`} disabled={busy === 'create'} onClick={() => void create()}>{busy === 'create' ? '创建中…' : '生成计划并创建'}</button>
              <p className="text-[11px] leading-4 text-muted-foreground">当前 V1 使用 C1 deterministic planning fallback；不会新增第二套 Agent Planner。验证命令只能来自仓库内冻结的 <code>.zero3/verification-policy.json</code>。</p>
            </div>
          </div>
        </aside>

        <main className="min-w-0 space-y-4">
          {error ? <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">{error}</div> : null}
          {pending ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
              <div className="text-sm font-semibold">Codex 权限请求 · {pending.sessionId}</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{pending.description}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={primaryButtonClass} onClick={() => void answerPermission('approve_once')}>仅本次允许</button>
                {pending.allowSessionApproval ? <button className={buttonClass} onClick={() => void answerPermission('approve_session')}>本 Session 允许</button> : null}
                <button className={buttonClass} onClick={() => void answerPermission('deny')}>拒绝</button>
              </div>
            </div>
          ) : null}

          {!selected ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">选择或创建一个开发组。</div>
          ) : (
            <>
              <section className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-lg font-semibold">{selected.view.summary.goal}</h2>
                      <span className={`text-xs font-medium ${statusTone(selected.view.summary.status)}`}>{selected.view.summary.status}</span>
                    </div>
                    <div className="mt-1 break-all text-xs text-muted-foreground">{selected.view.summary.repository}</div>
                    <div className="mt-2 text-xs text-muted-foreground">验证策略 {selected.verificationPolicy.revision} · 必需：{selected.verificationPolicy.mandatoryTests.join(', ') || 'none'}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className={buttonClass} disabled={Boolean(busy)} onClick={() => void run('integrate', () => window.zero3DevelopmentGroups.integrate(selected.view.summary.groupId))}>{busy === 'integrate' ? '集成中…' : '受控集成'}</button>
                    <button className={primaryButtonClass} disabled={Boolean(busy)} onClick={() => void run('verify', () => window.zero3DevelopmentGroups.verify(selected.view.summary.groupId))}>{busy === 'verify' ? '验证中…' : '统一验证 / 收口'}</button>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Metric label="Session" value={`${selected.view.summary.progress.verifiedSessions}/${selected.view.summary.progress.totalSessions}`} />
                  <Metric label="Requirement" value={`${selected.view.summary.progress.verifiedRequirements}/${selected.view.summary.progress.totalRequirements}`} />
                  <Metric label="需关注" value={String(selected.view.summary.attentionCount)} />
                  <Metric label="最终 SHA" value={selected.completion?.finalIntegrationSha?.slice(0, 10) ?? '—'} />
                </div>
              </section>

              <section className="rounded-lg border border-border bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Development Sessions</h3>
                  <span className="text-xs text-muted-foreground">执行必须经过 Zero3Executor → 同一 Codex app-server</span>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {selected.view.sessions.map(session => (
                    <div key={session.sessionId} className="rounded-md border border-border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{session.sessionId} · {session.waveId}</div>
                          <p className="mt-1 text-sm text-muted-foreground">{session.objective}</p>
                        </div>
                        <span className={`shrink-0 text-xs font-medium ${statusTone(session.status)}`}>{session.status}</span>
                      </div>
                      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                        <div className="truncate">branch: {session.branch}</div>
                        <div className="truncate">worktree: {session.worktree}</div>
                        <div>attempt: {session.attempt} · deps: {session.dependencies.join(', ') || 'none'}</div>
                        {session.blocker ? <div className="text-red-600 dark:text-red-400">blocker: {session.blocker}</div> : null}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button className={primaryButtonClass} disabled={Boolean(busy) || !['ready', 'waiting_dependencies'].includes(session.status)} onClick={() => void run(`start:${session.sessionId}`, () => window.zero3DevelopmentGroups.startSession({ groupId: selected.view.summary.groupId, sessionId: session.sessionId }))}>{busy === `start:${session.sessionId}` ? '启动中…' : '启动 Session'}</button>
                        {!['verified', 'cancelled', 'superseded'].includes(session.status) ? <button className={buttonClass} disabled={Boolean(busy)} onClick={() => void run(`cancel:${session.sessionId}`, () => window.zero3DevelopmentGroups.cancelSession({ groupId: selected.view.summary.groupId, sessionId: session.sessionId }))}>取消</button> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <JsonEvidencePanel snapshot={selected} onRefresh={refresh} />

              <section className="grid gap-4 xl:grid-cols-2">
                <div className="rounded-lg border border-border bg-card p-4">
                  <h3 className="mb-3 text-sm font-semibold">Requirement 证据矩阵</h3>
                  <div className="space-y-2">
                    {selected.view.requirements.map(requirement => (
                      <div key={requirement.requirementId} className="rounded-md border border-border p-3 text-xs">
                        <div className="flex items-center justify-between gap-2"><span className="font-medium">{requirement.requirementId} · {requirement.title}</span><span className={requirement.verified ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>{requirement.verified ? 'VERIFIED' : requirement.deliveryStatus}</span></div>
                        <div className="mt-1 text-muted-foreground">owner: {requirement.ownerSessionId ?? '—'} · integrated: {String(requirement.integrated)}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="rounded-lg border border-border bg-card p-4">
                    <h3 className="mb-3 text-sm font-semibold">Waves / Integration</h3>
                    <div className="space-y-2 text-xs">
                      {selected.view.waves.map(wave => <div key={wave.waveId} className="flex items-center justify-between rounded-md border border-border p-2"><span>{wave.waveId} · {wave.sessionIds.join(', ')}</span><span className={wave.integrated ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>{wave.integrated ? 'integrated' : 'pending'}</span></div>)}
                      {selected.view.integrations.slice(-5).map(record => <div key={record.integrationRunId} className="rounded-md bg-muted p-2"><span className={statusTone(record.status)}>{record.status}</span> · {record.headSha.slice(0, 10)} · {record.mergedSessionIds.join(', ') || record.conflicts.join('; ')}</div>)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-4">
                    <h3 className="mb-3 text-sm font-semibold">Verification</h3>
                    <div className="space-y-2 text-xs">
                      {selected.view.verifications.length === 0 ? <span className="text-muted-foreground">NOT_RUN</span> : selected.view.verifications.slice(-5).map(run => <div key={run.verificationRunId} className="rounded-md border border-border p-2"><span className={statusTone(run.status)}>{run.status}</span> · PASS {run.passed} / FAIL {run.failed} / NOT_RUN {run.notRun}<div className="mt-1 font-mono text-muted-foreground">{run.integrationSha}</div></div>)}
                    </div>
                  </div>
                </div>
              </section>

              <details className="rounded-lg border border-border bg-card">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">运行事件</summary>
                <pre className="max-h-64 overflow-auto border-t border-border p-4 text-xs text-muted-foreground">{activity.join('\n') || '暂无事件'}</pre>
              </details>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-muted p-3"><div className="text-[11px] text-muted-foreground">{label}</div><div className="mt-1 truncate text-sm font-semibold">{value}</div></div>
}

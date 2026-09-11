import { useEffect, useState, useSyncExternalStore } from 'react'
import { skillInstallController, type InstallRequest } from './SkillInstallController'

const buttonClass = 'rounded-md border border-(--ui-border) px-3 py-1.5 text-xs disabled:opacity-50'

function InstallerRequest({ request }: { request: InstallRequest }) {
  const controller = skillInstallController()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const params = request.params as Record<string, any>
  const approval = request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval'
  const questions: Array<{ id: string; question: string; isSecret?: boolean; options?: Array<{ label: string; description: string }> }> =
    request.method === 'item/tool/requestUserInput' && Array.isArray(params.questions) ? params.questions : []
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) }
  }
  return <div className="space-y-2 rounded border border-amber-500/40 p-3">
    <div className="text-sm font-medium">{approval ? '安装需要授权' : questions.length ? '安装需要补充信息' : '安装器请求暂不支持'}</div>
    {approval && <>
      <div className="text-xs">{params.reason || '请检查安装器即将执行的操作。'}</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{[params.command, params.cwd, params.grantRoot].filter(Boolean).join('\n')}</pre>
      <button className={buttonClass} disabled={busy} onClick={() => void run(() => controller.respond(request, { decision: 'accept' }))}>允许本次操作</button>
      {' '}<button className={buttonClass} disabled={busy} onClick={() => void run(() => controller.respond(request, { decision: 'decline' }))}>拒绝</button>
    </>}
    {questions.map(question => <fieldset className="block text-xs" key={question.id}>
      <legend>{question.question}</legend>
      {question.options?.map(option => <button className={`${buttonClass} m-1`} title={option.description} key={option.label} disabled={busy} onClick={() => setAnswers(current => ({ ...current, [question.id]: option.label }))}>{option.label}</button>)}
      <input aria-label={question.question} className="mt-1 block w-full rounded border border-(--ui-border) bg-background p-2" type={question.isSecret ? 'password' : 'text'} value={answers[question.id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />
    </fieldset>)}
    {!!questions.length && <button className={buttonClass} disabled={busy || questions.some(question => !answers[question.id]?.trim())} onClick={() => void run(() => controller.respond(request, { answers: Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id]] }])) }))}>提交回答</button>}
    {!approval && <button className={buttonClass} disabled={busy} onClick={() => void run(() => controller.reject(request))}>拒绝请求</button>}
    {error && <div role="alert" className="text-xs text-red-500">{error}</div>}
  </div>
}

export function SkillInstallPanel({ cwd, onFinished }: { cwd: string | null; onFinished: () => void }) {
  const controller = skillInstallController()
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [source, setSource] = useState(state.source)
  const [error, setError] = useState<string | null>(null)
  const busy = state.status === 'starting' || state.status === 'running'
  useEffect(() => {
    if (['completed', 'failed', 'interrupted'].includes(state.status)) onFinished()
  }, [state.status, onFinished])
  const install = async () => {
    if (busy || !source.trim()) return
    setError(null)
    try { await controller.install(source, cwd) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const run = async (action: () => Promise<void>) => {
    setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const labels = { idle: '', starting: '正在创建安装任务…', running: '安装任务运行中', completed: '安装任务已结束，请查看安装器结果和下方 Skill 列表。', failed: '安装任务失败，可检查原因后重试。', interrupted: '安装任务已取消。' }
  return <section className="space-y-3 rounded-lg border border-(--ui-border) bg-background p-4">
    <div className="font-medium">安装 Skill（Codex 原生）</div>
    <div className="text-xs text-(--ui-text-secondary)">输入 GitHub Skill URL、仓库路径或支持的 Skill 名称，由 Codex 原生 skill-installer 执行。</div>
    <div className="flex gap-2">
      <input aria-label="Skill 安装来源" className="min-w-0 flex-1 rounded-md border border-(--ui-border) bg-(--ui-pane-background) px-3 py-2 text-sm" placeholder="https://github.com/.../tree/main/path/to/skill" value={source} maxLength={4096} disabled={busy} onChange={event => setSource(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void install() }} />
      <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!source.trim() || busy} onClick={() => void install()}>{busy ? '安装中…' : '安装'}</button>
    </div>
    {state.recoverable.length > 0 && <div className="space-y-2 rounded border border-amber-500/40 p-3 text-xs" role="alert">
      <div className="text-sm font-medium">检测到上次未完成的安装任务（应用重启被中断）</div>
      {state.recoverable.map(job => <div className="flex flex-wrap items-center gap-2" key={job.threadId}>
        <span className="min-w-0 flex-1 truncate" title={job.error ?? job.source}>来源：{job.source}{job.error ? `（${job.error}）` : ''}</span>
        <button className={buttonClass} disabled={busy} onClick={() => void run(() => controller.reinstall(job))}>重新安装</button>
        {' '}<button className={buttonClass} disabled={busy} onClick={() => void run(() => controller.dismissRecoverable(job))}>忽略</button>
      </div>)}
    </div>}
    {state.status !== 'idle' && <div role="status" className="space-y-1 text-xs">
      <div>{state.requests.length ? '等待处理安装请求' : labels[state.status]}</div>
      <div>来源：{state.source}</div>
      {state.destination && <div>安装目录：{state.destination}</div>}
      {state.threadId && <div className="select-text text-(--ui-text-tertiary)">任务：{state.threadId}</div>}
    </div>}
    {state.requests.map(request => <InstallerRequest key={request.id} request={request} />)}
    {state.output && <pre aria-label="安装器输出" className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-(--ui-pane-background) p-3 text-xs">{state.output}</pre>}
    {(error || state.error) && <div role="alert" className="text-xs text-red-500">{error || state.error}</div>}
    {state.status === 'running' && state.turnId && <button className={buttonClass} onClick={() => void controller.cancel().catch(cause => setError(String(cause)))}>取消安装</button>}
  </section>
}

import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export const ZERO3_GPT_WEB_ACTIVE_ENTRY_EVENT = 'zero3:gpt-web-active-entry'
export type Zero3GptWebActiveEntryDetail = { entryId: string | null; projectId: string | null; title: string | null }

type ControlBridge = {
  status(): Promise<{ configured: boolean; baseUrl: string | null }>
  tasks: { dispatchCodex(request: { task: Record<string, unknown>; extension?: { project_context?: unknown; handoff?: unknown } }): Promise<unknown> }
}
type AgentTaskBridge = {
  dispatch(request: { taskSpec: Record<string, unknown>; originEntryId: string }): Promise<{ taskId: string; executionId: string; target: 'CODEX' | 'GEMINI'; logicalSessionId?: string | null; webEntryId?: string | null }>
}
type HandoffActionsProps = { entry: Zero3WorkspaceEntry }
type Target = 'CODEX' | 'GEMINI'

function bridges() {
  const value = window as unknown as { zero3Control?: ControlBridge; zero3AgentTasks?: AgentTaskBridge }
  return { control: value.zero3Control ?? null, agent: value.zero3AgentTasks ?? null }
}
function uid() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}` }

export function Zero3GptWebHandoffActions({ entry }: HandoffActionsProps) {
  const api = useMemo(bridges, [])
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<Target>('CODEX')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [taskId, setTaskId] = useState(() => `gpt-${uid().slice(0, 12)}`)
  const [objective, setObjective] = useState(entry.localDisplayTitle || entry.pageTitle || '')
  const [workspace, setWorkspace] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [taskType, setTaskType] = useState('IMPLEMENT')

  const openFor = (next: Target) => { setTarget(next); setTaskType(next === 'GEMINI' ? 'DESIGN' : 'IMPLEMENT'); setOpen(true); setError(null); setResult(null) }

  const dispatch = async () => {
    if (busy) return
    setBusy(true); setError(null); setResult(null)
    try {
      const task = taskId.trim(), goal = objective.trim(), cwd = workspace.trim()
      if (!task || !goal || !cwd) throw new Error('Task ID、目标和独立 Workspace 都是必填项。')
      if (!entry.projectId) throw new Error('请先把 GPT Web 会话绑定到 Zero3 Project。')
      const executionId = uid()
      const taskSpec = {
        protocol: 'zero3.pilot.task-spec.v2', taskId: task, executionId, projectId: entry.projectId,
        target, type: taskType, title: goal.slice(0, 160), goal, contextVersion: 1,
        baseSha: baseRef.trim() || null, worktreePath: cwd,
        requirements: [], constraints: [
          'Do not use ChatGPT/Gemini web DOM as the task transport.',
          'Preserve provider/runtime authority boundaries and publish structured evidence.'
        ], requiredContracts: [], inputArtifacts: [], expectedOutputs: [], verification: [],
        completionGate: target === 'CODEX' ? ['codex.turn.completed','git.preflight','git.postflight','execution.result'] : ['result.json.valid','scope.valid','review.packet.generated'],
        reviewPolicy: { required: true, reviewer: 'GPT_WEB', maxCycles: 5 }, createdBySessionId: entry.id, createdAt: new Date().toISOString()
      }

      if (api.agent) {
        const dispatched = await api.agent.dispatch({ taskSpec, originEntryId: entry.id })
        setResult(`已派发 ${dispatched.taskId} → ${dispatched.target}，Execution ${dispatched.executionId}`)
        if (dispatched.target === 'GEMINI' && dispatched.webEntryId) {
          window.dispatchEvent(new CustomEvent('zero3:gemini-open-entry', { detail: { entryId: dispatched.webEntryId } }))
        }
        return
      }

      if (target === 'GEMINI') throw new Error('当前构建尚未接入 Zero3 Agent Router / Antigravity dispatch bridge。')
      if (!api.control) throw new Error('当前桌面构建尚未接入 Zero3 Control Plane Bridge。')
      const status = await api.control.status(); if (!status.configured) throw new Error('Zero3 Control Plane 尚未配置。')
      await api.control.tasks.dispatchCodex({
        task: {
          protocol: 'zero3.pilot.remote-task.v1', task_id: task, execution_id: executionId, objective: goal,
          target: { workspace: cwd, ...(baseRef.trim() ? { base_ref: baseRef.trim() } : {}) }, permission_profile: 'standard',
          constraints: ['Open-source Codex remains the authoritative execution kernel.','Inspect the real repository before modifying it.'],
          acceptance_criteria: ['Complete the requested objective and publish authoritative execution evidence.'],
          execution: { max_turns: 1, timeout_seconds: 3600, require_clean_worktree: true }
        },
        extension: {
          project_context: { project_id: entry.projectId, source_entry_id: entry.id, source_kind: 'gpt_web' },
          handoff: { result_protocol: 'zero3.pilot.execution-result.v1', return_entry_id: entry.id, required_evidence: ['codex.turn.completed','git.preflight','git.postflight','execution.result'] }
        }
      })
      setResult(`已派发 ${task} → CODEX，Execution ${executionId}`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  return <>
    <div className="flex flex-wrap items-center gap-1 px-2 pb-1" data-zero3-gpt-web-actions="" data-zero3-gpt-web-section="">
      <Button className="h-6 gap-1 px-2 text-[0.6875rem]" onClick={() => openFor('CODEX')} size="sm" variant="outline"><Codicon className="size-3.5" name="run-all"/>交给 Codex</Button>
      <Button className="h-6 gap-1 px-2 text-[0.6875rem]" onClick={() => openFor('GEMINI')} size="sm" variant="outline"><span className="text-violet-500">✦</span>交给 Gemini</Button>
      <Button className="h-6 gap-1 px-2 text-[0.6875rem]" onClick={() => void window.zero3GptWeb.openExternal({ id: entry.id })} size="sm" variant="ghost"><Codicon className="size-3.5" name="link-external"/>浏览器</Button>
    </div>

    <Dialog onOpenChange={setOpen} open={open}><DialogContent className="max-w-xl" data-zero3-gpt-web-section="">
      <DialogHeader><DialogTitle>交给 {target === 'GEMINI' ? 'Gemini' : 'Codex'}</DialogTitle><DialogDescription>Zero3 外层 TaskSpecV2 / Handoff，不读取 ChatGPT DOM。TaskSpec 已由 Zero3 App/MCP 暂存时可无须复制；此 Sheet 是通用 Level-A fallback。</DialogDescription></DialogHeader>
      <div className="grid gap-3 text-xs">
        <label className="grid gap-1"><span className="text-(--ui-text-tertiary)">Task ID</span><input className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2" value={taskId} onChange={e => setTaskId(e.target.value)}/></label>
        <label className="grid gap-1"><span className="text-(--ui-text-tertiary)">Task Type</span><select className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2" value={taskType} onChange={e => setTaskType(e.target.value)}>{['DESIGN','IMPLEMENT','VERIFY','FIX','REVIEW','INTEGRATE','RESEARCH'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="grid gap-1"><span className="text-(--ui-text-tertiary)">目标</span><textarea className="min-h-20 rounded-md border border-(--ui-stroke-secondary) bg-transparent p-2" value={objective} onChange={e => setObjective(e.target.value)}/></label>
        <label className="grid gap-1"><span className="text-(--ui-text-tertiary)">独立 Worktree / Workspace</span><input className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2" placeholder="C:\\workspace\\task-worktree" value={workspace} onChange={e => setWorkspace(e.target.value)}/></label>
        <label className="grid gap-1"><span className="text-(--ui-text-tertiary)">Base SHA（可选）</span><input className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2" value={baseRef} onChange={e => setBaseRef(e.target.value)}/></label>
        {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-destructive">{error}</div>}
        {result && <div className="rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5 text-(--ui-text-secondary)">{result}</div>}
      </div>
      <DialogFooter><Button disabled={busy} onClick={() => void dispatch()}>{busy ? '派发中…' : `确认派发给 ${target === 'GEMINI' ? 'Gemini' : 'Codex'}`}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>
}

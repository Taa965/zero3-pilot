import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

export const ZERO3_GPT_WEB_ACTIVE_ENTRY_EVENT = 'zero3:gpt-web-active-entry'

export type Zero3GptWebActiveEntryDetail = {
  entryId: string | null
  projectId: string | null
  title: string | null
}

type ControlBridge = {
  status(): Promise<{ configured: boolean; baseUrl: string | null }>
  tasks: {
    dispatchCodex(request: {
      task: Record<string, unknown>
      extension?: {
        project_context?: unknown
        handoff?: unknown
      }
    }): Promise<unknown>
  }
}

type HandoffActionsProps = {
  entry: Zero3WorkspaceEntry
}

function controlBridge(): ControlBridge | null {
  return (window as unknown as { zero3Control?: ControlBridge }).zero3Control ?? null
}

function newExecutionId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function Zero3GptWebHandoffActions({ entry }: HandoffActionsProps) {
  const control = useMemo(() => controlBridge(), [])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [taskId, setTaskId] = useState(() => `gpt-${newExecutionId().slice(0, 12)}`)
  const [objective, setObjective] = useState(entry.localDisplayTitle || entry.pageTitle || '')
  const [workspace, setWorkspace] = useState('')
  const [baseRef, setBaseRef] = useState('')

  const dispatch = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      if (!control) throw new Error('当前桌面构建尚未接入 Zero3 Control Plane Bridge。')
      const status = await control.status()
      if (!status.configured) throw new Error('Zero3 Control Plane 尚未配置，无法派发本地 Codex 任务。')
      const trimmedTaskId = taskId.trim()
      const trimmedObjective = objective.trim()
      const trimmedWorkspace = workspace.trim()
      if (!trimmedTaskId || !trimmedObjective || !trimmedWorkspace) {
        throw new Error('Task ID、目标和本地 Workspace 都是必填项。')
      }
      const executionId = newExecutionId()
      await control.tasks.dispatchCodex({
        task: {
          protocol: 'zero3.pilot.remote-task.v1',
          task_id: trimmedTaskId,
          execution_id: executionId,
          objective: trimmedObjective,
          target: {
            workspace: trimmedWorkspace,
            ...(baseRef.trim() ? { base_ref: baseRef.trim() } : {})
          },
          permission_profile: 'standard',
          constraints: [
            'Open-source Codex remains the authoritative execution kernel.',
            'Inspect the real repository before modifying it.',
            'Do not claim success unless required verification evidence is satisfied.'
          ],
          acceptance_criteria: ['Complete the requested objective and publish authoritative execution evidence.'],
          execution: {
            max_turns: 1,
            timeout_seconds: 3600,
            require_clean_worktree: true
          }
        },
        extension: {
          project_context: entry.projectId
            ? {
                project_id: entry.projectId,
                source_entry_id: entry.id,
                source_kind: 'gpt_web'
              }
            : undefined,
          handoff: {
            result_protocol: 'zero3.pilot.execution-result.v1',
            return_entry_id: entry.id,
            required_evidence: ['codex.turn.completed', 'git.preflight', 'git.postflight', 'execution.result']
          }
        }
      })
      setResult(`已派发 ${trimmedTaskId}，Execution ${executionId}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-1 px-2 pb-1" data-zero3-gpt-web-actions="" data-zero3-gpt-web-section="">
        <Button className="h-6 gap-1 px-2 text-[0.6875rem]" onClick={() => setOpen(true)} size="sm" variant="outline">
          <Codicon className="size-3.5" name="run-all" />
          交给 Codex
        </Button>
        <Button
          className="h-6 gap-1 px-2 text-[0.6875rem]"
          onClick={() => void window.zero3GptWeb.openExternal({ id: entry.id })}
          size="sm"
          variant="ghost"
        >
          <Codicon className="size-3.5" name="link-external" />
          浏览器
        </Button>
      </div>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-w-xl" data-zero3-gpt-web-section="">
          <DialogHeader>
            <DialogTitle>交给 Codex 执行</DialogTitle>
            <DialogDescription>
              这是 Zero3 外层 Task/Handoff Sheet。不会读取 ChatGPT DOM；有 Zero3 App/MCP TaskSpec 时可直接复用，本表单作为 V1 受控 fallback。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 text-xs">
            <label className="grid gap-1">
              <span className="text-(--ui-text-tertiary)">Task ID</span>
              <input className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 outline-none" onChange={event => setTaskId(event.target.value)} value={taskId} />
            </label>
            <label className="grid gap-1">
              <span className="text-(--ui-text-tertiary)">目标</span>
              <textarea className="min-h-20 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1.5 outline-none" onChange={event => setObjective(event.target.value)} value={objective} />
            </label>
            <label className="grid gap-1">
              <span className="text-(--ui-text-tertiary)">Windows / Local Workspace</span>
              <input className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 outline-none" onChange={event => setWorkspace(event.target.value)} placeholder="C:\\workspace\\project" value={workspace} />
            </label>
            <label className="grid gap-1">
              <span className="text-(--ui-text-tertiary)">Base Ref / SHA（可选）</span>
              <input className="h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 outline-none" onChange={event => setBaseRef(event.target.value)} value={baseRef} />
            </label>
            {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-destructive">{error}</div>}
            {result && <div className="rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5 text-(--ui-text-secondary)">{result}</div>}
          </div>

          <DialogFooter>
            <Button disabled={busy} onClick={() => void dispatch()}>
              {busy ? '派发中…' : '确认派发'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

import { useState } from 'react'

import { WorkflowAdapter, type WorkflowSnapshot, type WorkflowStage } from '../../WorkflowAdapter'

const stageOrder = ['input-ingest', 'script-rewrite', 'visual-plan', 'image-production', 'local-ingest', 'cloud-render', 'pullback']
const shortLabels: Record<string, string> = {
  'input-ingest': '上传',
  'script-rewrite': '脚本',
  'visual-plan': '视觉',
  'image-production': '图片',
  'local-ingest': '接包',
  'cloud-render': '云端',
  pullback: '回传'
}
function statusMark(status: string): string {
  if (status === 'COMPLETED') return '✓'
  if (['RUNNING', 'CLAIMED', 'VERIFYING', 'FIX_REQUIRED'].includes(status)) return '●'
  if (['BLOCKED', 'FAILED', 'WAITING_HUMAN'].includes(status)) return '!'
  return '○'
}
function statusClass(status: string): string {
  if (status === 'COMPLETED') return 'text-green-500'
  if (['RUNNING', 'CLAIMED', 'VERIFYING'].includes(status)) return 'text-blue-500'
  if (status === 'FIX_REQUIRED') return 'text-amber-500'
  if (['BLOCKED', 'FAILED', 'WAITING_HUMAN'].includes(status)) return 'text-red-500'
  return 'text-(--ui-text-tertiary)'
}

export function CognitiveStoreVideoRunView({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const [ingestBusy, setIngestBusy] = useState(false)
  const [ingestError, setIngestError] = useState<string | null>(null)
  const workers = snapshot.plan.workers.map(worker => {
    const stages = snapshot.stages.filter(stage => stage.workerDefinitionId === worker.workerDefinitionId)
    const active = stages.find(stage => ['RUNNING', 'CLAIMED', 'VERIFYING', 'FIX_REQUIRED'].includes(stage.status))
    return { worker, stages, active, completed: stages.filter(stage => stage.status === 'COMPLETED').length, ready: stages.filter(stage => ['READY', 'FIX_REQUIRED'].includes(stage.status)).length }
  })
  const inputStages = snapshot.stages.filter(stage => stage.stageId === 'input-ingest')
  const pendingInputCount = inputStages.filter(stage => ['READY', 'FIX_REQUIRED', 'BLOCKED', 'WAITING_HUMAN'].includes(stage.status)).length
  const retryInputIngest = async () => {
    setIngestBusy(true); setIngestError(null)
    try { await WorkflowAdapter.ingestInputs(snapshot.run.workflowRunId) }
    catch (reason) { setIngestError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setIngestBusy(false) }
  }

  const stagesByItem = new Map<string, Map<string, WorkflowStage>>()
  for (const stage of snapshot.stages) {
    const map = stagesByItem.get(stage.itemId) ?? new Map<string, WorkflowStage>()
    map.set(stage.stageId, stage)
    stagesByItem.set(stage.itemId, map)
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      {pendingInputCount > 0 && <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs"><div><div className="font-medium text-amber-500">有 {pendingInputCount} 个输入脚本尚未进入 Google Drive</div>{ingestError && <div className="mt-1 text-red-500">{ingestError}</div>}</div><button disabled={ingestBusy} onClick={() => { void retryInputIngest() }} className="rounded border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background) disabled:opacity-50">{ingestBusy ? '处理中…' : '重试输入上传'}</button></div>}
      <div className="grid grid-cols-4 gap-3">
        <Metric label="WorkItem" value={String(snapshot.items.length)} />
        <Metric label="总进度" value={`${Math.round(snapshot.run.progress * 100)}%`} />
        <Metric label="已完成" value={String(snapshot.items.filter(item => item.status === 'COMPLETED').length)} />
        <Metric label="异常" value={String(snapshot.items.filter(item => ['FAILED', 'WAITING'].includes(item.status)).length)} />
      </div>

      <div className="mt-6 text-sm font-medium">GPT 工位</div>
      <div className="mt-2 grid grid-cols-1 gap-3 xl:grid-cols-3">
        {workers.map(({ worker, active, completed, ready, stages }) => (
          <div key={worker.workerDefinitionId} className="rounded-xl border border-(--ui-border) bg-(--ui-pane-background) p-4">
            <div className="flex items-center justify-between"><span className="font-medium">{worker.name}</span><span className="text-xs text-(--ui-text-tertiary)">GPT Web × {worker.concurrency}</span></div>
            <div className="mt-3 text-sm">{active ? <><span className="text-blue-500">●</span> {snapshot.items.find(item => item.itemId === active.itemId)?.title ?? active.itemId}</> : ready > 0 ? <><span className="text-amber-500">●</span> 待领取 {ready}</> : <span className="text-(--ui-text-tertiary)">○ 等待工作</span>}</div>
            {active?.currentActivity && <div className="mt-1 truncate text-xs text-(--ui-text-secondary)">{active.currentActivity}</div>}
            <div className="mt-3 text-xs text-(--ui-text-tertiary)">完成 {completed} / {stages.length} · Prompt {worker.promptRevision}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between"><div className="text-sm font-medium">批次流水线</div><div className="text-xs text-(--ui-text-tertiary)">每个 WorkItem 独立释放下游工序</div></div>
      <div className="mt-2 overflow-x-auto rounded-xl border border-(--ui-border)">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-(--ui-control-background) text-xs text-(--ui-text-secondary)"><tr><th className="px-3 py-2 text-left">内容</th>{stageOrder.map(stage => <th key={stage} className="px-3 py-2 text-center">{shortLabels[stage]}</th>)}</tr></thead>
          <tbody>
            {snapshot.items.map(item => {
              const byStage = stagesByItem.get(item.itemId) ?? new Map()
              return <tr key={item.itemId} className="border-t border-(--ui-border)"><td className="max-w-[240px] truncate px-3 py-2 font-medium">{item.title}<div className="mt-0.5 text-[11px] font-normal text-(--ui-text-tertiary)">{Math.round(item.progress * 100)}%</div></td>{stageOrder.map(stageId => { const stage = byStage.get(stageId); return <td key={stageId} title={stage ? `${stage.title} · ${stage.status}` : stageId} className={`px-3 py-2 text-center ${statusClass(stage?.status ?? '')}`}>{statusMark(stage?.status ?? '')}</td> })}</tr>
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-(--ui-border) bg-(--ui-pane-background) p-4"><div className="text-xs text-(--ui-text-tertiary)">{label}</div><div className="mt-1 text-xl font-semibold">{value}</div></div>
}

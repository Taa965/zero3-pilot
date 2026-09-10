import { useEffect, useMemo, useState } from 'react'

import { WorkflowAdapter, type WorkflowModuleManifest, type WorkflowSnapshot } from './WorkflowAdapter'
import { WorkflowPicker } from './WorkflowPicker'
import { workflowModuleUi } from './module-ui-registry'
import { setTaskSelection, useTaskSelection } from './task-selection'

type RunTab = 'overview' | 'items' | 'workers' | 'artifacts' | 'exceptions' | 'timeline'
const runTabs: { id: RunTab; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'items', label: '工作项' },
  { id: 'workers', label: '工位' },
  { id: 'artifacts', label: '产物' },
  { id: 'exceptions', label: '异常 / 人工' },
  { id: 'timeline', label: '时间轴' }
]

export function TaskWorkspace() {
  const selection = useTaskSelection()
  const [modules, setModules] = useState<WorkflowModuleManifest[]>([])
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null)
  const [activeTab, setActiveTab] = useState<RunTab>('overview')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void WorkflowAdapter.listModules().then(setModules).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }, [])

  useEffect(() => {
    if (selection.kind !== 'run') { setSnapshot(null); return }
    setActiveTab('overview')
    let cancelled = false
    const refresh = async () => {
      try {
        const value = await WorkflowAdapter.getRun(selection.runId)
        if (!cancelled) { setSnapshot(value); setError(null) }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [selection.kind === 'run' ? selection.runId : null])

  const selectedModule = useMemo(() => {
    if (selection.kind !== 'new' || !selection.moduleId) return null
    return modules.find(module => module.id === selection.moduleId) ?? null
  }, [modules, selection])

  if (selection.kind === 'new') {
    if (!selectedModule) return <WorkflowPicker modules={modules} onSelect={module => setTaskSelection({ kind: 'new', moduleId: module.id })} />
    const registration = workflowModuleUi(selectedModule.uiKind)
    if (!registration) return <Unavailable message={`工作流 ${selectedModule.name} 没有已注册 UI。`} />
    const CreateRun = registration.CreateRun
    return <CreateRun moduleVersion={selectedModule.version} />
  }

  if (selection.kind !== 'run') return <EmptyState onNew={() => setTaskSelection({ kind: 'new' })} />
  if (error) return <Unavailable message={error} />
  if (!snapshot) return <div className="flex h-full items-center justify-center text-sm text-(--ui-text-tertiary)">加载任务运行时…</div>

  const module = modules.find(candidate => candidate.id === snapshot.plan.moduleId)
  const registration = workflowModuleUi(module?.uiKind ?? snapshot.plan.moduleId)
  const RunView = registration?.RunView
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-(--ui-border) px-6">
        <div className="min-w-0"><div className="truncate font-medium">{snapshot.run.title}</div><div className="mt-0.5 text-[11px] text-(--ui-text-tertiary)">{snapshot.plan.moduleId}@{snapshot.plan.moduleVersion} · {snapshot.run.workflowRunId}</div></div>
        <div className="ml-auto rounded border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-500">{snapshot.run.status}</div>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-6 overflow-x-auto border-b border-(--ui-border) px-6 text-sm">
        {runTabs.map(tab => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`h-full whitespace-nowrap border-b-2 ${activeTab === tab.id ? 'border-blue-500 text-foreground' : 'border-transparent text-(--ui-text-secondary)'}`}>{tab.label}</button>)}
      </div>
      <div className="flex-1 overflow-hidden">
        {activeTab === 'overview' ? (RunView ? <RunView snapshot={snapshot} /> : <GenericRunView snapshot={snapshot} />) : null}
        {activeTab === 'items' ? <WorkItemsView snapshot={snapshot} /> : null}
        {activeTab === 'workers' ? <WorkersView snapshot={snapshot} /> : null}
        {activeTab === 'artifacts' ? <ArtifactsView snapshot={snapshot} /> : null}
        {activeTab === 'exceptions' ? <ExceptionsView snapshot={snapshot} /> : null}
        {activeTab === 'timeline' ? <TimelineView snapshot={snapshot} /> : null}
      </div>
    </div>
  )
}

function GenericRunView({ snapshot }: { snapshot: WorkflowSnapshot }) {
  return <div className="h-full overflow-y-auto p-6"><div className="text-lg font-medium">{snapshot.run.title}</div><div className="mt-2 text-sm text-(--ui-text-secondary)">{snapshot.items.length} 个 WorkItem · {Math.round(snapshot.run.progress * 100)}%</div></div>
}

function WorkItemsView({ snapshot }: { snapshot: WorkflowSnapshot }) {
  return <div className="h-full overflow-y-auto p-6"><div className="space-y-2">{snapshot.items.map(item => <div key={item.itemId} className="rounded-lg border border-(--ui-border) bg-(--ui-pane-background) p-3"><div className="flex items-center justify-between gap-3"><div className="font-medium">{item.title}</div><div className="text-xs text-(--ui-text-secondary)">{item.status} · {Math.round(item.progress * 100)}%</div></div><div className="mt-2 flex flex-wrap gap-1.5">{snapshot.stages.filter(stage => stage.itemId === item.itemId).map(stage => <span key={stage.stageRunId} className="rounded border border-(--ui-border) px-2 py-1 text-[11px] text-(--ui-text-secondary)">{stage.title}: {stage.status}</span>)}</div></div>)}</div></div>
}

function WorkersView({ snapshot }: { snapshot: WorkflowSnapshot }) {
  return <div className="h-full overflow-y-auto p-6"><div className="grid grid-cols-1 gap-3 lg:grid-cols-3">{snapshot.plan.workers.map(worker => { const stages = snapshot.stages.filter(stage => stage.workerDefinitionId === worker.workerDefinitionId); const active = stages.find(stage => ['CLAIMED', 'RUNNING', 'VERIFYING', 'FIX_REQUIRED'].includes(stage.status)); return <div key={worker.workerDefinitionId} className="rounded-xl border border-(--ui-border) bg-(--ui-pane-background) p-4"><div className="font-medium">{worker.name}</div><div className="mt-1 text-xs text-(--ui-text-secondary)">{worker.executor} × {worker.concurrency}</div><div className="mt-4 text-sm">{active ? `正在处理：${snapshot.items.find(item => item.itemId === active.itemId)?.title ?? active.itemId}` : '当前无活动 Claim'}</div><div className="mt-2 text-xs text-(--ui-text-tertiary)">READY {stages.filter(stage => ['READY', 'FIX_REQUIRED'].includes(stage.status)).length} · 完成 {stages.filter(stage => stage.status === 'COMPLETED').length}/{stages.length}</div><div className="mt-1 truncate text-[11px] text-(--ui-text-tertiary)">{worker.promptRevision}</div></div> })}</div></div>
}

function ArtifactsView({ snapshot }: { snapshot: WorkflowSnapshot }) {
  return <div className="h-full overflow-y-auto p-6"><div className="space-y-2">{snapshot.artifacts.map(artifact => <div key={artifact.artifactId} className="flex items-center gap-3 rounded-lg border border-(--ui-border) bg-(--ui-pane-background) p-3"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{artifact.logicalName}</div><div className="mt-0.5 truncate text-[11px] text-(--ui-text-tertiary)">{artifact.itemId} · {artifact.stageId} · {String(artifact.storage.provider ?? 'unknown')}</div></div><span className="text-xs text-green-500">{artifact.state}</span></div>)}{snapshot.artifacts.length === 0 && <div className="text-sm text-(--ui-text-tertiary)">暂无 Artifact。</div>}</div></div>
}

function ExceptionsView({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const [busy, setBusy] = useState<string | null>(null)
  const stages = snapshot.stages.filter(stage => ['BLOCKED', 'FAILED', 'WAITING_HUMAN', 'FIX_REQUIRED'].includes(stage.status))
  const resume = async (stageRunId: string) => {
    setBusy(stageRunId)
    try { await WorkflowAdapter.resumeStage(snapshot.run.workflowRunId, stageRunId) }
    finally { setBusy(null) }
  }
  return <div className="h-full overflow-y-auto p-6"><div className="space-y-2">{stages.map(stage => <div key={stage.stageRunId} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"><div className="flex items-center justify-between gap-3"><span className="font-medium">{snapshot.items.find(item => item.itemId === stage.itemId)?.title ?? stage.itemId} · {stage.title}</span><div className="flex items-center gap-2"><span className="text-xs text-amber-500">{stage.status}</span>{['BLOCKED', 'WAITING_HUMAN'].includes(stage.status) && <button disabled={busy === stage.stageRunId} onClick={() => { void resume(stage.stageRunId) }} className="rounded border border-(--ui-border) px-2 py-1 text-xs hover:bg-(--ui-control-hover-background) disabled:opacity-50">恢复</button>}</div></div>{stage.currentActivity && <div className="mt-1 text-xs text-(--ui-text-secondary)">{stage.currentActivity}</div>}</div>)}{stages.length === 0 && <div className="text-sm text-(--ui-text-tertiary)">当前没有需要人工处理的异常。</div>}</div></div>
}

function TimelineView({ snapshot }: { snapshot: WorkflowSnapshot }) {
  return <div className="h-full overflow-y-auto p-6"><div className="space-y-2">{[...snapshot.events].reverse().map(event => <div key={event.sequence} className="flex gap-3 border-b border-(--ui-border) py-2 text-xs"><div className="w-20 shrink-0 text-(--ui-text-tertiary)">#{event.sequence}</div><div className="min-w-0 flex-1"><div className="font-medium">{event.type}</div><div className="mt-0.5 truncate text-(--ui-text-tertiary)">{event.itemId ?? 'run'} · {event.stageRunId ?? ''}</div></div><div className="shrink-0 text-(--ui-text-tertiary)">{new Date(event.at).toLocaleString()}</div></div>)}</div></div>
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-(--ui-text-tertiary)"><div>任务中心现在由 Workflow Module 驱动。</div><button onClick={onNew} className="rounded bg-blue-600 px-4 py-2 text-white">新建任务</button></div>
}
function Unavailable({ message }: { message: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-red-500">{message}</div>
}

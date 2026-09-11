import { useEffect, useMemo, useState } from 'react'

import { ProjectAdapter, type Zero3ProjectRecord } from '../../../adapters/ProjectAdapter'
import { WorkflowAdapter, type WorkflowRuntimeCapabilities } from '../../WorkflowAdapter'
import { setTaskSelection } from '../../task-selection'

function stem(name: string): string { return name.replace(/\.[^.]+$/u, '') || name }

export function CognitiveStoreVideoCreateRun({ moduleVersion }: { moduleVersion: string }) {
  const [projects, setProjects] = useState<Zero3ProjectRecord[]>([])
  const [projectId, setProjectId] = useState('')
  const [title, setTitle] = useState('')
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [driveRows, setDriveRows] = useState('')
  const [driveFolderId, setDriveFolderId] = useState('')
  const [scriptWorkers, setScriptWorkers] = useState(1)
  const [visualWorkers, setVisualWorkers] = useState(1)
  const [imageWorkers, setImageWorkers] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [capabilities, setCapabilities] = useState<WorkflowRuntimeCapabilities | null>(null)

  useEffect(() => {
    void ProjectAdapter.list().then(values => {
      setProjects(values)
      if (!projectId && values[0]) setProjectId(values[0].id)
    })
  }, [])

  useEffect(() => {
    void WorkflowAdapter.runtimeCapabilities().then(setCapabilities).catch(() => setCapabilities(null))
  }, [])

  const driveScripts = useMemo(() => driveRows.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const [name, fileId] = line.split('|').map(value => value.trim())
    return { title: name || `Drive脚本${index + 1}`, driveFileId: fileId || '' }
  }), [driveRows])

  const scripts = useMemo(() => [
    ...files.map(file => ({ title: stem(file.name), localPath: file.path })),
    ...driveScripts
  ], [files, driveScripts])

  async function pickFiles() {
    try { setFiles(await WorkflowAdapter.pickInputFiles()); setError(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  async function create() {
    setBusy(true); setError(null); setWarnings([])
    try {
      if (files.length > 0 && capabilities?.artifactProviders.GOOGLE_DRIVE?.configured !== true) {
        throw new Error('当前 Zero3 Desktop 尚未配置 Google Drive 直连。请先配置 Drive OAuth，或改用已有 Drive fileId 输入。')
      }
      const input = {
        projectId,
        title: title.trim() || undefined,
        scripts,
        drive: { rootFolderId: driveFolderId.trim() || null },
        workers: { script: scriptWorkers, visual: visualWorkers, image: imageWorkers }
      }
      const validation = await WorkflowAdapter.validateCreateInput('cognitive-store-video', input, moduleVersion)
      setWarnings(validation.warnings ?? [])
      if (!validation.valid) throw new Error(validation.errors.join('；'))
      const snapshot = await WorkflowAdapter.createRun('cognitive-store-video', input, moduleVersion)
      setTaskSelection({ kind: 'run', runId: snapshot.run.workflowRunId })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto w-full max-w-4xl p-8">
      <div className="mb-1 text-xl font-semibold">认知便利店批量视频生产</div>
      <div className="mb-6 text-sm text-(--ui-text-secondary)">上传脚本后建立 WorkItem 流水线；本地文件先进入“输入上传”工序，已有 Drive fileId 的脚本会直接释放脚本重构工位。</div>

      <div className="grid gap-5 rounded-xl border border-(--ui-border) bg-(--ui-pane-background) p-5">
        <label className="grid gap-1.5 text-sm"><span className="font-medium">项目</span>
          <select value={projectId} onChange={event => setProjectId(event.target.value)} className="rounded border border-(--ui-border) bg-background px-3 py-2">
            <option value="">请选择项目</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm"><span className="font-medium">本次运行名称</span>
          <input value={title} onChange={event => setTitle(event.target.value)} placeholder="留空则自动生成" className="rounded border border-(--ui-border) bg-background px-3 py-2" />
        </label>

        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between"><span className="font-medium">输入脚本</span><button onClick={pickFiles} className="rounded border border-(--ui-border) px-3 py-1.5 hover:bg-(--ui-control-hover-background)">选择本地文件</button></div>
          <div className="min-h-16 rounded border border-dashed border-(--ui-border) p-3 text-xs text-(--ui-text-secondary)">
            {files.length ? files.map(file => <div key={file.path}>{file.name}</div>) : '尚未选择本地脚本'}
          </div>
        </div>

        <label className="grid gap-1.5 text-sm"><span className="font-medium">已有 Google Drive 文件（可选）</span>
          <textarea value={driveRows} onChange={event => setDriveRows(event.target.value)} rows={4} placeholder={'每行：标题|Drive fileId\n例如：资本论|1AbCd...'} className="rounded border border-(--ui-border) bg-background px-3 py-2 font-mono text-xs" />
        </label>
        <label className="grid gap-1.5 text-sm"><span className="font-medium">Google Drive 工作流根目录 ID（可选）</span>
          <input value={driveFolderId} onChange={event => setDriveFolderId(event.target.value)} placeholder="后续 Artifact Provider 用于创建 run 子目录" className="rounded border border-(--ui-border) bg-background px-3 py-2" />
        </label>
        <div className={`rounded-lg border p-3 text-xs ${capabilities?.artifactProviders.GOOGLE_DRIVE?.configured ? 'border-green-500/30 bg-green-500/5 text-green-500' : 'border-amber-500/30 bg-amber-500/5 text-amber-500'}`}>
          Google Drive 直连：{capabilities?.artifactProviders.GOOGLE_DRIVE?.configured ? '已配置，可自动上传本地脚本并验证 fileId' : '未配置；本地脚本不会自动进入流水线，只能使用已有 Drive fileId'}
        </div>
        <div className={`rounded-lg border p-3 text-xs ${capabilities?.artifactProviders.REMOTE_COMPUTE?.configured ? 'border-green-500/30 bg-green-500/5 text-green-500' : 'border-amber-500/30 bg-amber-500/5 text-amber-500'}`}>
          GPT→GPU 云端执行：{capabilities?.artifactProviders.REMOTE_COMPUTE?.configured ? `已配置 ${capabilities.artifactProviders.REMOTE_COMPUTE.provider ?? ''}，本地接包后可自动提交、对账和拉回视频` : `未配置${capabilities?.artifactProviders.REMOTE_COMPUTE?.error ? `：${capabilities.artifactProviders.REMOTE_COMPUTE.error}` : '；云端阶段会等待配置'}`}
        </div>

        <div className="grid grid-cols-3 gap-3 text-sm">
          {[['脚本 Worker', scriptWorkers, setScriptWorkers], ['视觉 Worker', visualWorkers, setVisualWorkers], ['图片 Worker', imageWorkers, setImageWorkers]].map(([label, value, setter]) => (
            <label key={String(label)} className="grid gap-1.5"><span className="font-medium">{String(label)}</span>
              <input type="number" min={1} max={8} value={Number(value)} onChange={event => (setter as (value: number) => void)(Math.max(1, Math.min(8, Number(event.target.value) || 1)))} className="rounded border border-(--ui-border) bg-background px-3 py-2" />
            </label>
          ))}
        </div>

        <div className="rounded-lg bg-(--ui-control-background) p-3 text-xs text-(--ui-text-secondary)">
          将创建 {scripts.length} 个 WorkItem。流水线：输入上传 → 脚本重构 → 视觉规划 → 图片生产 → 本地接包 → 云端视频 → 回传。
        </div>
        {warnings.map(value => <div key={value} className="text-xs text-amber-500">⚠ {value}</div>)}
        {error && <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={() => setTaskSelection({ kind: 'new' })} className="rounded border border-(--ui-border) px-4 py-2 text-sm">返回</button>
          <button disabled={busy} onClick={create} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '创建中…' : '创建并启动'}</button>
        </div>
      </div>
    </div>
  )
}

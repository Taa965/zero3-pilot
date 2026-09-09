import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProjectLinkAdapter, type LinkedProvider, type ProviderProjectList } from '../adapters/ProjectLinkAdapter'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'

const labels: Record<LinkedProvider, string> = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' }
type Choice = { mode: 'skip' | 'existing' | 'create'; selected: string; rootPath?: string }
const emptyChoices = (): Record<LinkedProvider, Choice> => ({ codex: { mode: 'skip', selected: '' }, claude: { mode: 'skip', selected: '' }, antigravity: { mode: 'skip', selected: '' } })
const projectKey = (item: { id: string; rootPath: string | null }) => JSON.stringify([item.id,item.rootPath])

export function ProjectLinkDialog({ project, onClose }: { project: Zero3ProjectRecord; onClose: () => void }) {
  const [catalog, setCatalog] = useState<ProviderProjectList[]>([])
  const [choices, setChoices] = useState(emptyChoices)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    ProjectLinkAdapter.list(project.id).then(result => { if (active) setCatalog(result) })
      .catch(error => { if (active) setError(error.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [project.id, revision])
  function change(provider: LinkedProvider, patch: Partial<Choice>) { setChoices(value => ({ ...value, [provider]: { ...value[provider], ...patch } })) }
  async function browse(provider: LinkedProvider) {
    try { const rootPath = await ProjectLinkAdapter.pickDirectory(); if (rootPath) change(provider, { mode: 'existing', selected: rootPath, rootPath }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  async function save() {
    setBusy(true); setError('')
    try {
      for (const provider of ['codex', 'claude', 'antigravity'] as const) {
        const choice = choices[provider]
        if (choice.mode === 'skip') continue
        const selected = catalog.find(row => row.provider === provider)?.projects.find(item => projectKey(item) === choice.selected)
        const binding = await ProjectLinkAdapter.connect({ projectId: project.id, provider, mode: choice.mode,
          ...(choice.mode === 'existing' ? { externalId: selected?.id ?? choice.selected, rootPath: selected?.rootPath ?? choice.rootPath } : {}) })
        setCatalog(value => value.map(row => row.provider === provider ? { ...row, binding } : row))
        change(provider, { mode: 'skip' })
      }
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const hasChoice = Object.values(choices).some(choice => choice.mode !== 'skip')
  const invalid = Object.values(choices).some(choice => choice.mode === 'existing' && !choice.selected)
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="sm:max-w-2xl" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => event.preventDefault()}>
      <DialogHeader>
        <DialogTitle>关联应用项目</DialogTitle>
        <DialogDescription>为「{project.name}」选择各应用的对应项目。没有对应项目时，可以由 Zero3 Pilot 创建。</DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] space-y-6 overflow-y-auto py-2">
        {loading && <p role="status" className="text-sm text-muted-foreground">正在读取应用项目…</p>}
        {!loading && catalog.map(row => {
          const choice = choices[row.provider]
          return <fieldset key={row.provider} disabled={busy} className="space-y-3">
            <legend className="font-medium">{labels[row.provider]}</legend>
            {row.binding && <p className="text-sm text-muted-foreground">{row.binding.state === 'ready' ? '已关联：' : '尚未完成：'}{row.binding.name ?? row.binding.externalId ?? '请检查创建结果'}</p>}
            <div className="flex flex-wrap gap-4 text-sm">
              {([['skip', '暂不更改'], ['existing', '关联已有项目'], ['create', '创建并关联']] as const).map(([mode, label]) =>
                <label key={mode} className="flex items-center gap-2"><input type="radio" name={`link-${row.provider}`} value={mode} checked={choice.mode === mode} onChange={() => change(row.provider, { mode })} />{label}</label>)}
            </div>
            {row.error && <p className="text-sm text-destructive">{row.error}</p>}
            {choice.mode === 'existing' && <div className="space-y-2">
              <select aria-label={`${labels[row.provider]}对应项目`} value={choice.rootPath ? 'manual' : choice.selected} onChange={event => change(row.provider, { selected: event.target.value, rootPath: undefined })} className="w-full rounded border border-input bg-background p-2 text-sm">
                <option value="">请选择项目</option>
                {row.projects.map(item => <option key={projectKey(item)} value={projectKey(item)}>{item.name}{item.rootPath ? ` · ${item.rootPath}` : ` · ${item.id}`}</option>)}
                {choice.rootPath && <option value="manual">{choice.rootPath}</option>}
              </select>
              {!row.projects.length && <p className="text-sm text-muted-foreground">未发现已有项目，可选择“创建并关联”。</p>}
              {row.provider === 'claude' && <Button variant="outline" onClick={() => void browse(row.provider)}>选择其他 Claude 项目目录</Button>}
            </div>}
            {choice.mode === 'create' && <p className="text-sm text-muted-foreground">在 {project.rootPath} 创建{row.provider === 'claude' ? ' Claude Code 项目配置' : ` ${labels[row.provider]} 项目`}。{row.provider === 'antigravity' && '项目名称由 Antigravity 创建流程生成。'}</p>}
          </fieldset>
        })}
        <p className="text-xs text-muted-foreground">关联用于新会话和后续共享记忆。原应用的聊天及已有记忆不会自动合并；正在进行的会话保留原关联。</p>
        {error && <p role="alert" className="text-sm text-destructive">{error} 已成功的关联会保留，可继续处理其余应用。</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新列表</Button>
        <Button variant="outline" disabled={busy} onClick={onClose}>稍后设置</Button>
        <Button disabled={busy || loading || !hasChoice || invalid} onClick={() => void save()}>{busy ? '正在关联…' : '保存关联'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function ProjectLinksCard({ project }: { project: Zero3ProjectRecord }) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ProviderProjectList[]>([])
  const [error, setError] = useState('')
  useEffect(() => { let active = true; ProjectLinkAdapter.list(project.id).then(result => { if (active) { setCatalog(result); setError('') } }).catch(cause => { if (active) setError(cause.message) }); return () => { active = false } }, [project.id, open])
  return <section className="rounded-lg border border-(--ui-border) bg-background p-4 sm:col-span-2">
    <div className="flex items-center justify-between"><h3>关联的应用项目</h3><Button variant="outline" onClick={() => setOpen(true)}>管理关联</Button></div>
    <ul className="mt-3 space-y-2 text-sm">{(['codex','claude','antigravity'] as const).map(provider => { const binding = catalog.find(row => row.provider === provider)?.binding; return <li key={provider}>{labels[provider]}：{binding?.state === 'ready' ? binding.name : binding ? '配置未完成' : '尚未关联'}</li> })}</ul>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    {open && <ProjectLinkDialog project={project} onClose={() => setOpen(false)} />}
  </section>
}

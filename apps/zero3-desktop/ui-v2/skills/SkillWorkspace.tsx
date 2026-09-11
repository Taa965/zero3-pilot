import { useCallback, useEffect, useMemo, useState } from 'react'

import { SkillAdapter, type SkillBinding, type SkillRecord } from './SkillAdapter'

export function SkillWorkspace({ cwd }: { cwd: string | null }) {
  const [items, setItems] = useState<SkillRecord[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [bindings, setBindings] = useState<SkillBinding[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [detail, setDetail] = useState('')
  const [targetType, setTargetType] = useState<'agent' | 'workflow' | 'task-template'>('agent')
  const [targetId, setTargetId] = useState('CODEX')

  const refresh = useCallback(async (forceReload = false) => {
    setLoading(true)
    try {
      const [snapshot, nextBindings] = await Promise.all([
        SkillAdapter.list(cwd, forceReload),
        SkillAdapter.listBindings()
      ])
      setItems(snapshot.items)
      setBindings(nextBindings)
      setSelectedPath(current => current && snapshot.items.some(item => item.path === current) ? current : null)
      setError(snapshot.errors.length ? snapshot.errors.join('\n') : null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => { void refresh(true) }, [refresh])
  useEffect(() => SkillAdapter.subscribe(() => void refresh(true)), [refresh])

  const visible = useMemo(() => SkillAdapter.search(items, query), [items, query])
  const selected = useMemo(() => items.find(item => item.path === selectedPath) ?? null, [items, selectedPath])
  const selectedBindings = useMemo(
    () => bindings.filter(binding => binding.skillPath === selectedPath),
    [bindings, selectedPath]
  )

  const openDetail = useCallback(async (skill: SkillRecord) => {
    setSelectedPath(skill.path)
    setDetail('读取中…')
    try { setDetail((await SkillAdapter.read(skill, cwd)).content) }
    catch (cause) { setDetail(''); setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [cwd])

  const addBinding = useCallback(async () => {
    if (!selected || !targetId.trim()) return
    try {
      await SkillAdapter.upsertBinding({
        targetType, targetId: targetId.trim(), skillName: selected.name, skillPath: selected.path,
        enabled: true, autoInvoke: true, priority: 0
      })
      setBindings(await SkillAdapter.listBindings())
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [selected, targetId, targetType])

  const toggle = useCallback(async (skill: SkillRecord) => {
    try {
      await SkillAdapter.setEnabled(skill, !skill.enabled)
      await refresh(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refresh])

  const install = useCallback(async () => {
    const value = source.trim()
    if (!value || installing) return
    setInstalling(true)
    setError(null)
    setNotice(null)
    try {
      const result = await SkillAdapter.install(value, cwd)
      setNotice(`已交给 Codex 原生 skill-installer 执行 · Thread ${result.threadId}`)
      setSource('')
      await refresh(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setInstalling(false)
    }
  }, [cwd, installing, refresh, source])

  return (
    <div className="h-full overflow-y-auto bg-(--ui-pane-background) p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xl font-semibold">Skills</div>
            <div className="mt-1 text-sm text-(--ui-text-secondary)">Codex Native Skills 是唯一事实源；Zero3 只提供管理、绑定和跨 Agent 调用界面。</div>
          </div>
          <button className="rounded-md border border-(--ui-border) px-3 py-1.5 text-sm hover:bg-(--ui-control-hover-background)" onClick={() => void refresh(true)} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
        </div>

        <section className="rounded-lg border border-(--ui-border) bg-background p-4">
          <div className="font-medium">安装 Skill（Codex 原生）</div>
          <div className="mt-1 text-xs text-(--ui-text-secondary)">输入 GitHub Skill URL、仓库路径或 Codex skill-installer 支持的来源。安装动作由 Codex 自带的 <code>skill-installer</code> 执行，Zero3 不复制安装逻辑。</div>
          <div className="mt-3 flex gap-2">
            <input className="min-w-0 flex-1 rounded-md border border-(--ui-border) bg-(--ui-pane-background) px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="https://github.com/.../tree/main/path/to/skill" value={source} onChange={event => setSource(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void install() }} />
            <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!source.trim() || installing} onClick={() => void install()}>{installing ? '安装中…' : '安装'}</button>
          </div>
          {notice && <div className="mt-2 text-xs text-emerald-500">{notice}</div>}
        </section>

        <input className="w-full rounded-md border border-(--ui-border) bg-background px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="搜索 Skill 名称、说明或路径" value={query} onChange={event => setQuery(event.target.value)} />
        {error && <pre className="whitespace-pre-wrap rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">{error}</pre>}

        <div className="space-y-2">
          {visible.map(skill => (
            <div key={skill.path} className="flex items-start justify-between gap-4 rounded-lg border border-(--ui-border) bg-background p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{skill.displayName || skill.name}</span><span className="rounded bg-(--ui-control-active-background) px-1.5 py-0.5 text-[10px] uppercase text-(--ui-text-secondary)">{skill.scope || 'unknown'}</span>{skill.pluginId && <span className="text-[10px] text-(--ui-text-tertiary)">{skill.pluginId}</span>}</div>
                <div className="mt-1 text-sm text-(--ui-text-secondary)">{skill.shortDescription || skill.description || '无说明'}</div>
                <div className="mt-2 truncate font-mono text-[11px] text-(--ui-text-tertiary)" title={skill.path}>{skill.path}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button className="rounded-md border border-(--ui-border) px-2 py-1.5 text-xs hover:bg-(--ui-control-hover-background)" onClick={() => void openDetail(skill)}>详情</button>
                <button className="rounded-md border border-(--ui-border) px-2 py-1.5 text-xs hover:bg-(--ui-control-hover-background)" onClick={() => void toggle(skill)}>{skill.enabled ? '停用' : '启用'}</button>
              </div>
            </div>
          ))}
          {!loading && !visible.length && <div className="rounded-lg border border-dashed border-(--ui-border) p-8 text-center text-sm text-(--ui-text-tertiary)">没有匹配的 Codex Skill</div>}
        </div>

        {selected && <section className="rounded-lg border border-(--ui-border) bg-background p-4">
          <div className="font-medium">Skill Detail / Binding</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)_auto]">
            <select className="rounded border border-(--ui-border) bg-(--ui-pane-background) px-2 py-1 text-sm" value={targetType} onChange={event => setTargetType(event.target.value as typeof targetType)}>
              <option value="agent">Agent</option><option value="workflow">Workflow</option><option value="task-template">Task Template</option>
            </select>
            <input className="rounded border border-(--ui-border) bg-(--ui-pane-background) px-2 py-1 text-sm" value={targetId} onChange={event => setTargetId(event.target.value)} placeholder="CODEX / workflow-id" />
            <button className="rounded bg-blue-600 px-3 py-1 text-sm text-white" onClick={() => void addBinding()}>添加自动绑定</button>
          </div>
          <div className="mt-3 space-y-1">{selectedBindings.map(binding => <div key={binding.bindingId} className="flex items-center justify-between rounded bg-(--ui-pane-background) px-2 py-1 text-xs"><span>{binding.targetType}:{binding.targetId} · P{binding.priority}</span><button onClick={() => void SkillAdapter.removeBinding(binding.bindingId).then(() => SkillAdapter.listBindings()).then(setBindings)}>删除</button></div>)}</div>
          <div className="mt-4 text-xs font-medium">SKILL.md（原文件只读）</div>
          <pre className="mt-2 max-h-[45vh] overflow-auto whitespace-pre-wrap rounded bg-(--ui-pane-background) p-3 text-xs">{detail || '点击详情读取'}</pre>
        </section>}
      </div>
    </div>
  )
}

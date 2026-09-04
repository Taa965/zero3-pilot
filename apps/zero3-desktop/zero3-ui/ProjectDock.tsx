import { useEffect, useMemo, useState } from 'react'

export const ZERO3_ACTIVE_PROJECT_CHANGED = 'zero3:active-project-changed'

type Project = {
  id: string
  name: string
  repositoryPath: string
  defaultWorktreePath: string | null
  defaultBranch: string | null
  baseRef: string | null
  contextSummary: string | null
  createdAt: string
  updatedAt: string
}

type ProjectBridge = {
  list(): Promise<Project[]>
  getActive(): Promise<Project | null>
  create(request: {
    id: string
    name: string
    repositoryPath: string
    defaultWorktreePath?: string | null
    defaultBranch?: string | null
    baseRef?: string | null
    contextSummary?: string | null
  }): Promise<Project>
  update(request: {
    id: string
    name?: string
    repositoryPath?: string
    defaultWorktreePath?: string | null
    defaultBranch?: string | null
    baseRef?: string | null
    contextSummary?: string | null
  }): Promise<Project>
  remove(request: { id: string }): Promise<{ removed: boolean; activeProjectId: string | null }>
  setActive(request: { id: string }): Promise<Project>
}

type ProjectWindow = Window & { zero3Projects?: ProjectBridge }

type Draft = {
  id: string
  name: string
  repositoryPath: string
  defaultWorktreePath: string
  defaultBranch: string
  baseRef: string
  contextSummary: string
}

const EMPTY: Draft = {
  id: '',
  name: '',
  repositoryPath: '',
  defaultWorktreePath: '',
  defaultBranch: '',
  baseRef: '',
  contextSummary: ''
}

function api(): ProjectBridge | null {
  return (window as ProjectWindow).zero3Projects ?? null
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function draftFrom(project: Project): Draft {
  return {
    id: project.id,
    name: project.name,
    repositoryPath: project.repositoryPath,
    defaultWorktreePath: project.defaultWorktreePath ?? '',
    defaultBranch: project.defaultBranch ?? '',
    baseRef: project.baseRef ?? '',
    contextSummary: project.contextSummary ?? ''
  }
}

function announce(project: Project | null) {
  window.dispatchEvent(new CustomEvent(ZERO3_ACTIVE_PROJECT_CHANGED, { detail: { project } }))
}

export function ProjectDock() {
  const bridge = useMemo(api, [])
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [active, setActive] = useState<Project | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(() => projects.find(project => project.id === selectedId) ?? null, [projects, selectedId])

  const refresh = async (preferredId?: string | null) => {
    if (!bridge) return
    const [list, current] = await Promise.all([bridge.list(), bridge.getActive()])
    setProjects(list)
    setActive(current)
    announce(current)
    const wanted = preferredId ?? selectedId
    const nextId = wanted && list.some(project => project.id === wanted) ? wanted : current?.id ?? list[0]?.id ?? ''
    setSelectedId(nextId)
    const next = list.find(project => project.id === nextId) ?? null
    if (next) {
      setDraft(draftFrom(next))
      setCreating(false)
    } else {
      setDraft(EMPTY)
      setCreating(true)
    }
  }

  useEffect(() => {
    if (!bridge) return
    void refresh().catch(reason => setError(errorMessage(reason)))
  }, [bridge])

  useEffect(() => {
    if (!open || !bridge) return
    void refresh().catch(reason => setError(errorMessage(reason)))
  }, [open])

  useEffect(() => {
    if (!selected || creating) return
    setDraft(draftFrom(selected))
  }, [selectedId])

  const startCreate = () => {
    setCreating(true)
    setSelectedId('')
    setDraft(EMPTY)
    setError(null)
  }

  const save = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError(null)
    try {
      const id = draft.id.trim() || slug(draft.name)
      if (!id) throw new Error('请输入项目名称或 Project ID。')
      const payload = {
        id,
        name: draft.name.trim(),
        repositoryPath: draft.repositoryPath.trim(),
        defaultWorktreePath: draft.defaultWorktreePath.trim() || null,
        defaultBranch: draft.defaultBranch.trim() || null,
        baseRef: draft.baseRef.trim() || null,
        contextSummary: draft.contextSummary.trim() || null
      }
      const project = creating ? await bridge.create(payload) : await bridge.update(payload)
      if (creating || !active) await bridge.setActive({ id: project.id })
      await refresh(project.id)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const activate = async () => {
    if (!bridge || !selected || busy) return
    setBusy(true)
    setError(null)
    try {
      const project = await bridge.setActive({ id: selected.id })
      setActive(project)
      announce(project)
      await refresh(project.id)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!bridge || !selected || busy) return
    if (!window.confirm(`确定删除项目“${selected.name}”的 Zero3 配置吗？不会删除本地仓库。`)) return
    setBusy(true)
    setError(null)
    try {
      await bridge.remove({ id: selected.id })
      await refresh(null)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  if (!bridge) return null

  return (
    <>
      <button
        aria-label="项目与工作区"
        className="project-rail-button"
        onClick={() => setOpen(true)}
        title={active ? `当前项目：${active.name}` : '项目与工作区'}
        type="button"
      >
        <span>▣</span>
        {active ? <i /> : null}
      </button>

      {open ? (
        <div className="project-backdrop" role="presentation">
          <section aria-modal="true" className="project-modal" role="dialog">
            <header className="project-head">
              <div>
                <h2>Project / Workspace</h2>
                <p>当前项目会自动注入 Codex、GPT、Gemini 和任务派发，不再手填 Project ID。</p>
              </div>
              <button aria-label="关闭" onClick={() => setOpen(false)} type="button">×</button>
            </header>

            <div className="project-layout">
              <aside className="project-list">
                <button className="project-new" onClick={startCreate} type="button">＋ 新建项目</button>
                {projects.map(project => (
                  <button
                    className={selectedId === project.id ? 'active' : ''}
                    key={project.id}
                    onClick={() => { setCreating(false); setSelectedId(project.id) }}
                    type="button"
                  >
                    <strong>{project.name}</strong>
                    <span>{project.id}</span>
                    {active?.id === project.id ? <em>当前</em> : null}
                  </button>
                ))}
              </aside>

              <div className="project-form">
                <div className="project-row">
                  <label><span>项目名称</span><input onChange={event => setDraft(current => ({ ...current, name: event.target.value, ...(creating && !current.id ? { id: slug(event.target.value) } : {}) }))} value={draft.name} /></label>
                  <label><span>Project ID</span><input disabled={!creating} onChange={event => setDraft(current => ({ ...current, id: event.target.value }))} value={draft.id} /></label>
                </div>
                <label><span>Repository Path</span><input onChange={event => setDraft(current => ({ ...current, repositoryPath: event.target.value }))} placeholder="C:\\workspace\\zero3-pilot" value={draft.repositoryPath} /></label>
                <label><span>默认独立 Worktree</span><input onChange={event => setDraft(current => ({ ...current, defaultWorktreePath: event.target.value }))} placeholder="C:\\workspace\\zero3-task-worktree（可留空）" value={draft.defaultWorktreePath} /></label>
                <div className="project-row">
                  <label><span>默认分支</span><input onChange={event => setDraft(current => ({ ...current, defaultBranch: event.target.value }))} placeholder="main" value={draft.defaultBranch} /></label>
                  <label><span>Base Ref / SHA</span><input onChange={event => setDraft(current => ({ ...current, baseRef: event.target.value }))} placeholder="可留空" value={draft.baseRef} /></label>
                </div>
                <label><span>项目上下文摘要</span><textarea onChange={event => setDraft(current => ({ ...current, contextSummary: event.target.value }))} placeholder="架构、约束、当前阶段、验收规则等" value={draft.contextSummary} /></label>

                {error ? <div className="project-error">{error}</div> : null}
                <footer className="project-actions">
                  {!creating && selected ? <button className="project-danger" disabled={busy} onClick={() => void remove()} type="button">删除配置</button> : null}
                  <span />
                  {!creating && selected && active?.id !== selected.id ? <button className="project-secondary" disabled={busy} onClick={() => void activate()} type="button">设为当前项目</button> : null}
                  <button className="project-primary" disabled={busy} onClick={() => void save()} type="button">{busy ? '保存中…' : creating ? '创建并启用' : '保存项目'}</button>
                </footer>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

import { useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'

interface ProjectScopeSwitcherProps {
  projects: Zero3ProjectRecord[]
  activeProjectId: string | null
  /** null selects the unscoped view, which lists every session. */
  onSelectScope: (projectId: string | null) => void
}

export function ProjectScopeSwitcher({ projects, activeProjectId, onSelectScope }: ProjectScopeSwitcherProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const activeProject = projects.find(project => project.id === activeProjectId) ?? null
  const label = activeProject?.name ?? '全部会话'

  const choose = (projectId: string | null) => {
    onSelectScope(projectId)
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative flex h-12 items-center px-2">
      <button
        onClick={() => setOpen(!open)}
        title={activeProject ? `当前项目：${activeProject.name}` : '未限定项目，列出全部会话'}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 font-medium hover:bg-(--ui-control-hover-background)"
      >
        <Codicon name={activeProject ? 'repo' : 'list-flat'} className="size-4 shrink-0 text-(--ui-text-secondary)" />
        <span className="truncate">{label}</span>
        <Codicon name="chevron-down" className="size-3.5 shrink-0 text-(--ui-text-tertiary)" />
      </button>

      {open && (
        <div className="absolute left-2 right-2 top-11 z-20 overflow-hidden rounded-lg border border-(--ui-border) bg-(--ui-pane-background) py-1 shadow-lg">
          <button
            onClick={() => choose(null)}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-(--ui-control-hover-background)',
              activeProjectId === null && 'bg-(--ui-control-active-background)'
            )}
          >
            <Codicon name="list-flat" className="size-4 shrink-0 text-(--ui-text-secondary)" />
            <span className="truncate">全部会话</span>
            {activeProjectId === null && <Codicon name="check" className="ml-auto size-3.5 shrink-0" />}
          </button>

          {projects.length > 0 && <div className="my-1 border-t border-(--ui-border)" />}

          {projects.map(project => (
            <button
              key={project.id}
              onClick={() => choose(project.id)}
              title={project.rootPath}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-(--ui-control-hover-background)',
                project.id === activeProjectId && 'bg-(--ui-control-active-background)'
              )}
            >
              <Codicon name="repo" className="size-4 shrink-0 text-(--ui-text-secondary)" />
              <span className="truncate">{project.name}</span>
              {project.id === activeProjectId && <Codicon name="check" className="ml-auto size-3.5 shrink-0" />}
            </button>
          ))}

          {projects.length === 0 && (
            <div className="px-3 py-2 text-xs text-(--ui-text-tertiary)">还没有项目，去「项目」模块新建</div>
          )}
        </div>
      )}
    </div>
  )
}

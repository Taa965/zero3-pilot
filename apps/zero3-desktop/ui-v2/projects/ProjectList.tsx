import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'

interface ProjectListProps {
  projects: Zero3ProjectRecord[]
  activeProjectId: string | null
  error: string | null
  onSelect: (project: Zero3ProjectRecord) => void
  onCreate: () => void
}

export function ProjectList({ projects, activeProjectId, error, onSelect, onCreate }: ProjectListProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-(--ui-border) p-3">
        <div className="flex items-center gap-2 text-sm font-medium"><Codicon name="repo" /> 项目</div>
        <button
          onClick={onCreate}
          title="选择目录并新建项目"
          className="flex size-7 items-center justify-center rounded-md border border-(--ui-border) hover:bg-(--ui-control-hover-background)"
        >
          <Codicon name="plus" className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {error && <div className="px-2 py-3 text-xs text-red-600">{error}</div>}
        {projects.map(project => (
          <button
            key={project.id}
            onClick={() => onSelect(project)}
            className={cn(
              'mb-2 w-full rounded-lg border p-3 text-left transition-colors',
              project.id === activeProjectId
                ? 'border-(--ui-border) bg-(--ui-control-active-background)'
                : 'border-transparent hover:bg-(--ui-control-hover-background)'
            )}
          >
            <div className="truncate text-sm font-medium">{project.name}</div>
            <div className="mt-2 flex items-center gap-2 truncate text-xs text-(--ui-text-tertiary)">
              <Codicon name="folder" className="size-3.5 shrink-0" />
              <span className="truncate" title={project.rootPath}>{project.rootPath}</span>
            </div>
          </button>
        ))}
        {!error && projects.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-(--ui-text-tertiary)">
            还没有项目，点击 ＋ 选择一个本地目录
          </div>
        )}
      </div>
    </div>
  )
}

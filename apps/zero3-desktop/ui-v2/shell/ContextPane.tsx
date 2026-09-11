import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import type { WorkspaceSession } from '../conversations/session-types'
import { UnifiedSessionList } from '../conversations/UnifiedSessionList'
import { TaskList } from '../tasks/TaskList'
import { DevelopmentGroupList } from '../development-groups/DevelopmentGroupList'
import { ProjectList } from '../projects/ProjectList'
import { ProjectScopeSwitcher } from './ProjectScopeSwitcher'
import { RuntimeList } from '../runtime/RuntimeList'
import type { RuntimeTarget } from '../runtime/runtime-types'

interface ContextPaneProps {
  activeModule: string
  sessions: WorkspaceSession[]
  activeSessionId: string | null
  activeProjectId: string | null
  focusedProjectId: string | null
  sessionError: string | null
  projects: Zero3ProjectRecord[]
  projectError: string | null
  onSelectSession: (session: WorkspaceSession) => void
  onSelectProjectContext: (projectId: string | null) => void
  onCreateSession: () => void
  onDeleteSession: (session: WorkspaceSession) => void
  onArchiveSession: (session: WorkspaceSession, archived: boolean) => void
  onRenameSession: (session: WorkspaceSession) => void
  onSelectProject: (project: Zero3ProjectRecord) => void
  onSelectProjectScope: (projectId: string | null) => void
  onCreateProject: () => void
  runtimeTarget: RuntimeTarget
  onSelectRuntimeTarget: (target: RuntimeTarget) => void
}

export function ContextPane({
  activeModule,
  sessions,
  activeSessionId,
  activeProjectId,
  focusedProjectId,
  sessionError,
  projects,
  projectError,
  onSelectSession,
  onSelectProjectContext,
  onCreateSession,
  onDeleteSession,
  onArchiveSession,
  onRenameSession,
  onSelectProject,
  onSelectProjectScope,
  onCreateProject,
  runtimeTarget,
  onSelectRuntimeTarget
}: ContextPaneProps) {
  const titles: Record<string, string> = {
    conversations: '工作台',
    tasks: '任务',
    groups: '开发组',
    projects: '项目',
    skills: 'Skills',
    runtime: '运行中心'
  }

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-(--ui-border) bg-(--ui-pane-background)">
      <div className="flex h-12 shrink-0 items-center border-b border-(--ui-border)">
        {activeModule === 'conversations' ? (
          <ProjectScopeSwitcher projects={projects} activeProjectId={activeProjectId} onSelectScope={onSelectProjectScope} />
        ) : (
          <div className="px-4 font-medium">{titles[activeModule] || activeModule}</div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeModule === 'conversations' ? (
          <UnifiedSessionList
            sessions={sessions}
            activeId={activeSessionId}
            activeProjectId={activeProjectId}
            focusedProjectId={focusedProjectId}
            projects={projects}
            onSelect={onSelectSession}
            onSelectProjectContext={onSelectProjectContext}
            onCreate={onCreateSession}
            onDelete={onDeleteSession}
            onArchive={onArchiveSession}
            onRename={onRenameSession}
            error={sessionError}
          />
        ) : activeModule === 'tasks' ? (
          <TaskList />
        ) : activeModule === 'groups' ? (
          <DevelopmentGroupList />
        ) : activeModule === 'projects' ? (
          <ProjectList
            projects={projects}
            activeProjectId={activeProjectId}
            error={projectError}
            onSelect={onSelectProject}
            onCreate={onCreateProject}
          />
        ) : activeModule === 'skills' ? (
          <div className="space-y-3 p-4 text-sm"><div className="font-medium">Codex Native Skills</div><div className="text-(--ui-text-secondary)">安装、发现、启停和执行都以 Codex 原生 Skill 系统为准。</div><div className="rounded-md border border-(--ui-border) bg-background p-3 text-xs text-(--ui-text-tertiary)">Zero3 不复制 SKILL.md，也不维护第二套 Skill Registry。</div></div>
        ) : activeModule === 'runtime' ? (
          <RuntimeList activeTarget={runtimeTarget} onTargetChange={onSelectRuntimeTarget} />
        ) : (
          <div className="p-4 text-sm text-(--ui-text-tertiary)">{titles[activeModule]} list will go here</div>
        )}
      </div>
    </div>
  )
}

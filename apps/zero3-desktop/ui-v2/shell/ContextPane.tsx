import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import type { WebSession } from '../adapters/WebWorkspaceAdapter'
import { UnifiedSessionList } from '../conversations/UnifiedSessionList'
import { TaskList } from '../tasks/TaskList'
import { DevelopmentGroupList } from '../development-groups/DevelopmentGroupList'
import { ProjectList } from '../projects/ProjectList'
import { ProjectScopeSwitcher } from './ProjectScopeSwitcher'
import { RuntimeList } from '../runtime/RuntimeList'

interface ContextPaneProps {
  activeModule: string
  sessions: WebSession[]
  activeSessionId: string | null
  activeProjectId: string | null
  sessionError: string | null
  projects: Zero3ProjectRecord[]
  projectError: string | null
  onSelectSession: (session: WebSession) => void
  onCreateGptSession: () => void
  onDeleteSession: (session: WebSession) => void
  onSelectProject: (project: Zero3ProjectRecord) => void
  onSelectProjectScope: (projectId: string | null) => void
  onCreateProject: () => void
}

export function ContextPane({
  activeModule,
  sessions,
  activeSessionId,
  activeProjectId,
  sessionError,
  projects,
  projectError,
  onSelectSession,
  onCreateGptSession,
  onDeleteSession,
  onSelectProject,
  onSelectProjectScope,
  onCreateProject
}: ContextPaneProps) {
  const titles: Record<string, string> = {
    conversations: '工作台',
    tasks: '任务',
    groups: '开发组',
    projects: '项目',
    runtime: '运行中心'
  }

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-(--ui-border) bg-(--ui-pane-background)">
      <div className="flex h-12 shrink-0 items-center border-b border-(--ui-border)">
        {activeModule === 'conversations' ? (
          <ProjectScopeSwitcher
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectScope={onSelectProjectScope}
          />
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
            projects={projects}
            onSelect={onSelectSession}
            onCreateGpt={onCreateGptSession}
            onDelete={onDeleteSession}
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
        ) : activeModule === 'runtime' ? (
          <RuntimeList />
        ) : (
          <div className="p-4 text-sm text-(--ui-text-tertiary)">{titles[activeModule]} list will go here</div>
        )}
      </div>
    </div>
  )
}

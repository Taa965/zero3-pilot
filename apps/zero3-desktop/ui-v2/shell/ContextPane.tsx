import { UnifiedSessionList } from '../conversations/UnifiedSessionList'
import { TaskList } from '../tasks/TaskList'
import { DevelopmentGroupList } from '../development-groups/DevelopmentGroupList'
import { ProjectList } from '../projects/ProjectList'
import { RuntimeList } from '../runtime/RuntimeList'

interface ContextPaneProps {
  activeModule: string
}

export function ContextPane({ activeModule }: ContextPaneProps) {
  const titles: Record<string, string> = {
    conversations: '工作台',
    tasks: '任务',
    groups: '开发组',
    projects: '项目',
    runtime: '运行中心',
  }

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-(--ui-border) bg-(--ui-pane-background)">
      <div className="flex h-12 items-center px-4 font-medium border-b border-(--ui-border)">
        {titles[activeModule] || activeModule}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {activeModule === 'conversations' ? (
          <UnifiedSessionList />
        ) : activeModule === 'tasks' ? (
          <TaskList />
        ) : activeModule === 'groups' ? (
          <DevelopmentGroupList />
        ) : activeModule === 'projects' ? (
          <ProjectList />
        ) : activeModule === 'runtime' ? (
          <RuntimeList />
        ) : (
          <div className="p-4 text-sm text-(--ui-text-tertiary)">
            {titles[activeModule]} list will go here
          </div>
        )}
      </div>
    </div>
  )
}

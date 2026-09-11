import { Codicon } from '@/components/ui/codicon'

import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { GptWebSurface } from '../conversations/GptWebSurface'
import { GeminiWebSurface } from '../conversations/GeminiWebSurface'
import { LocalConversationSurface } from '../conversations/LocalConversationSurface'
import { Zero3NativeConversationSurface } from '../conversations/Zero3NativeConversationSurface'
import type { LocalSessionRecord, WorkspaceProvider, WorkspaceSession } from '../conversations/session-types'
import { TaskWorkspace } from '../tasks/TaskWorkspace'
import { DevelopmentGroupWorkspace } from '../development-groups/DevelopmentGroupWorkspace'
import { ProjectWorkspace } from '../projects/ProjectWorkspace'
import { SkillWorkspace } from '../skills/SkillWorkspace'
import { RuntimeWorkspace } from '../runtime/RuntimeWorkspace'
import type { RuntimeTarget } from '../runtime/runtime-types'

interface WorkspaceRouterProps {
  activeModule: string
  provider: WorkspaceProvider
  onProviderChange: (provider: WorkspaceProvider) => void
  activeSession: WorkspaceSession | null
  activeLocalSession: LocalSessionRecord | null
  activeProject: Zero3ProjectRecord | null
  activeProjectSessionCount: number
  onLocalSessionChanged: () => void
  onLocalSessionExecutionChange: (sessionId: string, executing: boolean) => void
  onBindChatGptProject: (project: Zero3ProjectRecord) => void
  onUnbindChatGptProject: (project: Zero3ProjectRecord) => void
  onOpenPowerShell: () => void
  onToggleInspector: () => void
  runtimeTarget: RuntimeTarget
}

const PROVIDERS: Array<{ id: WorkspaceProvider; label: string }> = [
  { id: 'gpt', label: 'GPT' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'workbuddy', label: 'WorkBuddy' },
  { id: 'zero3', label: 'Zero3' }
]

export function WorkspaceRouter({
  activeModule,
  provider,
  onProviderChange,
  activeSession,
  activeLocalSession,
  activeProject,
  activeProjectSessionCount,
  onLocalSessionChanged,
  onLocalSessionExecutionChange,
  onBindChatGptProject,
  onUnbindChatGptProject,
  onOpenPowerShell,
  onToggleInspector,
  runtimeTarget
}: WorkspaceRouterProps) {
  const webEntryId = activeSession?.source === 'web' && activeSession.provider === provider ? activeSession.id : null
  const localSession = activeLocalSession?.provider === provider ? activeLocalSession : null

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-(--ui-border) px-4">
        <div className="flex items-center gap-4">
          <div className="font-medium">主工作区</div>
          {activeModule === 'conversations' && (
            <div className="flex flex-wrap gap-1 text-xs">
              {PROVIDERS.map(item => (
                <button
                  key={item.id}
                  onClick={() => onProviderChange(item.id)}
                  className={`rounded px-2 py-1 ${provider === item.id ? 'bg-(--ui-control-active-background)' : 'hover:bg-(--ui-control-hover-background)'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label="打开 PowerShell"
            className="grid size-8 place-items-center rounded border border-(--ui-border) text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!activeProject}
            onClick={onOpenPowerShell}
            title={activeProject ? `在 ${activeProject.rootPath} 打开 PowerShell` : '请先选择项目'}
            type="button"
          >
            <Codicon name="terminal-powershell" size={18} />
          </button>
          <button onClick={onToggleInspector} className="text-sm text-blue-500 hover:underline">
            显示/隐藏属性面板
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeModule === 'conversations' ? (
          provider === 'gpt' ? <GptWebSurface entryId={webEntryId} /> :
          provider === 'gemini' ? <GeminiWebSurface entryId={webEntryId} /> :
          provider === 'zero3' ? <Zero3NativeConversationSurface
            session={localSession}
            project={activeProject}
            onChanged={onLocalSessionChanged}
            onExecutionChange={onLocalSessionExecutionChange}
          /> :
          <LocalConversationSurface
            provider={provider}
            session={localSession}
            project={activeProject}
            onChanged={onLocalSessionChanged}
            onExecutionChange={onLocalSessionExecutionChange}
          />
        ) : activeModule === 'tasks' ? (
          <TaskWorkspace project={activeProject} />
        ) : activeModule === 'groups' ? (
          <DevelopmentGroupWorkspace />
        ) : activeModule === 'projects' ? (
          <ProjectWorkspace
            project={activeProject}
            sessionCount={activeProjectSessionCount}
            onBindChatGptProject={onBindChatGptProject}
            onUnbindChatGptProject={onUnbindChatGptProject}
          />
        ) : activeModule === 'skills' ? (
          <SkillWorkspace cwd={activeProject?.rootPath ?? null} />
        ) : activeModule === 'runtime' ? (
          <RuntimeWorkspace target={runtimeTarget} />
        ) : (
          <div className="flex h-full items-center justify-center text-(--ui-text-tertiary)">{activeModule} 模块暂无对应视图</div>
        )}
      </div>
    </div>
  )
}

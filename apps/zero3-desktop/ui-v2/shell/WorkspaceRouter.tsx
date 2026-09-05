import { useState } from 'react'
import { CodexConversationSurface } from '../conversations/CodexConversationSurface'
import { GptWebSurface } from '../conversations/GptWebSurface'
import { GeminiWorkspaceSurface } from '../conversations/GeminiWorkspaceSurface'
import { TaskWorkspace } from '../tasks/TaskWorkspace'
import { DevelopmentGroupWorkspace } from '../development-groups/DevelopmentGroupWorkspace'
import { ProjectWorkspace } from '../projects/ProjectWorkspace'
import { RuntimeWorkspace } from '../runtime/RuntimeWorkspace'

interface WorkspaceRouterProps {
  activeModule: string
  onToggleInspector: () => void
}

export function WorkspaceRouter({ activeModule, onToggleInspector }: WorkspaceRouterProps) {
  // Mock state to toggle between surfaces for demonstration
  const [activeProvider, setActiveProvider] = useState<'codex' | 'gpt' | 'gemini'>('codex')

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-(--ui-border) px-4">
        <div className="flex items-center gap-4">
          <div className="font-medium">主工作区</div>
          {activeModule === 'conversations' && (
            <div className="flex gap-2 text-xs">
              {(['codex', 'gpt', 'gemini'] as const).map(p => (
                <button 
                  key={p} 
                  onClick={() => setActiveProvider(p)}
                  className={`px-2 py-1 rounded ${activeProvider === p ? 'bg-(--ui-control-active-background)' : 'hover:bg-(--ui-control-hover-background)'}`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={onToggleInspector} className="text-sm text-blue-500 hover:underline">
          显示/隐藏属性面板
        </button>
      </div>
      <div className="flex-1 overflow-hidden min-h-0">
        {activeModule === 'conversations' ? (
          activeProvider === 'codex' ? <CodexConversationSurface /> :
          activeProvider === 'gpt' ? <GptWebSurface /> :
          <GeminiWorkspaceSurface />
        ) : activeModule === 'tasks' ? (
          <TaskWorkspace />
        ) : activeModule === 'groups' ? (
          <DevelopmentGroupWorkspace />
        ) : activeModule === 'projects' ? (
          <ProjectWorkspace />
        ) : activeModule === 'runtime' ? (
          <RuntimeWorkspace />
        ) : (
          <div className="flex h-full items-center justify-center text-(--ui-text-tertiary)">
            {activeModule} 模块暂无对应视图
          </div>
        )}
      </div>
    </div>
  )
}

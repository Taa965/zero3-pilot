import { useState } from 'react'

import type { Zero3ProjectRecord } from '../adapters/ProjectAdapter'
import { McpHttpAccessCard } from './McpHttpAccessCard'
import { SharedMemoryCard } from './SharedMemoryCard'
import { ProjectLinksCard } from './ProjectLinkDialog'

interface ProjectWorkspaceProps {
  project: Zero3ProjectRecord | null
  sessionCount: number
  onBindChatGptProject: (project: Zero3ProjectRecord) => void
  onUnbindChatGptProject: (project: Zero3ProjectRecord) => void
}

export function ProjectWorkspace({
  project,
  sessionCount,
  onBindChatGptProject,
  onUnbindChatGptProject
}: ProjectWorkspaceProps) {
  const [activeTab, setActiveTab] = useState('overview')
  const tabs = [
    { id: 'overview', label: '总览' }, { id: 'files', label: '文件' }, { id: 'git', label: 'Git' },
    { id: 'worktrees', label: '工作区' }, { id: 'context', label: '上下文' }, { id: 'tasks', label: '任务' }, { id: 'artifacts', label: '产物' }
  ]
  if (!project) return <div className="flex h-full items-center justify-center bg-(--ui-pane-background) text-sm text-(--ui-text-tertiary)">请选择或新建一个项目</div>
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-14 shrink-0 flex-col justify-center border-b border-(--ui-border) px-6">
        <div className="flex min-w-0 items-center gap-3"><div className="shrink-0 text-lg font-medium">{project.name}</div><div className="truncate text-xs text-(--ui-text-tertiary)" title={project.rootPath}>{project.rootPath}</div></div>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-6 overflow-x-auto border-b border-(--ui-border) px-6 text-sm font-medium">
        {tabs.map(tab => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`h-full whitespace-nowrap border-b-2 transition-colors ${activeTab === tab.id ? 'border-blue-500 text-foreground' : 'border-transparent text-(--ui-text-secondary) hover:border-(--ui-border) hover:text-foreground'}`}>{tab.label}</button>)}
      </div>
      <div className="flex-1 overflow-y-auto bg-(--ui-pane-background) p-6">
        {activeTab === 'overview' && <div className="grid max-w-3xl gap-4 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-(--ui-border) bg-background p-4"><div className="text-xs text-(--ui-text-tertiary)">本地目录</div><div className="mt-2 break-all font-medium">{project.rootPath}</div></div>
          <div className="rounded-lg border border-(--ui-border) bg-background p-4"><div className="text-xs text-(--ui-text-tertiary)">归属会话</div><div className="mt-2 text-2xl font-semibold">{sessionCount}</div></div>
          <div className="rounded-lg border border-(--ui-border) bg-background p-4 sm:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-(--ui-text-tertiary)">关联的 ChatGPT 项目</div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                <button onClick={() => onBindChatGptProject(project)} className="rounded-md border border-(--ui-border) px-2 py-1 hover:bg-(--ui-control-hover-background)">{project.chatGptProjectUrl ? '更换' : '关联'}</button>
                {project.chatGptProjectUrl && <button onClick={() => onUnbindChatGptProject(project)} className="rounded-md border border-(--ui-border) px-2 py-1 hover:bg-(--ui-control-hover-background)">解除</button>}
              </div>
            </div>
            {/* Bound: every new GPT web session in this project opens on that
                project page, so ChatGPT files the conversation there itself. */}
            <div className="mt-2 break-all">{project.chatGptProjectUrl ?? <span className="text-(--ui-text-tertiary)">尚未关联，新建 GPT 网页会话时会先询问</span>}</div>
          </div>
          <McpHttpAccessCard projectId={project.id} />
          <ProjectLinksCard key={project.id} project={project} />
        </div>}
        {activeTab === 'files' && <div className="text-sm text-(--ui-text-secondary)">文件树视图建设中...</div>}
        {activeTab === 'context' && <SharedMemoryCard key={project.id} projectId={project.id} />}
        {!['overview', 'files', 'context'].includes(activeTab) && <div className="text-sm text-(--ui-text-secondary)">{tabs.find(tab => tab.id === activeTab)?.label}视图建设中...</div>}
      </div>
    </div>
  )
}
